import test from 'node:test'
import assert from 'node:assert/strict'
import { createInvoiceWorkflow } from './invoiceWorkflow.js'

function fixture(overrides = {}) {
  const events = []
  const receipt = { invoiceId: 'one', version: 2, state: 'active', total: 150000, paid: 200000, remaining: 0, refundDue: 50000 }
  const flow = createInvoiceWorkflow({
    enabled: true, isCurrent: () => true,
    operations: { change: async request => { events.push(['change', request]); return { ok: true, data: receipt } },
      reconcile: async id => { events.push(['reconcile', id]); return { ok: true, data: receipt } } },
    readInvoice: async id => ({ id, version: 1, total: 200000, paid: 200000, items: [{ name: 'Snapshot' }] }),
    invalidate: () => events.push(['invalidate']),
    refresh: async () => { events.push(['refresh']) },
    ...overrides,
  })
  return { flow, events, receipt }
}

test('unverified legacy session cannot dispatch invoice changes or reads', async () => {
  const { flow, events } = fixture({ enabled: false })
  assert.equal((await flow.load('one')).ok, false)
  assert.equal((await flow.change('one', 1, 'cancel', { reason: 'Test' })).ok, false)
  assert.equal((await flow.reconcile('one')).ok, false)
  assert.deepEqual(events, [])
})

test('committed invoice edit invalidates cached print and refreshes before returning success', async () => {
  const { flow, events, receipt } = fixture()
  const payload = { items: [{ name: 'Snapshot', qty: 1, price: 150000 }], reason: 'Reprice' }
  const result = await flow.change('one', 1, 'edit', payload)
  assert.equal(result.ok, true)
  assert.deepEqual(result.data, receipt)
  assert.deepEqual(events, [['change', { invoiceId: 'one', expectedVersion: 1, kind: 'edit', payload }], ['invalidate'], ['refresh']])
})

test('failed refresh after a committed change is not presented as a rejected write', async () => {
  const { flow, events } = fixture({ refresh: async () => { throw new Error('Offline') } })
  const result = await flow.change('one', 1, 'cancel', { reason: 'Cancelled' })
  assert.equal(result.ok, false)
  assert.equal(result.committed, true)
  assert.equal(result.needsRefresh, true)
  assert.equal(result.needsReconciliation, undefined)
  assert.equal(events.filter(e => e[0] === 'change').length, 1)
})

test('a rejected or ambiguous change cannot refresh or publish success', async () => {
  for (const result of [{ ok: false, needsRefresh: true }, { ok: false, needsReconciliation: true }]) {
    const { flow, events } = fixture({ operations: { change: async () => result } })
    assert.deepEqual(await flow.change('one', 1, 'edit', {}), result)
    assert.deepEqual(events, [])
  }
})

test('reconciled result refreshes exactly like a committed save', async () => {
  const { flow, events } = fixture()
  assert.equal((await flow.reconcile('one')).ok, true)
  assert.deepEqual(events, [['reconcile', 'one'], ['invalidate'], ['refresh']])
})

test('session changed during read or write never publishes old account data', async () => {
  let current = true
  const { flow, events } = fixture({ isCurrent: () => current,
    readInvoice: async () => { current = false; return { id: 'one', version: 0 } } })
  assert.equal((await flow.load('one')).ok, false)
  assert.deepEqual(events, [])
  current = true
  const next = fixture({ isCurrent: () => current, operations: {
    change: async () => { current = false; return { ok: true, data: {} } },
  } })
  assert.equal((await next.flow.change('one', 1, 'edit', {})).ok, false)
  assert.deepEqual(next.events, [])
})

test('missing, cancelled or unversioned invoice cannot enter the editor', async () => {
  for (const row of [null, { id: 'one' }, { id: 'one', version: 0, deletedAt: 'today' },
    { id: 'one', version: 0, orderStatus: 'dibatalkan' }, { id: 'other', version: 0 }]) {
    const { flow } = fixture({ readInvoice: async () => row })
    assert.equal((await flow.load('one')).ok, false)
  }
  assert.equal((await fixture().flow.load('one')).data.items[0].name, 'Snapshot')
})
