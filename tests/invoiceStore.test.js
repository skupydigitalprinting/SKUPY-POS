import test from 'node:test'
import assert from 'node:assert/strict'
import { storeFixture } from './helpers/storeFixture.js'

const invoiceId = '80000000-0000-4000-8000-000000000001'
const session = { user: { id: 'owner', role: 'owner', authUserId: 'auth-owner' }, isCurrent: () => true }
const row = { id: invoiceId, version: 0, invoice_no: 'TEST', total: 500000, paid: 200000, remaining: 300000, items: [] }
const ok = data => ({ data, error: null })

async function isolated(run) {
  const descriptors = new Map()
  for (const name of ['localStorage', 'sessionStorage', 'navigator']) descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
  const storage = () => { const data = new Map(); return { get length() { return data.size }, key: i => [...data.keys()][i],
    getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) } }
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage() })
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: storage() })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: { request: async (key, opts, fn) => fn({ name: key }) } } })
  try { await storeFixture(true, run, [], { observe: true, verifiedSession: session }) }
  finally { for (const [key, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key] } }
}

test('background read started before confirmed edit cannot overwrite its refreshed invoice', async () => isolated(async (store, transport) => {
  let release
  transport.script.push(new Promise(resolve => { release = resolve }))
  const oldRead = store.refreshTransactions()
  await Promise.resolve()
  transport.rpcScript.push((name, args) => ok({ operationId: args.p_operation_id, invoiceId, invoiceNo: 'TEST', version: 1,
    state: 'active', total: 150000, paid: 200000, remaining: 0, refundDue: 50000 }))
  transport.script.push(ok([{ ...row, version: 1, total: 150000, remaining: 0 }]), ok([]), ok([]), ok([]))
  const result = await store.invoiceWorkflow.change(invoiceId, 0, 'edit', { reason: 'Test' })
  assert.equal(result.ok, true, JSON.stringify(result))
  release(ok([row])); await oldRead
  const writes = transport.stateWrites.filter(write => write.name === 'transactions')
  assert.equal(writes.length, 1)
  assert.equal(writes[0].value[0].version, 1)
  assert.equal(writes[0].value[0].total, 150000)
}))

test('book switch during a dispatched change retains pending recovery rather than erasing it', async () => isolated(async (store, transport) => {
  let respond, entered
  const started = new Promise(resolve => { entered = resolve })
  transport.rpcScript.push((name, args) => { entered(); return new Promise(resolve => { respond = () => resolve(ok({ operationId: args.p_operation_id,
    invoiceId, invoiceNo: 'TEST', version: 1, state: 'active', total: 150000, paid: 200000, remaining: 0, refundDue: 50000 })) }) })
  const pending = store.invoiceWorkflow.change(invoiceId, 0, 'edit', { reason: 'Test' })
  await started
  store.setActiveBook('another-book')
  respond()
  assert.equal((await pending).ok, false)
  assert.equal(localStorage.length, 1)
  assert.equal(sessionStorage.length, 1)
  assert.equal(transport.stateWrites.filter(write => write.name === 'transactions').length, 0)
}))

test('book switch fences each pending financial collection read', async () => isolated(async (store, transport) => {
  for (const [method, collection] of [['refreshTransactions', 'transactions'], ['refreshCustomers', 'customers'], ['refreshDebts', 'debts'], ['refreshDebtPayments', 'debtPayments']]) {
    let release
    transport.script.push(new Promise(resolve => { release = resolve }))
    const pending = store[method]()
    await Promise.resolve()
    store.setActiveBook(collection)
    release(ok([])); await pending
    assert.equal(transport.stateWrites.filter(write => write.name === collection).length, 0)
  }
}))

test('full refresh from a previous book cannot publish or settle payment recovery', async () => isolated(async (store, transport) => {
  store.setActiveBook('another-book')
  await store.refreshAll()
  assert.equal(transport.requests.length, 0)
  assert.equal(transport.stateWrites.some(write => write.name === 'paymentRefreshPending'), false)
}))

