import test from 'node:test'
import assert from 'node:assert/strict'
import { storeFixture as fixture } from './helpers/storeFixture.js'

test('secure reassignment stops before any data request, even for the owner', async () => {
  await fixture(true, async (store, { calls }) => {
    for (const [method, args] of [
      ['reassignAdminCustomers', ['from', 'to']],
      ['reassignOrderCustomer', [{ transactionId: 'order', newCustomerId: 'customer' }]],
      ['reassignReceivableCustomer', [{ debtIds: ['debt'], newCustomerId: 'customer' }]],
      ['updateCustomer', ['customer', { name: 'Uji', ownerUserId: 'other' }]],
    ]) {
      const result = await store[method](...args)
      assert.equal(result.ok, false)
      assert.equal(result.code, 'SECURE_REASSIGNMENT_UNAVAILABLE', method)
      assert.equal(calls.length, 0, method)
    }
  })
})

test('secure metadata-only customer edits still make exactly one write', async () => {
  await fixture(true, async (store, { calls }) => {
    assert.equal((await store.updateCustomer('customer', { name: 'Uji', phone: '123' })).ok, true)
    assert.equal(calls.filter(c => c.method === 'update').length, 1)
    assert.equal(calls.some(c => c.table !== 'customers'), false)
    assert.equal('owner_user_id' in calls.find(c => c.method === 'update').args[0], false)
  })
})

test('secure create and edit never retry with weaker ownership after a schema error', async () => {
  await fixture(true, async (store, { calls, outcome }) => {
    outcome.error = { message: 'owner_user_id does not exist in schema cache', code: 'PGRST204' }
    for (const [method, args, write] of [
      ['addCustomer', [{ name: 'Uji' }], 'insert'],
      ['updateCustomer', ['customer', { name: 'Uji' }], 'update'],
    ]) {
      calls.length = 0
      assert.equal((await store[method](...args)).ok, false)
      assert.equal(calls.filter(c => c.method === write).length, 1, method)
    }
  })
})

test('legacy customer schema fallback remains unchanged', async () => {
  await fixture(false, async (store, { calls, outcome }) => {
    outcome.error = { message: 'owner_user_id does not exist in schema cache', code: 'PGRST204' }
    assert.equal((await store.updateCustomer('customer', { name: 'Uji' })).ok, false)
    assert.equal(calls.filter(c => c.method === 'update').length, 2)
    assert.notEqual((await store.reassignAdminCustomers('from', 'to')).code, 'SECURE_REASSIGNMENT_UNAVAILABLE')
  })
})

test('customer deletion stops without writes when related-data counts fail or are unknown', async () => {
  for (const secure of [false, true]) await fixture(secure, async (store, { calls, outcome }) => {
    for (const [count, error] of [[0, { message: 'Read failed' }], [null, null], [undefined, null], [-1, null]]) {
      calls.length = 0; outcome.count = count; outcome.error = error
      const result = await store.deleteCustomer('customer')
      assert.equal(result.ok, false)
      assert.equal(calls.some(c => ['delete', 'update', 'insert'].includes(c.method)), false)
    }
  })
})

test('confirmed related rows deactivate customer; confirmed empty counts retain existing deletion behavior', async () => {
  await fixture(false, async (store, { calls, outcome }) => {
    outcome.count = 1
    const related = await store.deleteCustomer('customer')
    assert.equal(related.ok, true)
    assert.equal(related.deactivated, true)
    assert.equal(calls.some(c => c.method === 'delete'), false)
    assert.ok(calls.find(c => c.method === 'update').args[0].deleted_at)
    calls.length = 0; outcome.count = 0
    assert.equal((await store.deleteCustomer('customer')).ok, true)
    assert.equal(calls.filter(c => c.method === 'delete').length, 1)
  })
})

test('either related-data query failing independently prevents customer deletion', async () => {
  for (const secure of [true, false]) await fixture(secure, async (store, { calls, outcome }) => {
    for (const table of ['transactions', 'debts']) for (const response of [{ error: { message: 'Read failed' } }, { count: null }, { count: -1 }]) {
      outcome.tables = { [table]: response }; calls.length = 0
      assert.equal((await store.deleteCustomer('customer')).ok, false)
      assert.equal(calls.some(c => ['insert', 'update', 'delete'].includes(c.method)), false)
    }
  })
})
