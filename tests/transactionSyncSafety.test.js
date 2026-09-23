import test from 'node:test'
import assert from 'node:assert/strict'
import { storeFixture } from './helpers/storeFixture.js'

const ok = data => ({ data, error: null })
const failure = { data: null, error: { message: 'Synthetic query failure' } }
const trx = { id: 'order', invoice_no: 'TEST-1', total: 100000, paid: 20000, remaining: 80000 }
const writes = calls => calls.filter(c => ['insert', 'update', 'delete'].includes(c.method))
const initial = [{ ...trx, invoiceNo: trx.invoice_no, customerId: 'customer', paymentMethod: 'cash', items: [], date: '2026-09-11T00:00:00Z' }]

test('summary read failure or unavailable rows never replaces customer totals with zero', async () => {
  await storeFixture(false, async (store, { script, calls }) => {
    for (const responses of [[failure, ok([])], [ok([]), failure], [ok(null), ok([])], [ok([]), ok(null)]]) {
      calls.length = 0; script.push(...responses)
      const result = await store.recalculateCustomerSummary('customer')
      assert.equal(result?.ok, false)
      assert.equal(writes(calls).length, 0)
    }
  })
})

test('summary retains existing totals calculation and reports rejected persistence', async () => {
  await storeFixture(false, async (store, { script, calls }) => {
    script.push(ok([{ total: 100000 }, { total: 25000 }]), ok([{ remaining: 80000 }]), failure)
    assert.equal((await store.recalculateCustomerSummary('customer'))?.ok, false)
    assert.deepEqual(writes(calls)[0].args[0], { total_transactions: 2, total_spent: 125000, total_debt: 80000 })
    calls.length = 0
    script.push(ok([]), ok([]), ok({ id: 'customer' }))
    assert.equal((await store.recalculateCustomerSummary('customer'))?.ok, true)
    assert.deepEqual(writes(calls)[0].args[0], { total_transactions: 0, total_spent: 0, total_debt: 0 })
  })
})

test('sync debt lookup errors never become an absent-debt fallback', async () => {
  await storeFixture(false, async (store, { script, calls, requests }) => {
    for (const responses of [[ok(trx), failure], [ok(trx), ok(null), failure]]) {
      calls.length = 0; requests.length = 0; script.push(...responses)
      assert.equal((await store.syncDebtPaymentStatus('TEST-1')).ok, false)
      assert.equal(writes(calls).length, 0)
      assert.equal(requests.length, responses.length)
    }
  })
})

test('sync refuses missing or failed payment history before updating any balances', async () => {
  await storeFixture(false, async (store, { script, calls }) => {
    for (const response of [failure, ok(null)]) {
      calls.length = 0; script.push(ok(trx), ok({ id: 'debt' }), response)
      assert.equal((await store.syncDebtPaymentStatus('TEST-1')).ok, false)
      assert.equal(writes(calls).length, 0)
    }
  })
})

test('sync write failures stop subsequent writes and signal possible partial persistence', async () => {
  await storeFixture(false, async (store, { script, calls }) => {
    for (const tail of [[failure], [ok({ id: 'debt' }), failure]]) {
      calls.length = 0; script.push(ok(trx), ok({ id: 'debt' }), ok([{ amount: 20000 }]), ...tail)
      const result = await store.syncDebtPaymentStatus('TEST-1')
      assert.equal(result.ok, false)
      assert.equal(result.needsReconciliation, true)
      assert.equal(writes(calls).length, tail.length)
    }
  })
})

test('sync propagates failed customer refresh after balance writes instead of claiming success', async () => {
  await storeFixture(false, async (store, { script, calls }) => {
    script.push(ok({ ...trx, customer_id: 'customer' }), ok({ id: 'debt' }), ok([]), ok({ id: 'debt' }), ok({ id: 'order' }), failure, ok([]))
    const result = await store.syncDebtPaymentStatus('TEST-1')
    assert.equal(result.ok, false)
    assert.equal(result.needsReconciliation, true)
    assert.equal(writes(calls).length, 2)
  })
})