test('verified installment uses one atomic RPC and refreshes without direct table writes', async () => isolated(async (store, transport) => {
  transport.rpcScript.push((name, args) => {
    assert.equal(name, 'pos_submit_payment')
    return ok({ state: 'complete', operationId: args.p_operation_id,
      request: { invoiceNo: 'TEST', amount: 100000, method: 'cash', notes: '' },
      result: { invoice_no: 'TEST', amount: 100000, paid: 300000, remaining: 200000, status: 'aktif' } })
  })
  transport.script.push(ok([{ ...row, paid: 300000, remaining: 200000 }]), ok([]), ok([]), ok([]))
  const result = await store.processDebtPayment({ invoice_no: 'TEST', paymentAmount: 100000 })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.data.paidAfter, 300000)
  assert.equal(result.data.paidBefore, 200000)
  assert.equal(transport.calls.some(call => ['insert', 'update', 'delete'].includes(call.method)), false)
  assert.equal(transport.stateWrites.filter(write => write.name === 'transactions').length, 1)
}))

test('verified payment rejection cannot fall back to sequential legacy writes', async () => isolated(async (store, transport) => {
  transport.rpcScript.push(() => ({ error: { code: '22023' } }))
  const result = await store.processDebtPayment({ invoice_no: 'TEST', paymentAmount: 100000 })
  assert.equal(result.ok, false)
  assert.equal(transport.requests.length, 1)
  assert.equal(transport.requests[0].rpc, 'pos_submit_payment')
  assert.equal(transport.calls.length, 0)
}))

test('payment refresh failure is committed, recoverable by reload and never claims a failed payment', async () => isolated(async (store, transport) => {
  transport.rpcScript.push((name, args) => ok({ state: 'complete', operationId: args.p_operation_id,
    request: { invoiceNo: 'TEST', amount: 100000, method: 'cash', notes: '' },
    result: { invoice_no: 'TEST', amount: 100000, paid: 300000, remaining: 200000, status: 'aktif' } }))
  transport.script.push({ data: null, error: { message: 'offline' } }, ok([]), ok([]), ok([]))
  const result = await store.processDebtPayment({ invoice_no: 'TEST', paymentAmount: 100000 })
  assert.equal(result.ok, false)
  assert.equal(result.committed, true)
  assert.equal(result.needsRefresh, true)
  assert.equal(transport.stateWrites.filter(write => write.name === 'transactions').length, 0)
  assert.equal(transport.stateWrites.filter(write => write.name === 'paymentRefreshPending').at(-1)?.value, true)
  transport.script.push(ok([]), ok([]), ok([]), ok([]))
  assert.equal((await store.paymentWorkflow.refresh()).ok, true)
  assert.equal(transport.stateWrites.filter(write => write.name === 'paymentRefreshPending').at(-1)?.value, false)
}))

test('recovered FIFO payment releases its customer block only after confirmed status and fresh balances', async () => isolated(async (store, transport) => {
  const debt = { id: 'debt', customer_id: 'customer', invoice_no: 'TEST', total_debt: 500000, paid: 200000, remaining: 300000 }
  transport.script.push(ok([debt]))
  transport.rpcScript.push(() => { throw new Error('Lost response') })
  const first = await store.payCustomerDebtsFIFO({ customerId: 'customer', amount: 100000 })
  assert.equal(first.needsReconciliation, true)
  transport.rpcScript.push((name, args) => ok({ state: 'complete', operationId: args.p_operation_id,
    request: { invoiceNo: 'TEST', amount: 100000, method: 'cash', notes: 'Pembayaran gabungan (FIFO)' },
    result: { invoice_no: 'TEST', amount: 100000, paid: 300000, remaining: 200000, status: 'aktif' } }))
  transport.script.push(ok([]), ok([]), ok([]), ok([]))
  assert.equal((await store.paymentWorkflow.reconcile('TEST')).ok, true)
  transport.script.push(ok([{ ...debt, paid: 300000, remaining: 200000 }]), ok([]), ok([]), ok([]), ok([]), ok([]), ok([]), ok([]), ok([]))
  transport.rpcScript.push((name, args) => ok({ state: 'complete', operationId: args.p_operation_id,
    request: { invoiceNo: 'TEST', amount: 50000, method: 'cash', notes: 'Pembayaran gabungan (FIFO)' },
    result: { invoice_no: 'TEST', amount: 50000, paid: 350000, remaining: 150000, status: 'aktif' } }))
  const second = await store.payCustomerDebtsFIFO({ customerId: 'customer', amount: 50000 })
  assert.equal(second.ok, true, JSON.stringify(second))
}))
