import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fixture, id, cashier, book, customer, auth, admin } from './payment-event-postgres-fixture.js'

const options = { skip: process.env.SKUPY_RUN_LOCAL_PAYMENT_TESTS !== '1', timeout: 90000 }
async function checkout(run) {
  await fixture(async h => {
    h.sql("INSERT INTO accounts(code,name,type,normal) VALUES('2195','Synthetic customer refunds','liability','credit')")
    for (const file of ['011_invoice_lifecycle.sql', '013_atomic_checkout.sql']) {
      h.sql(await readFile(new URL(`../../supabase/security-stage2/${file}`, import.meta.url), 'utf8'))
    }
    h.sql(`INSERT INTO pos_security.invoice_account_config VALUES(true,'2195');
      UPDATE customers SET owner_user_id='${admin}' WHERE id='${customer}';
      INSERT INTO products(id,name,price,stock,unit) VALUES('${id(920)}','Synthetic shirt',100000,0,'pcs');`)
    const draft = { bookId: book, customerId: customer, customerName: 'Synthetic checkout',
      items: [{ productId: id(920), name: 'Synthetic shirt', price: 100000, qty: 2, unit: 'pcs' }],
      discount: 0, paid: 50000, method: 'transfer', dueDate: '2026-10-01', notes: '' }
    const submit = (operation, worker, paid = draft.paid) => h.asActor(cashier, worker,
      `SELECT pos_checkout('${operation}','${JSON.stringify({ ...draft, paid })}'::jsonb);`)
    await run({ ...h, submit })
  })
}

test('checkout PostgreSQL: simultaneous same-ID submissions commit one sale and receipt', options, async () => checkout(async h => {
  const op = id(980)
  const results = await h.gate("SELECT pg_advisory_xact_lock(hashtextextended('skupy:business-invoice-binding:v1',0));", async () => {
    const jobs = Array.from({ length: 4 }, (_, i) => h.submit(op, `checkout_${i}`))
    await h.waitBlocked(['checkout_0', 'checkout_1', 'checkout_2', 'checkout_3'])
    return jobs
  })
  results.forEach(result => assert.equal(result.ok, true, result.stderr))
  results.forEach(result => assert.deepEqual(JSON.parse(result.stdout), JSON.parse(results[0].stdout)))
  assert.equal(h.sql('SELECT count(*) FROM transactions'), '2')
  assert.equal(h.sql('SELECT count(*) FROM pos_security.checkout_operations'), '1')
  const invoice = JSON.parse(results[0].stdout).result
  assert.equal(h.sql(`SELECT count(*) FROM debts WHERE transaction_id='${invoice.id}'`), '1')
  assert.equal(h.sql(`SELECT sum(amount) FROM cash_movements WHERE source_id='${invoice.id}'`), '50000')
  const recovered = await h.asActor(cashier, 'recover', `SELECT pos_checkout_status('${op}');`)
  assert.deepEqual(JSON.parse(recovered.stdout), JSON.parse(results[0].stdout))
}))

test('checkout PostgreSQL: competing payloads cannot replace a committed operation', options, async () => checkout(async h => {
  const results = await h.gate("SELECT pg_advisory_xact_lock(hashtextextended('skupy:business-invoice-binding:v1',0));", async () => {
    const jobs = [h.submit(id(981), 'first', 50000), h.submit(id(981), 'second', 60000)]
    await h.waitBlocked(['first', 'second'])
    return jobs
  })
  assert.equal(results.filter(r => r.ok).length, 1)
  assert.match(results.find(r => !r.ok).stderr, /22023/)
  assert.equal(h.sql('SELECT count(*) FROM pos_security.checkout_operations'), '1')
}))

test('checkout PostgreSQL: profile revocation while checkout waits prevents all writes', options, async () => checkout(async h => {
  const [result] = await h.gate(`UPDATE pos_security.user_access SET active=false WHERE auth_user_id='${auth}';`, async () => {
    const job = h.submit(id(982), 'revoked_checkout')
    await h.waitBlocked(['revoked_checkout'], ['gate'])
    return [job]
  })
  assert.equal(result.ok, false)
  assert.match(result.stderr, /42501/)
  assert.equal(h.sql('SELECT count(*) FROM transactions'), '1')
  assert.equal(h.sql('SELECT count(*) FROM pos_security.checkout_operations'), '0')
}))

test('checkout PostgreSQL: abandonment waits for an in-flight checkout and returns its receipt', options, async () => checkout(async h => {
  const op = id(983)
  const [committed, abandoned] = await h.gate("SELECT pg_advisory_xact_lock(hashtextextended('skupy:business-invoice-binding:v1',0));", async () => {
    const sale = h.submit(op, 'sale')
    await h.waitBlocked(['sale'], ['gate'])
    const stop = h.asActor(cashier, 'abandon', `SELECT pos_abandon_checkout('${op}','${book}');`)
    await h.waitBlocked(['abandon'], ['sale'])
    return [sale, stop]
  })
  assert.equal(committed.ok, true, committed.stderr)
  assert.equal(abandoned.ok, true, abandoned.stderr)
  assert.deepEqual(JSON.parse(abandoned.stdout), JSON.parse(committed.stdout))
  assert.equal(h.sql('SELECT count(*) FROM transactions'), '2')
}))

test('checkout PostgreSQL: terminal abandonment prevents a delayed original request', options, async () => checkout(async h => {
  const op = id(984)
  const stop = await h.asActor(cashier, 'stop', `SELECT pos_abandon_checkout('${op}','${book}');`)
  assert.equal(stop.ok, true, stop.stderr)
  const late = await h.submit(op, 'late_sale')
  assert.equal(late.ok, true, late.stderr)
  assert.deepEqual(JSON.parse(late.stdout), JSON.parse(stop.stdout))
  assert.equal(JSON.parse(late.stdout).state, 'abandoned')
  assert.equal(h.sql('SELECT count(*) FROM transactions'), '1')
}))
