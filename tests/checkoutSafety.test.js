import test from 'node:test'
import assert from 'node:assert/strict'
import { storeFixture } from './helpers/storeFixture.js'

const ok = data => ({ data, error: null })
const row = { id: 'order', invoice_no: 'SYNTHETIC', total: 100000, paid: 20000, remaining: 80000, items: [] }
const checkout = { items: [], total: 100000, paid: 20000, customerId: 'customer', paymentMethod: 'hutang' }
const failure = { data: null, error: { code: '42501', message: 'Synthetic failure' }, status: 403 }
const writes = calls => calls.filter(c => ['insert', 'update', 'delete'].includes(c.method))

test('secure checkout never retries with ownership, book or snapshot fields stripped', async () => {
  await storeFixture(true, async (store, { calls, script }) => {
    for (const column of ['due_date', 'cashier_role', 'owner_user_id', 'book_id', 'bank_account_id', 'store_name_snapshot']) {
      calls.length = 0
      script.push({ data: null, error: { code: 'PGRST204', message: `Could not find the '${column}' column` }, status: 400 })
      const result = await store.addTransaction(checkout)
      assert.equal(result.ok, false)
      assert.equal(writes(calls).length, 1)
      assert.equal(script.length, 0)
    }
  })
})

test('failed debt persistence after checkout is explicitly uncertain and never retried in secure mode', async () => {
  await storeFixture(true, async (store, { calls, script }) => {
    script.push(ok(row), { data: null, error: { code: 'PGRST204', message: "Could not find the 'book_id' column" } })
    const result = await store.addTransaction(checkout)
    assert.equal(result.ok, false)
    assert.equal(result.needsReconciliation, true)
    assert.deepEqual(writes(calls).map(c => c.table), ['transactions', 'debts'])
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
  await storeFixture(true, async (store, { calls, script }) => {
    for (const responses of [[new Error('Synthetic lost response')], [ok(null)], [ok(row), new Error('Synthetic debt disconnect')]]) {
      calls.length = 0; script.push(...responses)
      const result = await store.addTransaction(checkout)
      assert.equal(result.ok, false)
      assert.equal(result.needsReconciliation, true)
      assert.equal(writes(calls).length, responses.length)
    }
  })
})

test('successful secure checkout retains its amounts and creates one linked debt', async () => {
  await storeFixture(true, async (store, { calls, script, outcome }) => {
    outcome.data = []
    script.push(ok(row), ok(null))
    assert.equal((await store.addTransaction(checkout)).ok, true)
    assert.equal(writes(calls).length, 2)
    const debt = writes(calls).find(c => c.table === 'debts').args[0]
    assert.equal(debt.transaction_id, row.id)
    assert.equal(debt.total_debt, 100000)
    assert.equal(debt.paid, 20000)
    assert.equal(debt.remaining, 80000)
  })
})

test('returned transport or representation errors after insert require reconciliation without another write', async () => {
  await storeFixture(true, async (store, { calls, script }) => {
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
  await storeFixture(true, async (store, { calls, script }) => {
    script.push(failure)
    const result = await store.addTransaction(checkout)
    assert.equal(result.ok, false)
    assert.equal(!!result.needsReconciliation, false)
    assert.equal(writes(calls).length, 1)
  })
})

test('secure checkout retries only a confirmed unique rejection and preserves the full payload', async () => {
  await storeFixture(true, async (store, { calls, script }) => {
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
