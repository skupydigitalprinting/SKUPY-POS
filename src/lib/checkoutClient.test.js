import test from 'node:test'
import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { createCheckoutClient } from './checkoutClient.js'

const id = n => `d1000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const request = { bookId: id(1), customerId: id(2), customerName: 'Test',
  items: [{ productId: id(3), name: 'Custom', price: 100000, qty: 2, unit: 'pcs' }],
  discount: 0, paid: 50000, method: 'cash', dueDate: '2026-10-01', notes: '' }
const memory = () => { const map = new Map(); return { getItem: k => map.get(k) ?? null,
  setItem: (k, v) => map.set(k, v), removeItem: k => map.delete(k), clear: () => map.clear(), values: () => [...map.values()] } }
function fixture() {
  const storage = memory(), draftStorage = memory(), calls = [], scripts = []
  let current = true, held = false
  const make = () => createCheckoutClient({ client: { rpc: async (name, args) => { calls.push({ name, args }); return scripts.shift()(name, args) } },
    scope: 'synthetic', actorId: id(10), isCurrent: () => current, storage, draftStorage, crypto: webcrypto,
    locks: { request: async (name, options, fn) => { if (held) return fn(null); held = true; try { return await fn({ name }) } finally { held = false } } } })
  const result = op => ({ data: { state: 'complete', operationId: op, request, result: {
    id: id(50), invoice_no: 'INV-TEST', book_id: request.bookId, customer_id: request.customerId,
    items: request.items, subtotal: 200000, discount: 0, tax: 0, total: 200000, paid: 50000, dp: 50000,
    remaining: 150000, payment_method: 'cash', status: 'pending', version: 0,
  } }, error: null })
  return { make, storage, draftStorage, calls, scripts, result, revoke: () => { current = false } }
}

test('checkout submits one operation, validates canonical receipt and clears only confirmed drafts', async () => {
  const f = fixture()
  f.scripts.push((name, args) => { assert.equal(name, 'pos_checkout'); assert.deepEqual(args.p_request, request); return f.result(args.p_operation_id) })
  assert.equal((await f.make().submit(request)).ok, true)
  assert.equal(f.calls.length, 1)
  assert.equal(f.storage.values().length, 0)
  assert.equal(f.draftStorage.values().length, 0)
})

test('lost checkout response survives reload and changed cart cannot create another invoice', async () => {
  const f = fixture()
  f.scripts.push(() => { throw new Error('Lost response') })
  assert.equal((await f.make().submit(request)).needsReconciliation, true)
  assert.equal(f.storage.values().some(s => s.includes('Custom')), false)
  assert.equal((await f.make().submit({ ...request, paid: 100000 })).needsReconciliation, true)
  assert.equal(f.calls.length, 1)
  const op = f.calls[0].args.p_operation_id
  f.scripts.push(() => f.result(op))
  assert.equal((await f.make().reconcile()).ok, true)
  assert.deepEqual(f.calls.map(c => c.name), ['pos_checkout', 'pos_checkout_status'])
})

test('unknown checkout retries only the same durable operation and original tab draft', async () => {
  const f = fixture()
  f.scripts.push(() => { throw new Error('Lost') })
  await f.make().submit(request)
  const op = f.calls[0].args.p_operation_id
  f.scripts.push(() => ({ data: { state: 'unknown' } }), (name, args) => {
    assert.equal(args.p_operation_id, op); assert.deepEqual(args.p_request, request); return f.result(op)
  })
  assert.equal((await f.make().resume()).ok, true)
})

test('session change and malformed receipt preserve unresolved checkout evidence', async () => {
  for (const revoke of [true, false]) {
    const f = fixture()
    f.scripts.push((name, args) => { const value = f.result(args.p_operation_id); if (revoke) f.revoke(); else value.data.result.total = 1; return value })
    assert.equal((await f.make().submit(request)).needsReconciliation, true)
    assert.equal(f.storage.values().length, 1)
  }
})

test('concurrent checkout tabs cannot dispatch twice', { timeout: 2000 }, async () => {
  const f = fixture(); let release, entered
  const ready = new Promise(resolve => { entered = resolve })
  f.scripts.push((name, args) => { entered(); return new Promise(resolve => { release = () => resolve(f.result(args.p_operation_id)) }) })
  const first = f.make().submit(request); await ready
  assert.equal((await f.make().submit(request)).busy, true)
  release(); assert.equal((await first).ok, true)
  assert.equal(f.calls.length, 1)
})

test('invalid checkout and known rollback never fall back to direct writes', async () => {
  const f = fixture()
  assert.equal((await f.make().submit({ ...request, paid: 500000 })).ok, false)
  assert.equal(f.calls.length, 0)
  f.scripts.push(() => ({ error: { code: '42501' } }))
  assert.equal((await f.make().submit(request)).ok, false)
  assert.equal(f.storage.values().length, 0)
})

test('closed original tab can safely abandon only a server-confirmed uncommitted checkout', async () => {
  const f = fixture()
  f.scripts.push(() => { throw new Error('Offline') })
  await f.make().submit(request)
  const op = f.calls[0].args.p_operation_id
  f.draftStorage.clear()
  f.scripts.push(() => ({ data: { state: 'unknown' } }))
  assert.equal((await f.make().resume()).unknown, true)
  f.scripts.push((name, args) => {
    assert.equal(name, 'pos_abandon_checkout'); assert.equal(args.p_operation_id, op)
    return { data: { state: 'abandoned', operationId: op, bookId: request.bookId } }
  })
  assert.deepEqual(await f.make().abandon(), { ok: true, abandoned: true })
  assert.equal(f.storage.values().length, 0)
})

test('rejected resend retains evidence until safe abandon, which also recovers a late commit', async () => {
  const f = fixture()
  f.scripts.push(() => { throw new Error('Offline') })
  await f.make().submit(request)
  const op = f.calls[0].args.p_operation_id
  f.scripts.push(() => ({ data: { state: 'unknown' } }), () => ({ error: { code: '22023' } }))
  assert.equal((await f.make().resume()).needsReconciliation, true)
  assert.equal(f.storage.values().length, 1)
  f.scripts.push(() => f.result(op))
  const result = await f.make().abandon()
  assert.equal(result.ok, true)
  assert.equal(result.data.invoice_no, 'INV-TEST')
  assert.equal(f.storage.values().length, 0)
})