test('successful sync preserves current amount rules and no-debt behavior', async () => {
  await storeFixture(false, async (store, { script, calls }) => {
    script.push(ok(trx), ok({ id: 'debt' }), ok([{ amount: 35000 }]), ok({ id: 'debt' }), ok({ id: 'order' }))
    assert.deepEqual(await store.syncDebtPaymentStatus('TEST-1'), { ok: true, data: { paid: 35000, remaining: 65000, status: 'pending' } })
    assert.equal(writes(calls).length, 2)
    calls.length = 0; script.push(ok(trx), ok(null), ok(null), ok({ id: 'order' }))
    assert.deepEqual(await store.syncDebtPaymentStatus('TEST-1'), { ok: true, data: { paid: 20000, remaining: 80000, status: 'pending' } })
    assert.equal(writes(calls).length, 1)
  })
})

test('status caller reports reconciliation when a nonfinancial status write is unconfirmed', async () => {
  await storeFixture(false, async (store, { script, calls, outcome }) => {
    outcome.data = []
    script.push(failure)
    const result = await store.updateTransactionStatus('order', 'proses')
    assert.equal(result.ok, false)
    assert.equal(result.needsReconciliation, true)
    assert.equal(writes(calls).length, 1)
  }, initial)
})

test('invoice edit stops after failed debt lookup or mirror and never reports complete success', async () => {
  await storeFixture(false, async (store, { script, calls, outcome }) => {
    outcome.data = []
    for (const tail of [[failure], [ok(null), failure], [ok({ id: 'debt' }), failure]]) {
      calls.length = 0; script.push(ok(trx), ...tail)
      const result = await store.editTransaction('order', { total: 100000 })
      assert.equal(result.ok, false)
      assert.equal(result.needsReconciliation, true)
      assert.equal(writes(calls).length, tail[0].data?.id ? 2 : 1)
    }
  }, initial)
})

test('invoice edit reports failed customer summary after the invoice was stored', async () => {
  await storeFixture(false, async (store, { script, calls, outcome }) => {
    outcome.data = []
    script.push(ok(trx), ok(null), ok(null), failure, ok([]))
    const result = await store.editTransaction('order', { total: 100000 })
    assert.equal(result.ok, false)
    assert.equal(result.needsReconciliation, true)
    assert.equal(writes(calls).length, 1)
  }, initial)
})

test('sync transport exceptions distinguish pre-write failure from unconfirmed persistence', async () => {
  await storeFixture(false, async (store, { script, calls }) => {
    for (const afterWrite of [false, true]) {
      calls.length = 0
      script.push(ok(trx), ok({ id: 'debt' }))
      if (afterWrite) script.push(ok([]))
      script.push(new Error('Synthetic disconnected transport'))
      const result = await store.syncDebtPaymentStatus('TEST-1')
      assert.equal(result.ok, false)
      assert.equal(!!result.needsReconciliation, afterWrite)
      assert.equal(writes(calls).length, afterWrite ? 1 : 0)
    }
  })
})

test('secure-mode summaries remain database-owned without any browser query', async () => {
  await storeFixture(true, async (store, { calls }) => {
    assert.deepEqual(await store.recalculateCustomerSummary('customer'), { ok: true })
    assert.deepEqual(calls, [])
  })
})

test('successful status and invoice callers still complete without extra payment operations', async () => {
  await storeFixture(false, async (store, { script, calls, outcome }) => {
    outcome.data = []
    const unchangedBalance = { ...trx, status: 'proses' }
    script.push(ok(unchangedBalance))
    assert.equal((await store.updateTransactionStatus('order', 'proses')).ok, true)
    assert.equal(writes(calls).length, 1)
    assert.deepEqual(writes(calls)[0].args[0], { status: 'proses' })
    calls.length = 0
    script.push(ok(trx), ok(null), ok(null), ok([]), ok([]), ok({ id: 'customer' }))
    assert.equal((await store.editTransaction('order', { total: 100000 })).ok, true)
    assert.equal(writes(calls).length, 2)
    assert.equal(calls.some(c => c.method === 'insert'), false)
    assert.equal(script.length, 0)
  }, initial)
})

test('invoice post-write transport failures return reconciliation instead of throwing or retrying', async () => {
  await storeFixture(false, async (store, { script, calls, outcome }) => {
    outcome.data = []
    for (const tail of [[new Error('Lookup lost')], [ok(null), new Error('Fallback lost')], [ok({ id: 'debt' }), new Error('Mirror lost')]]) {
      calls.length = 0; script.push(ok(trx), ...tail)
      const result = await store.editTransaction('order', { total: 100000 })
      assert.equal(result.ok, false)
      assert.equal(result.needsReconciliation, true)
      assert.equal(writes(calls).length, tail[0].data?.id ? 2 : 1)
      assert.equal(script.length, 0)
    }
  }, initial)
})
