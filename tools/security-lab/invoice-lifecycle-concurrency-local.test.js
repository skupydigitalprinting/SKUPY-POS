import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fixture, id, order, cashier, ownerA, auth } from './payment-event-postgres-fixture.js'

const options = { skip: process.env.SKUPY_RUN_LOCAL_PAYMENT_TESTS !== '1', timeout: 90000 }
const lock = "SELECT pg_advisory_xact_lock(hashtextextended('skupy:business-invoice-binding:v1',0));"
const draft = price => ({ items: [{ productId: 'gone', name: 'Saved custom', price, qty: 1, unit: 'pcs' }],
  discount: 0, customerName: 'Synthetic', notes: '', due_date: null, reason: 'Synthetic edit' })
async function lifecycle(run) {
  await fixture(async harness => {
    harness.sql(`UPDATE transactions SET items='[{"productId":"gone","name":"Saved custom","price":100,"qty":1,"unit":"pcs"}]',subtotal=100;
      INSERT INTO accounts(code,name,type,normal) VALUES ('2195','Synthetic refunds','liability','credit');`)
    harness.sql(await readFile(new URL('../../supabase/security-stage2/011_invoice_lifecycle.sql', import.meta.url), 'utf8'))
    harness.sql("INSERT INTO pos_security.invoice_account_config VALUES(true,'2195')")
    const change = (op, version, kind, payload, worker, actor = cashier) => harness.asActor(actor, worker,
      `SELECT public.pos_apply_invoice_change('${op}','${order}',${version},'${kind}','${JSON.stringify(payload).replaceAll("'", "''")}'::jsonb);`)
    const overlap = jobs => harness.gate(lock, async () => {
      const pending = jobs.map((job, index) => job(`invoice_${index}`))
      await harness.waitBlocked(jobs.map((_, index) => `invoice_${index}`))
      return pending
    })
    const state = () => JSON.parse(harness.sql(`SELECT json_build_object('total',total,'paid',paid,'remaining',remaining,'version',version,
      'deleted',deleted_at IS NOT NULL,'events',(SELECT count(*) FROM pos_security.invoice_events)) FROM transactions WHERE id='${order}'`))
    await run({ ...harness, change, overlap, state })
  })
}

test('invoice PostgreSQL: edit racing receipt never overwrites actual money received', options, async () => lifecycle(async h => {
  const [edit, payment] = await h.overlap([
    worker => h.change(id(701), 0, 'edit', draft(80), worker),
    worker => h.pay(id(702), 30, worker),
  ])
  assert.equal(payment.ok, true, payment.stderr)
  const row = h.state()
  assert.equal(row.paid, 30)
  assert.equal(row.total, edit.ok ? 80 : 100)
  assert.equal(row.remaining, edit.ok ? 50 : 70)
  if (!edit.ok) assert.match(edit.stderr, /40001/)
}))

test('invoice PostgreSQL: cancellation racing receipt cannot drop a payment', options, async () => lifecycle(async h => {
  const [cancel, payment] = await h.overlap([
    worker => h.change(id(711), 0, 'cancel', { reason: 'No order' }, worker),
    worker => h.pay(id(712), 30, worker),
  ])
  assert.equal(Number(cancel.ok) + Number(payment.ok), 1)
  const row = h.state()
  assert.equal(row.deleted, cancel.ok)
  assert.equal(row.paid, payment.ok ? 30 : 0)
  assert.equal(row.remaining, cancel.ok ? 0 : 70)
}))

test('invoice PostgreSQL: five duplicate edits commit one lifecycle event', options, async () => lifecycle(async h => {
  const results = await h.overlap(Array.from({ length: 5 }, () => worker => h.change(id(721), 0, 'edit', draft(80), worker)))
  results.forEach(result => assert.equal(result.ok, true, result.stderr))
  results.forEach(result => assert.deepEqual(JSON.parse(result.stdout), JSON.parse(results[0].stdout)))
  assert.deepEqual(h.state(), { total: 80, paid: 0, remaining: 80, version: 1, deleted: false, events: 1 })
}))

test('invoice PostgreSQL: competing refunds never exceed the held receipt', options, async () => lifecycle(async h => {
  assert.equal((await h.pay(id(731), 30, 'initial')).ok, true)
  assert.equal((await h.change(id(732), 1, 'cancel', { reason: 'Cancelled' }, 'cancel')).ok, true)
  const refund = { amount: 30, method: 'cash', occurred_at: '2026-09-01T10:00:00Z', reference: 'Synthetic cash return', reason: 'Actual refund' }
  const results = await h.overlap([733, 734].map(op => worker => h.change(id(op), 2, 'refund', refund, worker)))
  assert.equal(results.filter(result => result.ok).length, 1, JSON.stringify(results))
  assert.equal(h.state().paid, 0)
  assert.equal(h.sql("SELECT sum(CASE WHEN direction='in' THEN amount ELSE -amount END) FROM cash_movements"), '0')
  assert.equal(h.sql('SELECT refund_due FROM pos_security.invoice_states'), '0')
}))

test('invoice PostgreSQL: authorized accounts cannot share an operation identity', options, async () => lifecycle(async h => {
  const results = await h.overlap([cashier, ownerA].map(actor => worker => h.change(id(741), 0, 'edit', draft(80), worker, actor)))
  assert.equal(results.filter(result => result.ok).length, 1)
  assert.match(results.find(result => !result.ok).stderr, /42501/)
  assert.equal(h.state().events, 1)
}))

test('invoice PostgreSQL: revocation while invoice edit waits prevents all writes', options, async () => lifecycle(async h => {
  const before = h.state()
  const [result] = await h.gate(`UPDATE pos_security.user_access SET active=false WHERE auth_user_id='${auth}';`, async () => {
    const pending = h.change(id(751), 0, 'edit', draft(80), 'revoked')
    await h.waitBlocked(['revoked'], ['gate'])
    return [pending]
  })
  assert.equal(result.ok, false)
  assert.match(result.stderr, /42501/)
  assert.deepEqual(h.state(), before)
}))

test('invoice PostgreSQL: lost response is recovered by status without another write', options, async () => lifecycle(async h => {
  assert.equal((await h.change(id(761), 0, 'edit', draft(80), 'lost_response')).ok, true)
  const status = await h.asActor(cashier, 'recover', `SELECT public.pos_invoice_change_status('${id(761)}')`)
  assert.equal(status.ok, true, status.stderr)
  const response = JSON.parse(status.stdout)
  assert.equal(response.state, 'complete')
  assert.equal(response.result.total, 80)
  assert.equal(h.state().events, 1)
}))
