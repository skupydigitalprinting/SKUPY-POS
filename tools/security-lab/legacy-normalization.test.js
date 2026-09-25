import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fixture, as, actors, id } from './invoice-lifecycle-fixture.js'
const helpers = await Promise.all(['reconcile-legacy-payment.sql','normalize-legacy-payment.sql'].map(name => readFile(new URL('../release/'+name,import.meta.url),'utf8')))
async function setup(t, delta='0.000000002') {
  const db=await fixture(t,{mutate: db=>db.query('UPDATE transactions SET total=total+$1::numeric,subtotal=subtotal+$1::numeric,remaining=remaining+$1::numeric',[delta])})
  for(const helper of helpers) await db.exec(helper)
  await db.exec(await readFile(new URL('../../supabase/security-stage2/012_payment_recovery.sql',import.meta.url),'utf8'))
  return db
}
const repair=db=>db.query("SELECT pg_temp.normalize_legacy_payment('INV-LIFE',200000,300000,$1,'reviewed synthetic fractional drift')",[actors.owner.auth])
test('fractional repair preserves receipts and permits cashier payment exactly once',async t=>{
  const db=await setup(t)
  await repair(db)
  const row=(await db.query('SELECT total,remaining,paid FROM transactions')).rows[0]
  assert.deepEqual(row,{total:'500000',remaining:'300000',paid:'200000'})
  const call=()=>as(db,'cashier',"SELECT pos_submit_payment($1,'INV-LIFE',100000,'transfer','synthetic') value",[id(881)])
  assert.equal((await call())[0].value.result.paid,300000)
  assert.equal((await call())[0].value.result.paid,300000)
  assert.equal((await db.query('SELECT count(*)::int n FROM debt_payments')).rows[0].n,1)
})
test('whole-rupiah differences are rejected without changing data',async t=>{
  const db=await setup(t,'1')
  await assert.rejects(repair(db))
  assert.equal((await db.query('SELECT total FROM transactions')).rows[0].total,'500001')
  assert.equal((await db.query('SELECT count(*)::int n FROM pos_security.payment_baselines')).rows[0].n,0)
})
test('unreconciled cash causes the entire normalization to roll back',async t=>{
  const db=await setup(t)
  await db.exec('DELETE FROM cash_movements')
  await assert.rejects(repair(db))
  assert.equal((await db.query('SELECT total FROM transactions')).rows[0].total,'500000.000000002')
  assert.equal((await db.query('SELECT count(*)::int n FROM pos_security.payment_baselines')).rows[0].n,0)
  assert.equal((await db.query('SELECT count(*)::int n FROM pos_security.invoice_write_context')).rows[0].n,0)
})
