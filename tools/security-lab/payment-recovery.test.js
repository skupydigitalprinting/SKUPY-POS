import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fixture, as, actors, id, change } from './invoice-lifecycle-fixture.js'
import { webcrypto } from 'node:crypto'
import { createPaymentClient } from '../../src/lib/paymentClient.js'

const op = id(801)
async function setup(t) {
  const db = await fixture(t, { paid: 0 })
  const file = new URL('../../supabase/security-stage2/012_payment_recovery.sql', import.meta.url)
  await db.exec(await readFile(file, 'utf8'))
  return db
}
const submit = (db, actor = 'cashier', amount = 100000) => as(db, actor,
  "SELECT pos_submit_payment($1,'INV-LIFE',$2,'transfer','Synthetic payment') value", [op, amount])
const status = (db, actor = 'cashier', operation = op, role = 'authenticated') => as(db, actor,
  'SELECT pos_payment_status($1) value', [operation], role)

test('lost payment response can be reconciled and replayed without duplicating money', async t => {
  const db = await setup(t)
  const first = (await submit(db))[0].value
  assert.equal(first.state, 'complete')
  assert.equal(first.operationId, op)
  assert.deepEqual(first.request, { invoiceNo: 'INV-LIFE', amount: 100000, method: 'transfer', notes: 'Synthetic payment' })
  assert.deepEqual(first.result, { invoice_no: 'INV-LIFE', amount: 100000, paid: 100000, remaining: 400000, status: 'aktif' })
  assert.deepEqual((await status(db))[0].value, first)
  assert.deepEqual((await submit(db))[0].value, first)
  assert.equal((await db.query('SELECT count(*)::int n FROM debt_payments')).rows[0].n, 1)
  await assert.rejects(submit(db, 'cashier', 200000), { code: '22023' })
})

test('status denies anonymous and inactive sessions and hides operations from other actors', async t => {
  const db = await setup(t)
  await submit(db)
  assert.deepEqual((await status(db, 'foreign'))[0].value, { state: 'unknown' })
  assert.deepEqual((await status(db, 'owner'))[0].value, { state: 'unknown' })
  assert.deepEqual((await status(db, 'cashier', id(899)))[0].value, { state: 'unknown' })
  await assert.rejects(status(db, 'cashier', op, 'anon'), { code: '42501' })
  await assert.rejects(status(db, 'inactive'), { code: '42501' })
  await db.query('UPDATE pos_security.user_access SET active=false WHERE auth_user_id=$1', [actors.cashier.auth])
  await assert.rejects(status(db), { code: '42501' })
})

test('confirmed payment remains recoverable after invoice cancellation but not after book revocation', async t => {
  const db = await setup(t)
  const saved = (await submit(db))[0].value
  await change(db, { version: 1, kind: 'cancel', payload: { reason: 'Synthetic cancelled order' } })
  assert.deepEqual((await status(db))[0].value, saved)
  await db.query('DELETE FROM admin_book_access WHERE admin_id=$1', [actors.cashier.admin])
  await assert.rejects(status(db), { code: '42501' })
})

test('lost real SQL response reconciles through browser client after reload', async t => {
  const db = await setup(t)
  const memory = () => { const map = new Map(); return { get length() { return map.size }, key: i => [...map.keys()][i],
    getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, v), removeItem: k => map.delete(k) } }
  const storage = memory(), draftStorage = memory(), calls = []
  let lose = true
  const rpc = async (name, args) => {
    calls.push(name)
    let rows
    try {
      rows = name === 'pos_payment_status'
        ? await as(db, 'cashier', 'SELECT pos_payment_status($1) value', [args.p_operation_id])
        : await as(db, 'cashier', 'SELECT pos_submit_payment($1,$2,$3,$4,$5) value',
          [args.p_operation_id, args.p_invoice_no, args.p_amount, args.p_method, args.p_notes])
    } catch (error) { return { data: null, error: { code: error.code } } }
    if (lose && name === 'pos_submit_payment') { lose = false; throw new Error('Synthetic lost response') }
    return { data: rows[0].value, error: null }
  }
  const make = () => createPaymentClient({ client: { rpc }, actorId: actors.cashier.auth, scope: 'isolated',
    isCurrent: () => true, storage, draftStorage, crypto: webcrypto, locks: { request: async (key, options, run) => run({ name: key }) } })
  assert.equal((await make().submit({ invoiceNo: 'INV-LIFE', amount: 100000, method: 'cash', notes: '' })).needsReconciliation, true)
  const result = await make().reconcile('INV-LIFE')
  assert.equal(result.ok, true)
  assert.equal(result.data.paid, 100000)
  assert.deepEqual(calls, ['pos_submit_payment', 'pos_payment_status'])
  assert.equal((await db.query('SELECT count(*)::int n FROM debt_payments')).rows[0].n, 1)
})

test('suppressed recovery receipt aborts the payment and all its financial effects', async t => {
  const db = await setup(t)
  const tables = ['transactions', 'debts', 'debt_payments', 'accounting_entries', 'cash_movements', 'customers',
    'pos_security.payment_operations', 'pos_security.payment_events', 'pos_security.payment_client_receipts']
  const snapshots = async () => {
    const values = {}
    for (const table of tables) values[table] = (await db.query(`SELECT to_jsonb(t) value FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows
    return values
  }
  await db.exec(`CREATE FUNCTION public.synthetic_suppress_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
    CREATE TRIGGER synthetic_suppress BEFORE INSERT ON pos_security.payment_client_receipts
    FOR EACH ROW EXECUTE FUNCTION public.synthetic_suppress_receipt();`)
  const before = await snapshots()
  await assert.rejects(submit(db), { code: '23514' })
  assert.deepEqual(await snapshots(), before)
})
