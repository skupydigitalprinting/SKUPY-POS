import test from 'node:test'
import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { createPaymentClient } from './paymentClient.js'

const request = { invoiceNo: 'INV-TEST', amount: 100000, method: 'transfer', notes: 'Payment test' }
const memory = () => { const map = new Map(); return { get length() { return map.size }, key: i => [...map.keys()][i],
  getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, v), removeItem: k => map.delete(k) } }
function fixture() {
  const storage = memory(), draftStorage = memory(), calls = [], script = [], held = new Set()
  let current = true
  const locks = { request: async (key, options, run) => {
    if (held.has(key)) return run(null)
    held.add(key)
    try { return await run({ name: key }) } finally { held.delete(key) }
  } }
  const rpc = async (name, args) => { calls.push({ name, args }); const next = script.shift();
    if (!next) throw new Error('Unexpected RPC'); return next(name, args) }
  const make = () => createPaymentClient({ client: { rpc }, storage, draftStorage, locks, crypto: webcrypto,
    scope: 'local', actorId: 'verified-actor', isCurrent: () => current })
  return { make, calls, script, storage, draftStorage, revoke: () => { current = false } }
}
const envelope = (operationId, input = request) => ({ data: { state: 'complete', operationId, request: input,
  result: { invoice_no: 'INV-TEST', amount: 100000, paid: 300000, remaining: 200000, status: 'aktif' } }, error: null })

test('payment submits only a bound RPC and returns verified money values', async () => {
  const f = fixture()
  f.script.push((name, args) => envelope(args.p_operation_id))
  const result = await f.make().submit(request)
  assert.equal(result.ok, true)
  assert.equal(result.data.paid, 300000)
  assert.equal(f.calls[0].name, 'pos_submit_payment')
  assert.deepEqual(Object.keys(f.calls[0].args).sort(), ['p_amount', 'p_invoice_no', 'p_method', 'p_notes', 'p_operation_id'])
  assert.equal(f.storage.length, 0)
  assert.equal(f.draftStorage.length, 0)
})

test('lost response survives reload and status settles once without another payment write', async () => {
  const f = fixture()
  f.script.push(() => { throw new Error('Lost response') })
  const lost = await f.make().submit(request)
  assert.equal(lost.needsReconciliation, true)
  assert.equal(f.storage.length, 1)
  assert.equal(f.storage.getItem(f.storage.key(0)).includes('Payment test'), false)
  assert.equal(f.make().pending()[0].invoiceNo, 'INV-TEST')
  f.script.push((name, args) => envelope(args.p_operation_id))
  assert.equal((await f.make().reconcile('INV-TEST')).ok, true)
  assert.deepEqual(f.calls.map(c => c.name), ['pos_submit_payment', 'pos_payment_status'])
})

test('unknown operation retries exactly the original ID and payload, never changed amounts', async () => {
  const f = fixture()
  f.script.push(() => { throw new Error('Lost before write') })
  const lost = await f.make().submit(request)
  assert.equal((await f.make().submit({ ...request, amount: 50000 })).needsReconciliation, true)
  assert.equal(f.calls.length, 1)
  f.script.push(() => ({ data: { state: 'unknown' }, error: null }),
    (name, args) => envelope(args.p_operation_id))
  assert.equal((await f.make().resume('INV-TEST')).ok, true)
  assert.equal(f.calls[2].args.p_operation_id, lost.operationId)
  assert.deepEqual(f.calls[2].args, f.calls[0].args)
})

test('mismatched receipt identity, payload or money cannot clear pending payment', async () => {
  for (const corrupt of [v => { v.operationId = webcrypto.randomUUID() }, v => { v.request.method = 'cash' },
    v => { v.result.amount = 999 }, v => { v.result.remaining = -1 }, v => { v.result.status = 'lunas' }]) {
    const f = fixture()
    f.script.push((name, args) => { const value = envelope(args.p_operation_id, { ...request }); corrupt(value.data); return value })
    assert.equal((await f.make().submit(request)).needsReconciliation, true)
    assert.equal(f.storage.length, 1)
  }
})

test('session change during dispatch retains evidence and never confirms old-session data', async () => {
  const f = fixture()
  f.script.push((name, args) => { f.revoke(); return envelope(args.p_operation_id) })
  assert.equal((await f.make().submit(request)).needsReconciliation, true)
  assert.equal(f.storage.length, 1)
})

test('cross-tab lock prevents overlapping payments and invalid amounts never dispatch', { timeout: 2000 }, async () => {
  const f = fixture()
  let finish, started
  const entered = new Promise(resolve => { started = resolve })
  f.script.push((name, args) => { started(); return new Promise(resolve => { finish = () => resolve(envelope(args.p_operation_id)) }) })
  const first = f.make().submit(request)
  await entered
  assert.equal((await f.make().submit(request)).busy, true)
  finish(); assert.equal((await first).ok, true)
  for (const amount of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '100000']) {
    assert.equal((await f.make().submit({ ...request, amount })).ok, false)
  }
  assert.equal(f.calls.length, 1)
})

test('definite first rejection permits correction but ambiguous retry rejection retains evidence', async () => {
  const f = fixture()
  f.script.push(() => ({ error: { code: '22023' } }))
  assert.equal((await f.make().submit(request)).needsReconciliation, undefined)
  assert.equal(f.storage.length, 0)
  f.script.push(() => { throw new Error('Lost') })
  await f.make().submit(request)
  f.script.push(() => ({ data: { state: 'unknown' } }), () => ({ error: { code: '22023' } }))
  assert.equal((await f.make().resume('INV-TEST')).needsReconciliation, true)
  assert.equal(f.storage.length, 1)
})
