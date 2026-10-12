import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fixture, as, book, customer, id, snapshot } from './invoice-lifecycle-fixture.js'

const migration = new URL('../../supabase/security-stage2/015_daily_invoice_numbers.sql', import.meta.url)
const product = id(920)
const request = { bookId: book, customerId: customer, customerName: 'Synthetic daily invoice',
  items: [{ productId: product, name: 'Custom shirt', qty: 2, price: 100000, unit: 'pcs' }],
  discount: 0, paid: 0, method: 'hutang', dueDate: '2026-12-01', notes: '' }
async function setup(t) {
  const db = await fixture(t, { paid: 0 })
  await db.exec(await readFile(new URL('../../supabase/security-stage2/013_atomic_checkout.sql', import.meta.url), 'utf8'))
  await db.query("INSERT INTO products(id,name,price,stock,unit) VALUES ($1,'Custom shirt',100000,0,'pcs')", [product])
  const before = await snapshot(db)
  await db.exec(await readFile(migration, 'utf8'))
  assert.deepEqual(await snapshot(db), before)
  return db
}
const submit = async (db, operation) => (await as(db, 'cashier', 'SELECT pos_checkout($1,$2) result', [id(operation), request]))[0].result

test('daily invoice uses a WIB sequence, preserves old invoices and replays the same receipt', async t => {
  const db = await setup(t)
  const old = (await db.query('SELECT to_jsonb(t) row FROM transactions t')).rows
  const day = (await db.query("SELECT to_char(clock_timestamp() AT TIME ZONE 'Asia/Jakarta','YYYYMMDD') AS invoice_day")).rows[0].invoice_day
  const first = await submit(db, 930)
  assert.equal(first.result.invoice_no, `SKP-INV-${day}-0001`)
  assert.deepEqual(await submit(db, 930), first)
  assert.equal((await submit(db, 931)).result.invoice_no, `SKP-INV-${day}-0002`)
  assert.deepEqual((await db.query("SELECT to_jsonb(t) row FROM transactions t WHERE invoice_no='INV-LIFE'")).rows, old)
})

test('daily allocation switches at midnight WIB and does not truncate after 9999', async t => {
  const db = await setup(t)
  const next = async at => (await db.query('SELECT pos_security.next_invoice_number($1::timestamptz) n', [at])).rows[0].n
  await db.exec("SET TIME ZONE 'America/New_York'")
  assert.equal(await next('2040-10-12T16:59:59Z'), 'SKP-INV-20401012-0001')
  assert.equal(await next('2040-10-12T17:00:00Z'), 'SKP-INV-20401013-0001')
  assert.equal(await next('2040-10-12T17:00:01Z'), 'SKP-INV-20401013-0002')
  await db.exec("UPDATE pos_security.invoice_daily_counters SET last_number=9999 WHERE invoice_day='2040-10-13'")
  assert.equal(await next('2040-10-12T17:00:02Z'), 'SKP-INV-20401013-10000')
})

test('migration and repeat application preserve historical financial rows; seed counts cancelled invoices', async t => {
  const db = await setup(t)
  await db.exec("INSERT INTO transactions(invoice_no,total,created_at,deleted_at) VALUES ('LEGACY-ONE',0,'2040-10-14T01:00:00Z',now()),('SKP-INV-20401014-0012',0,'2040-10-14T01:00:00Z',now())")
  const before = await snapshot(db)
  await db.exec(await readFile(migration, 'utf8'))
  assert.deepEqual(await snapshot(db), before)
  assert.equal((await db.query("SELECT pos_security.next_invoice_number('2040-10-14T02:00:00Z') n")).rows[0].n, 'SKP-INV-20401014-0013')
})

test('deleted invoices do not free numbers and denied checkout does not allocate', async t => {
  const db = await setup(t)
  const first = await submit(db, 940)
  await as(db, 'cashier', 'SELECT pos_apply_invoice_change($1,$2,0,\'cancel\',$3)',
    [id(941), first.result.id, { reason: 'Synthetic cancellation' }])
  const next = await submit(db, 942)
  assert.equal(Number(next.result.invoice_no.split('-').at(-1)), Number(first.result.invoice_no.split('-').at(-1)) + 1)
  const before = (await db.query('SELECT * FROM pos_security.invoice_daily_counters')).rows
  await assert.rejects(as(db, 'foreign', 'SELECT pos_checkout($1,$2)', [id(943), request]), { code: '42501' })
  assert.deepEqual((await db.query('SELECT * FROM pos_security.invoice_daily_counters')).rows, before)
})

test('untrusted roles cannot allocate or reset numbers and duplicate invoice numbers are rejected', async t => {
  const db = await setup(t)
  for (const role of ['anon', 'authenticated', 'service_role']) {
    await assert.rejects(as(db, 'cashier', 'SELECT pos_security.next_invoice_number(now())', [], role), { code: '42501' })
    await assert.rejects(as(db, 'cashier', 'DELETE FROM pos_security.invoice_daily_counters', [], role), { code: '42501' })
  }
  const first = await submit(db, 950)
  // Isolate the unique constraint from the synthetic fixture's binding triggers.
  await assert.rejects(db.transaction(async tx => {
    await tx.exec("SET LOCAL session_replication_role='replica'")
    await tx.query('INSERT INTO transactions(invoice_no,total) VALUES($1,0)', [first.result.invoice_no])
  }), { code: '23505' })
})

test('first daily counter includes previously issued long-format invoices even if deleted', async t => {
  const db = await setup(t)
  await db.exec("INSERT INTO transactions(invoice_no,total,created_at,deleted_at) VALUES ('OLD-LONG-ONE',0,'2040-10-15T01:00:00Z',null),('OLD-LONG-TWO',0,'2040-10-15T02:00:00Z',now())")
  assert.equal((await db.query("SELECT pos_security.next_invoice_number('2040-10-15T03:00:00Z') n")).rows[0].n, 'SKP-INV-20401015-0003')
})

test('failed checkout rolls back allocation together with the invoice', async t => {
  const db = await setup(t)
  await db.exec(`CREATE FUNCTION public.reject_test_checkout() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'synthetic failure after numbering'; END $$;
    CREATE TRIGGER reject_test_checkout BEFORE INSERT ON transactions FOR EACH ROW EXECUTE FUNCTION public.reject_test_checkout();`)
  await assert.rejects(submit(db, 960), /synthetic failure after numbering/)
  assert.equal((await db.query('SELECT count(*)::int n FROM pos_security.invoice_daily_counters')).rows[0].n, 0)
  await db.exec('DROP TRIGGER reject_test_checkout ON transactions')
  assert.match((await submit(db, 960)).result.invoice_no, /^SKP-INV-\d{8}-0001$/)
})
