import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fixture, id, cashier, auth } from './payment-event-postgres-fixture.js'

const options = { skip: process.env.SKUPY_RUN_LOCAL_PAYMENT_TESTS !== '1', timeout: 90000 }
async function recovery(run) {
  await fixture(async h => {
    h.sql(await readFile(new URL('../../supabase/security-stage2/012_payment_recovery.sql', import.meta.url), 'utf8'))
    const invoice = h.sql('SELECT invoice_no FROM transactions LIMIT 1').replaceAll("'", "''")
    const submit = (operation, worker) => h.asActor(cashier, worker,
      `SELECT pos_submit_payment('${operation}','${invoice}',30,'cash','Synthetic');`)
    const status = (operation, worker) => h.asActor(cashier, worker, `SELECT pos_payment_status('${operation}');`)
    await run({ ...h, submit, status })
  })
}

test('payment recovery PostgreSQL: duplicate submissions share one committed receipt', options, async () => recovery(async h => {
  const op = id(881)
  const results = await h.gate("SELECT pg_advisory_xact_lock(hashtextextended('skupy:business-invoice-binding:v1',0));", async () => {
    const jobs = Array.from({ length: 4 }, (_, index) => h.submit(op, `recovery_${index}`))
    await h.waitBlocked(['recovery_0', 'recovery_1', 'recovery_2', 'recovery_3'])
    return jobs
  })
  results.forEach(result => assert.equal(result.ok, true, result.stderr))
  results.forEach(result => assert.deepEqual(JSON.parse(result.stdout), JSON.parse(results[0].stdout)))
  assert.equal(h.sql('SELECT count(*) FROM debt_payments'), '1')
  assert.equal(h.sql('SELECT count(*) FROM pos_security.payment_client_receipts'), '1')
  const recovered = await h.status(op, 'recovered')
  assert.equal(recovered.ok, true, recovered.stderr)
  assert.deepEqual(JSON.parse(recovered.stdout), JSON.parse(results[0].stdout))
}))

test('payment recovery PostgreSQL: revocation while status waits prevents disclosure', options, async () => recovery(async h => {
  const op = id(882)
  assert.equal((await h.submit(op, 'receipt')).ok, true)
  const [result] = await h.gate(`UPDATE pos_security.user_access SET active=false WHERE auth_user_id='${auth}';`, async () => {
    const job = h.status(op, 'revoked_status')
    await h.waitBlocked(['revoked_status'], ['gate'])
    return [job]
  })
  assert.equal(result.ok, false)
  assert.match(result.stderr, /42501/)
  assert.equal(h.sql('SELECT count(*) FROM debt_payments'), '1')
}))
