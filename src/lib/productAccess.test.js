import test from 'node:test'
import assert from 'node:assert/strict'
import { PRODUCT_PUBLIC_COLUMNS, attachProductCosts, saveSecureProduct } from './productAccess.js'

test('public product columns never request the private modal column', () => {
  assert.equal(PRODUCT_PUBLIC_COLUMNS.split(',').includes('modal'), false)
  assert.equal(PRODUCT_PUBLIC_COLUMNS.split(',').includes('name'), true)
})
test('only owners request costs and cost failures do not become zero-cost success', async () => {
  const rows = [{ id: 'one', name: 'Kaos', image: 'photo', is_favorite: true }]
  const calls = []
  const client = { async rpc(name) { calls.push(name); return { data: [{ id: 'one', modal: 12000 }] } } }
  for (const role of ['staff', 'admin']) assert.deepEqual(await attachProductCosts(client, rows, role), rows)
  assert.equal(calls.length, 0)
  assert.deepEqual(await attachProductCosts(client, rows, 'owner'), [{ ...rows[0], modal: 12000 }])
  assert.deepEqual(calls, ['pos_product_costs'])
  await assert.rejects(attachProductCosts({ rpc: async () => ({ error: new Error('denied') }) }, rows, 'owner'))
  await assert.rejects(attachProductCosts({ rpc: async () => ({ data: [] }) }, rows, 'owner'))
})
test('staff and admin saves omit costs while owner costs go through the atomic RPC', async () => {
  const payload = { name: 'Kaos', price: 50000, modal: 0 }
  for (const role of ['staff', 'admin', 'owner']) {
    const calls = []
    const client = { async rpc(...args) { calls.push(args); return { data: { id: 'one', name: 'Kaos' } } } }
    assert.equal((await saveSecureProduct(client, null, payload, role)).name, 'Kaos')
    assert.deepEqual(calls, [['pos_save_product', { p_id: null, p_values: role === 'owner' ? payload : { name: 'Kaos', price: 50000 } }]])
  }
  assert.equal(payload.modal, 0)
  await assert.rejects(saveSecureProduct({ rpc: async () => ({ error: new Error('denied') }) }, 'one', payload, 'owner'))
  await assert.rejects(saveSecureProduct({ rpc: async () => ({ data: null }) }, 'one', payload, 'owner'))
})
