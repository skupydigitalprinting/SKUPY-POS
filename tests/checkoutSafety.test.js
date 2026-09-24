import test from 'node:test'
import assert from 'node:assert/strict'
import { storeFixture } from './helpers/storeFixture.js'

const ok = data => ({ data, error: null })
const row = { id: 'order', invoice_no: 'SYNTHETIC', total: 100000, paid: 20000, remaining: 80000, items: [] }
const checkout = { items: [], total: 100000, paid: 20000, customerId: 'customer', paymentMethod: 'hutang' }
const failure = { data: null, error: { code: '42501', message: 'Synthetic failure' }, status: 403 }
const writes = calls => calls.filter(c => ['insert', 'update', 'delete'].includes(c.method))

// Verified checkout now uses one RPC, covered by checkoutStore, checkoutClient
// and SQL checkout suites. Sequential behavior remains covered only for legacy.
test('secure checkout without verified identity cannot dispatch any legacy write', async () => {
  await storeFixture(true, async (store, { calls, requests }) => {
    const result = await store.addTransaction(checkout)
    assert.equal(result.ok, false)
    assert.equal(calls.length, 0)
    assert.equal(requests.length, 0)
  })
})

test('checkout reports failed summary reads or writes after the order is persisted', async () => {
  await storeFixture(false, async (store, { script, outcome }) => {
    outcome.data = []
    for (const tail of [[failure, ok([])], [ok([]), ok([]), failure]]) {
      script.push(ok(row), ...tail)
      const result = await store.addTransaction({ ...checkout, paymentMethod: 'cash' })
      assert.equal(result.ok, false)
      assert.equal(result.needsReconciliation, true)
      assert.equal(script.length, 0)
    }
  })
})

test('checkout transport failure after dispatch or missing inserted row requires reconciliation', async () => {
  await storeFixture(false, async (store, { calls, script }) => {
    for (const responses of [[new Error('Synthetic lost response')], [ok(null)], [ok(row), new Error('Synthetic debt disconnect')]]) {
      calls.length = 0; script.push(...responses)
      const result = await store.addTransaction(checkout)
      assert.equal(result.ok, false)
      assert.equal(result.needsReconciliation, true)
      assert.equal(writes(calls).length, responses.length)
    }
  })
})

test('successful legacy checkout retains its amounts and creates one linked debt', async () => {
  await storeFixture(false, async (store, { calls, script, outcome }) => {
    outcome.data = []
    script.push(ok(row), ok(null), ok([]), ok([row]), ok([]), { data: { id: 'customer' }, error: null, count: 1 })
    assert.equal((await store.addTransaction(checkout)).ok, true)
    assert.deepEqual(writes(calls).map(call => call.table), ['transactions', 'debts', 'customers'])
    const debt = writes(calls).find(c => c.table === 'debts').args[0]
    assert.equal(debt.transaction_id, row.id)
    assert.equal(debt.total_debt, 100000)
    assert.equal(debt.paid, 20000)
    assert.equal(debt.remaining, 80000)
  })
})

test('returned transport or representation errors after insert require reconciliation without another write', async () => {
  await storeFixture(false, async (store, { calls, script }) => {
    for (const response of [
      { data: null, error: { code: '', message: 'TypeError: Failed to fetch' }, status: 0 },
      { data: null, error: { code: 'PGRST116', message: 'Cannot coerce the result to a single JSON object' }, status: 406 },
      { data: null, error: { message: 'Bad Gateway' }, status: 502 },
      { data: null, error: { code: '', message: 'Malformed success response' }, status: 201 },
      { data: null, error: { code: '', message: 'duplicate key' }, status: 0 },
      { data: null, error: { code: '23505', message: 'Unverified constraint error' }, status: 502 },
    ]) {
      calls.length = 0; script.push(response)
      const result = await store.addTransaction(checkout)
      assert.equal(result.ok, false)
      assert.equal(result.needsReconciliation, true)
      assert.equal(writes(calls).length, 1)
    }
  })
})

test('confirmed permission rejection stops checkout without suggesting it already persisted', async () => {
  await storeFixture(false, async (store, { calls, script }) => {
    script.push(failure)
    const result = await store.addTransaction(checkout)
    assert.equal(result.ok, false)
    assert.equal(!!result.needsReconciliation, false)
    assert.equal(writes(calls).length, 1)
  })
})

test('legacy checkout retries only a confirmed unique rejection and preserves the full payload', async () => {
  await storeFixture(false, async (store, { calls, script }) => {
    script.push({ data: null, error: { code: '23505', message: 'Synthetic duplicate key' }, status: 409 }, ok(row))
    assert.equal((await store.addTransaction({ ...checkout, customerId: null, paymentMethod: 'cash' })).ok, true)
    const inserts = writes(calls)
    assert.equal(inserts.length, 2)
    const stablePayload = ({ invoice_no, order_no, ...fields }) => fields
    assert.deepEqual(stablePayload(inserts[0].args[0]), stablePayload(inserts[1].args[0]))
  })
})

test('legacy checkout retains existing schema fallback', async () => {
  await storeFixture(false, async (store, { calls, script }) => {
    script.push({ data: null, error: { code: 'PGRST204', message: "Could not find the 'due_date' column" } }, ok(row))
    assert.equal((await store.addTransaction({ ...checkout, customerId: null, paymentMethod: 'cash' })).ok, true)
    assert.equal(writes(calls).length, 2)
    assert.equal(Object.hasOwn(writes(calls)[1].args[0], 'due_date'), false)
  })
})
