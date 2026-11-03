import test from 'node:test'
import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { storeFixture } from './helpers/storeFixture.js'
import { createPaymentDateClient } from '../src/lib/paymentDateClient.js'

const ok = data => ({ data, error: null })
const payment = { id: 'payment-1', paid_at: '2026-03-02T02:00:00Z', amount: 100 }
const fields = { paymentDate: '2026-03-01', reason: 'Sesuai mutasi bank' }
const receipt = { payment_id: payment.id, paid_at: '2026-02-28T17:00:00Z', recorded_at: payment.paid_at }
const session = { user: { id: 'owner', role: 'owner', authUserId: 'auth-owner' }, isCurrent: () => true }
function memory() {
  const map = new Map()
  return { get length() { return map.size }, getItem: key => map.get(key) ?? null,
    setItem: (key, value) => map.set(key, value), removeItem: key => map.delete(key) }
}

async function secureStore(run) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage')
  const storage = memory()
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: storage })
  try {
    await storeFixture(true, (store, transport) => run(store, transport, storage), [],
      { observe: true, verifiedSession: session })
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'sessionStorage', descriptor)
    else delete globalThis.sessionStorage
  }
}

test('legacy today keeps the guarded payment path and original input timestamp', async () => {
  await storeFixture(false, async (store, transport) => {
    const RealDate = globalThis.Date
    const now = '2026-11-02T17:30:00.000Z'
    globalThis.Date = class extends RealDate {
      constructor(...args) { super(...(args.length ? args : [now])) }
      static now() { return new RealDate(now).getTime() }
    }
    try {
      transport.script.push(
        ok({ id: 't1', invoice_no: 'INV-1', total: 500, paid: 100, remaining: 400 }),
        ok({ id: 'd1', transaction_id: 't1', invoice_no: 'INV-1', total_debt: 500, paid: 100, remaining: 400 }),
        ok({ id: 't1' }), ok({ id: 'd1' }), ok({ id: 'p1' }),
      )
      const result = await store.processDebtPayment({ invoice_no: 'INV-1', paymentAmount: 200,
        paymentMethod: 'transfer', paymentDate: '2026-11-03', skipRefresh: true })
      assert.equal(result.ok, true, JSON.stringify(result))
      assert.equal(result.data.paidAfter, 300)
      assert.equal(result.data.remainingAfter, 200)
      assert.equal(transport.requests.some(request => request.rpc), false)
      const inserts = transport.calls.filter(call => call.method === 'insert')
      assert.equal(inserts.length, 1)
      assert.equal(inserts[0].table, 'debt_payments')
      assert.equal(inserts[0].args[0].paid_at, now)
      assert.equal(inserts[0].args[0].amount, 200)
      assert.equal(inserts[0].args[0].payment_method, 'transfer')
    } finally { globalThis.Date = RealDate }
  })
})

test('legacy backdating is rejected before any read or write', async () => {
  await storeFixture(false, async (store, transport) => {
    const result = await store.processDebtPayment({ invoice_no: 'INV-1', paymentAmount: 200,
      paymentDate: '2020-01-01', skipRefresh: true })
    assert.equal(result.ok, false)
    assert.match(result.error, /terverifikasi/)
    assert.equal(transport.requests.length, 0)
  })
})

test('confirmed date correction stays successful when collection refresh fails and recovers without another write', async () => {
  await secureStore(async (store, transport, storage) => {
    transport.rpcScript.push(() => ok({ ...receipt }))
    transport.outcome.error = { message: 'Offline refresh' }
    const result = await store.editPaymentDate(payment, fields)
    assert.equal(result.ok, true)
    assert.equal(result.committed, true)
    assert.equal(result.needsRefresh, true)
    assert.deepEqual(result.data, receipt)
    assert.equal(storage.length, 0)
    assert.equal(transport.stateWrites.filter(write => write.name === 'invoiceRevision').at(-1)?.value, 1)
    assert.equal(transport.stateWrites.some(write => write.name === 'debtPayments'), false)

    transport.outcome.error = null
    for (const table of ['transactions', 'debts', 'customers', 'debt_payments']) {
      transport.outcome.tables[table] = ok([])
    }
    assert.equal((await store.invoiceWorkflow.refresh()).ok, true)
    assert.deepEqual(transport.requests.filter(request => request.rpc).map(request => request.rpc), ['pos_change_payment_date'])
    assert.equal(transport.calls.some(call => ['insert', 'update', 'delete'].includes(call.method)), false)
  })
})

test('book change during date correction cannot publish old-session financial state', async () => {
  await secureStore(async (store, transport, storage) => {
    let respond, started
    const entered = new Promise(resolve => { started = resolve })
    transport.rpcScript.push(() => {
      started()
      return new Promise(resolve => { respond = resolve })
    })
    const pending = store.editPaymentDate(payment, fields)
    await entered
    store.setActiveBook('another-book')
    respond(ok({ ...receipt }))
    const result = await pending
    assert.equal(result.ok, false)
    assert.match(result.error, /Sesi berubah/)
    assert.equal(storage.length, 1)
    assert.equal(transport.requests.filter(request => !request.rpc).length, 0)
    assert.equal(transport.stateWrites.some(write => ['invoiceRevision', 'transactions', 'debts', 'debtPayments'].includes(write.name)), false)
  })
})

test('lost date response survives client recreation and retries identical date-only arguments', async () => {
  const storage = memory(), calls = []
  const make = () => createPaymentDateClient({ storage, scope: 'project:actor:book', isCurrent: () => true,
    crypto: webcrypto, client: { rpc: async (name, args) => {
      calls.push({ name, args })
      if (calls.length === 1) throw new Error('Lost response')
      return ok({ ...receipt })
    } } })
  assert.equal((await make().edit(payment, fields)).ok, false)
  assert.equal(storage.length, 1)
  assert.equal((await make().edit(payment, fields)).ok, true)
  assert.equal(storage.length, 0)
  assert.deepEqual(calls[1], calls[0])
  assert.equal(calls[0].name, 'pos_change_payment_date')
  assert.deepEqual(Object.keys(calls[0].args).sort(),
    ['p_expected_paid_at', 'p_operation_id', 'p_payment_date', 'p_payment_id', 'p_reason'])
  assert.equal(calls[0].args.p_expected_paid_at, '2026-03-02T02:00:00Z')
  assert.equal(calls[0].args.p_payment_date, '2026-03-01')
})

test('date correction does not reuse an operation identity for a changed intent', async () => {
  const storage = memory(), calls = []
  const client = createPaymentDateClient({ storage, scope: 'project:actor:book', isCurrent: () => true,
    crypto: webcrypto, client: { rpc: async (_, args) => {
      calls.push(args)
      throw new Error('Lost response')
    } } })
  await client.edit(payment, fields)
  await client.edit(payment, { ...fields, paymentDate: '2026-02-28' })
  assert.equal(calls.length, 2)
  assert.notEqual(calls[1].p_operation_id, calls[0].p_operation_id)
  assert.equal(calls[1].p_expected_paid_at, calls[0].p_expected_paid_at)
  assert.equal(calls[1].p_payment_date, '2026-02-28')
})
