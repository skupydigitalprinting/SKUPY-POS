import test from 'node:test'
import assert from 'node:assert/strict'
import { storeFixture } from './helpers/storeFixture.js'

const id = n => `d2000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const book = id(1), customer = id(2), order = id(3), product = id(4)
const request = { customer: 'Test', customerId: customer, items: [{ productId: product, name: 'Custom', qty: 2, price: 100000, unit: 'pcs' }],
  discount: 0, tax: 0, total: 200000, paid: 50000, paymentMethod: 'hutang', receiptMethod: 'transfer', dueDate: '2026-10-01' }
async function isolated(run, isCurrent = () => true) {
  const descriptors = new Map(['localStorage', 'sessionStorage', 'navigator'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  const memory = () => { const map = new Map(); return { get length() { return map.size }, key: i => [...map.keys()][i],
    getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, v), removeItem: k => map.delete(k) } }
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: memory() })
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: memory() })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: { request: async (key, options, run) => run({ name: key }) } } })
  try { await storeFixture(true, run, [], { observe: true, initialBookId: book,
    verifiedSession: { user: { id: id(10), authUserId: id(11), role: 'staff' }, isCurrent } }) }
  finally { for (const [key, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key] } }
}
const receipt = args => ({ data: { state: 'complete', operationId: args.p_operation_id, request: args.p_request, result: {
  id: order, invoice_no: 'INV-CHECKOUT', book_id: book, customer_id: customer, customer: 'Test', items: request.items,
  subtotal: 200000, discount: 0, tax: 0, total: 200000, paid: 50000, dp: 50000, remaining: 150000,
  payment_method: 'transfer', status: 'pending', version: 0,
} }, error: null })

test('verified store checkout uses only one RPC with real DP method and no direct writes', async () => isolated(async (store, transport) => {
  transport.rpcScript.push((name, args) => { assert.equal(name, 'pos_checkout'); assert.equal(args.p_request.method, 'transfer'); return receipt(args) })
  transport.script.push(...Array.from({ length: 4 }, () => ({ data: [], error: null })))
  const result = await store.addTransaction(request)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.data.invoiceNo, 'INV-CHECKOUT')
  assert.equal(result.data.paid, 50000)
  assert.equal(transport.calls.some(call => ['insert', 'update', 'delete'].includes(call.method)), false)
}))

test('ambiguous checkout blocks replacement cart until exact recovery', async () => isolated(async (store, transport) => {
  let original
  transport.rpcScript.push((name, args) => { original = args; throw new Error('Lost') })
  assert.equal((await store.addTransaction(request)).needsReconciliation, true)
  assert.equal((await store.addTransaction({ ...request, paid: 100000 })).needsReconciliation, true)
  assert.equal(transport.requests.length, 1)
  transport.rpcScript.push(name => { assert.equal(name, 'pos_checkout_status'); return receipt(original) })
  transport.script.push(...Array.from({ length: 4 }, () => ({ data: [], error: null })))
  assert.equal((await store.checkoutWorkflow.reconcile()).ok, true)
}))

test('committed checkout refresh failure does not invite a second sale', async () => isolated(async (store, transport) => {
  transport.rpcScript.push((name, args) => receipt(args))
  transport.script.push({ data: null, error: { message: 'Offline' } }, ...Array.from({ length: 3 }, () => ({ data: [], error: null })))
  const result = await store.addTransaction(request)
  assert.equal(result.ok, true)
  assert.equal(result.needsRefresh, true)
  assert.equal(result.data.invoiceNo, 'INV-CHECKOUT')
  const blocked = await store.addTransaction(request)
  assert.equal(blocked.ok, false)
  assert.equal(transport.requests.filter(x => x.rpc).length, 1)
}))

test('session change during confirmed checkout refresh never publishes the prior account receipt', async () => {
  let current = true
  await isolated(async (store, transport) => {
    transport.rpcScript.push((name, args) => receipt(args))
    transport.script.push({ then: resolve => { current = false; resolve({ data: [], error: null }) } },
      ...Array.from({ length: 3 }, () => ({ data: [], error: null })))
    const result = await store.addTransaction(request)
    assert.equal(result.ok, false)
    assert.equal(result.committed, true)
    assert.equal(result.data, undefined)
  }, () => current)
})
