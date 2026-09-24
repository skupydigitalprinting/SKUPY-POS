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
