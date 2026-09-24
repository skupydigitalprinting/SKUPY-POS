import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fixture, as, actors, book, customer, id, snapshot } from './invoice-lifecycle-fixture.js'

const product = id(920), operation = id(921)
const draft = patch => ({ bookId: book, customerId: customer, customerName: 'Synthetic custom order',
  items: [{ productId: product, name: 'Custom shirt', qty: 2, price: 100000, unit: 'pcs' }],
  discount: 0, paid: 50000, method: 'transfer', dueDate: '2026-10-01', notes: '', ...patch })
async function setup(t) {
  const db = await fixture(t, { paid: 0 })
  await db.query("INSERT INTO products(id,name,price,stock,unit) VALUES ($1,'Custom shirt',100000,0,'pcs')", [product])
  await db.exec(await readFile(new URL('../../supabase/security-stage2/013_atomic_checkout.sql', import.meta.url), 'utf8'))
  return db
}
const submit = async (db, request = draft(), op = operation, actor = 'cashier', role = 'authenticated') =>
  (await as(db, actor, 'SELECT pos_checkout($1,$2) result', [op, request], role))[0].result

test('abandon fences delayed checkout and never cancels an already committed invoice', async t => {
  const db = await setup(t)
  const stop = op => as(db, 'cashier', 'SELECT pos_abandon_checkout($1,$2) result', [op, book])
  const cancelled = (await stop(operation))[0].result
  assert.equal(cancelled.state, 'abandoned')
  assert.deepEqual(await submit(db), cancelled)
  assert.equal((await db.query('SELECT count(*)::int n FROM transactions')).rows[0].n, 1)
  const committed = await submit(db, draft(), id(960))
  assert.deepEqual((await stop(id(960)))[0].result, committed)
  await assert.rejects(as(db, 'owner', 'SELECT pos_abandon_checkout($1,$2)', [operation, book]), { code: '42501' })
})

test('checkout commits one invoice, DP, debt and customer totals, without requiring stocked goods', async t => {
  const db = await setup(t), result = await submit(db)
  assert.equal(result.state, 'complete')
  assert.equal(result.operationId, operation)
  assert.deepEqual(result.request, draft())
  assert.equal(result.result.total, 200000)
  assert.equal(result.result.paid, 50000)
  assert.equal(result.result.remaining, 150000)
  assert.equal(result.result.cashier_id, actors.cashier.admin)
  const debts = (await db.query('SELECT * FROM debts WHERE transaction_id=$1', [result.result.id])).rows
  assert.equal(debts.length, 1)
  assert.equal(Number(debts[0].paid), 50000)
  assert.equal(Number(debts[0].remaining), 150000)
  assert.equal(Number((await db.query('SELECT stock FROM products WHERE id=$1', [product])).rows[0].stock), 0)
  assert.equal(Number((await db.query('SELECT total_spent FROM customers WHERE id=$1', [customer])).rows[0].total_spent), 700000)
  assert.deepEqual(await submit(db), result)
  assert.deepEqual((await as(db, 'cashier', 'SELECT pos_checkout_status($1) result', [operation]))[0].result, result)
  assert.equal((await db.query('SELECT count(*)::int n FROM transactions')).rows[0].n, 2)
  const payment = (await as(db, 'cashier', 'SELECT pos_record_payment($1,$2,150000,\'cash\',\'Settlement\') result', [id(922), result.result.invoice_no]))[0].result
  assert.equal(payment.remaining, 0)
})

test('checkout rejects changed replay, impersonation, unknown fields and unauthorized book/customer before money writes', async t => {
  const db = await setup(t)
  await submit(db)
  const before = await snapshot(db)
  for (const [request, op, actor, role, code] of [
    [draft({ paid: 60000 }), operation, 'cashier', 'authenticated', '22023'],
    [draft(), operation, 'owner', 'authenticated', '42501'],
    [draft({ cashierId: actors.owner.admin }), id(930), 'cashier', 'authenticated', '22023'],
    [draft(), id(930), 'foreign', 'authenticated', '42501'],
    [draft(), id(930), 'inactive', 'authenticated', '42501'],
    [draft(), id(930), 'cashier', 'anon', '42501'],
    [draft({ bookId: id(999) }), id(930), 'cashier', 'authenticated', '42501'],
    [draft({ customerId: null }), id(930), 'cashier', 'authenticated', '22023'],
    [draft({ paid: 250000 }), id(930), 'cashier', 'authenticated', '22023'],
    [draft({ method: 'hutang' }), id(930), 'cashier', 'authenticated', '22023'],
  ]) await assert.rejects(submit(db, request, op, actor, role), { code })
  assert.deepEqual(await snapshot(db), before)
})

test('checkout paid anonymous order and decimal quantities use canonical rupiah rounding', async t => {
  const db = await setup(t)
  const request = draft({ customerId: null, dueDate: null, items: [{ productId: product, name: 'Custom print', qty: 1.25, price: 10001, unit: 'meter' }], paid: 12501 })
  const result = await submit(db, request)
  assert.equal(result.result.total, 12501)
  assert.equal(result.result.remaining, 0)
  assert.equal(result.result.status, 'lunas')
  assert.equal((await db.query('SELECT count(*)::int n FROM debts WHERE transaction_id=$1', [result.result.id])).rows[0].n, 0)
})

test('checkout snapshots the server-owned default bank and counts no cancelled sales', async t => {
  const db = await setup(t)
  await db.query("INSERT INTO admin_bank_accounts(admin_id,bank_name,account_number,account_holder,is_default) VALUES ($1,'Synthetic Bank','TEST-ACCOUNT','Synthetic Holder',true)", [actors.cashier.admin])
  await db.exec("INSERT INTO transactions(invoice_no,total,customer_id,order_status) SELECT 'CANCELLED-TEST',100,customer_id,'cancelled' FROM transactions LIMIT 1")
  const result = await submit(db)
  assert.equal(result.result.bank_name, 'Synthetic Bank')
  assert.equal(result.result.bank_account_number, 'TEST-ACCOUNT')
  assert.equal(Number((await db.query('SELECT total_spent FROM customers WHERE id=$1', [customer])).rows[0].total_spent), 700000)
})

for (const table of ['transactions', 'debts', 'cash_movements', 'accounting_entries', 'pos_security.checkout_operations', 'pos_security.payment_baselines']) {
  test(`checkout rolls back all effects when ${table} silently discards its write`, async t => {
    const db = await setup(t), before = await snapshot(db)
    await db.exec(`CREATE FUNCTION public.test_suppress() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
      CREATE TRIGGER test_suppress BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION public.test_suppress();`)
    await assert.rejects(submit(db))
    assert.deepEqual(await snapshot(db), before)
    assert.equal((await db.query('SELECT count(*)::int n FROM pos_security.checkout_operations')).rows[0].n, 0)
  })
}

test('checkout status never discloses another actor operation and direct inserts are fenced', async t => {
  const db = await setup(t)
  await submit(db)
  assert.deepEqual((await as(db, 'owner', 'SELECT pos_checkout_status($1) result', [operation]))[0].result, { state: 'unknown' })
  await db.query('DELETE FROM admin_book_access WHERE admin_id=$1', [actors.cashier.admin])
  await assert.rejects(as(db, 'cashier', 'SELECT pos_checkout_status($1)', [operation]), { code: '42501' })
  await assert.rejects(as(db, 'owner', "INSERT INTO transactions(invoice_no) VALUES ('BYPASS')"), { code: '42501' })
})
