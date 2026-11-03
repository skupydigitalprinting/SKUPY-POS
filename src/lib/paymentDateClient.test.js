import test from 'node:test'
import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { createPaymentDateClient } from './paymentDateClient.js'

const payment = { id: 'payment-1', paid_at: '2026-10-20T02:00:00Z' }
const fields = { paymentDate: '2026-10-19', reason: 'Sesuai mutasi bank' }
function fixture() {
  const calls = [], map = new Map()
  let current = true, fail = false
  const client = createPaymentDateClient({ scope: 'book:actor', crypto: webcrypto,
    storage: { getItem: k => map.get(k) || null, setItem: (k, v) => map.set(k, v), removeItem: k => map.delete(k) },
    isCurrent: () => current, client: { rpc: async (name, args) => {
      calls.push({ name, args })
      if (fail) throw new Error('Lost response')
      return { data: { payment_id: payment.id, paid_at: '2026-10-18T17:00:00Z', recorded_at: payment.paid_at } }
    } } })
  return { client, calls, map, setFail: v => { fail = v }, revoke: () => { current = false } }
}
test('date-only edit sends reason and expected timestamp, never amounts', async () => {
  const f = fixture(), result = await f.client.edit(payment, fields)
  assert.equal(result.ok, true)
  assert.equal(f.calls[0].name, 'pos_change_payment_date')
  assert.equal(f.calls[0].args.p_expected_paid_at, payment.paid_at)
  assert.equal(f.calls[0].args.p_payment_date, fields.paymentDate)
  assert.equal('p_amount' in f.calls[0].args, false)
  assert.equal(f.map.size, 0)
})
test('lost date-edit response retries same operation and invalid/revoked edits never dispatch', async () => {
  const f = fixture()
  f.setFail(true)
  assert.equal((await f.client.edit(payment, fields)).ok, false)
  const id = f.calls[0].args.p_operation_id
  f.setFail(false)
  assert.equal((await f.client.edit(payment, fields)).ok, true)
  assert.equal(f.calls[1].args.p_operation_id, id)
  for (const bad of [{ ...fields, paymentDate: '2026-02-30' }, { ...fields, reason: '' }]) {
    assert.equal((await f.client.edit(payment, bad)).ok, false)
  }
  f.revoke()
  assert.equal((await f.client.edit(payment, fields)).ok, false)
  assert.equal(f.calls.length, 2)
})
