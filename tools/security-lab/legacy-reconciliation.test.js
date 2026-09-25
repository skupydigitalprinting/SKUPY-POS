import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fixture, as, actors, id, snapshot } from './invoice-lifecycle-fixture.js'
const helper = await readFile(new URL('../release/reconcile-legacy-payment.sql', import.meta.url), 'utf8')
const reconcile = db => db.query("SELECT pg_temp.reconcile_legacy_payment('INV-LIFE',200000,300000,$1,'reviewed synthetic ledger')", [actors.owner.auth])
test('legacy baseline unlocks cashier payment without replaying or changing old money', async t => {
  const db = await fixture(t)
  await db.exec(await readFile(new URL('../../supabase/security-stage2/012_payment_recovery.sql', import.meta.url), 'utf8'))
  const pay = () => as(db,'cashier',"SELECT pos_submit_payment($1,'INV-LIFE',100000,'transfer','synthetic') value",[id(880)])
  await assert.rejects(pay())
  const before = await snapshot(db)
  await db.exec(helper)
  await reconcile(db)
  const after = await snapshot(db)
  for (const table of Object.keys(before).filter(x => x!=='pos_security.payment_baselines')) assert.deepEqual(after[table],before[table],table)
  assert.equal((await pay())[0].value.result.paid,300000)
  assert.equal((await pay())[0].value.result.paid,300000)
  await assert.rejects(reconcile(db))
})
test('mismatched evidence and staff invocation cannot create a baseline', async t => {
  const db = await fixture(t)
  await db.exec(helper)
  await assert.rejects(db.query("SELECT pg_temp.reconcile_legacy_payment('INV-LIFE',199999,300001,$1,'reviewed synthetic ledger')",[actors.owner.auth]))
  await assert.rejects(as(db,'cashier',"SELECT pg_temp.reconcile_legacy_payment('INV-LIFE',200000,300000,$1,'reviewed synthetic ledger')",[actors.owner.auth]))
  assert.equal((await db.query('SELECT count(*)::int n FROM pos_security.payment_baselines')).rows[0].n,0)
})
