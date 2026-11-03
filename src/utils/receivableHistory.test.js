import test from 'node:test'
import assert from 'node:assert/strict'
import { loadReceivableHistory, groupPaymentDays } from './receivableHistory.js'
import * as history from './receivableHistory.js'

test('loads settled invoices too and deduplicates payment IDs', async () => {
  const rows = await loadReceivableHistory([{ id: 'a', invoiceNo: 'INV-A' }, { id: 'b', invoiceNo: 'INV-B' }], async id => ({ ok: true, data: [{ id, amount: 100, paid_at: '2026-09-25T01:00:00Z' }] }))
  assert.equal(rows.length, 2)
  assert.equal(rows[1]._invoiceNo, 'INV-B')
  const dup = await loadReceivableHistory([{ id: 'a' }, { id: 'a' }], async () => ({ ok: true, data: [{ id: 'p', amount: 1 }] }))
  assert.equal(dup.length, 1)
})

test('failed or thrown reads do not return misleading partial history', async () => {
  await assert.rejects(loadReceivableHistory([{ id: 'a' }], async () => ({ ok: false, data: [] })))
  await assert.rejects(loadReceivableHistory([{ id: 'a' }], async () => { throw new Error('offline') }))
})

test('groups by Jakarta calendar day, newest first, retains separate allocations', () => {
  const rows = [
    { id: 'a', amount: '1000000', paid_at: '2026-09-24T18:00:00Z' },
    { id: 'b', amount: 2000000, paid_at: '2026-09-25T02:00:00Z' },
    { id: 'c', amount: 500, paid_at: '2026-09-24T12:00:00Z' },
  ]
  const days = groupPaymentDays(rows)
  assert.equal(days[0].total, 3000000)
  assert.deepEqual(days[0].payments.map(p => p.id), ['b', 'a'])
  assert.equal(days[1].total, 500)
  assert.equal(rows[0].id, 'a')
})

test('empty history and unknown dates remain explicit', () => {
  assert.deepEqual(groupPaymentDays([]), [])
  assert.equal(groupPaymentDays([{ id: 'x', amount: 10, paid_at: null }])[0].label, 'Tanggal tidak tersedia')
})

test('batch history links legacy payments by debt ID and preserves all allocations', async () => {
  const rows = await loadReceivableHistory([{ id: 'old', invoiceNo: 'OLD' }],
    () => { throw new Error('Unexpected single-note read') },
    async ids => ({ ok: true, data: ids.map(debt_id => ({ id: 'p', debt_id, customer_id: null, amount: 170000000 })) }))
  assert.equal(rows.length, 1)
  assert.equal(rows[0]._invoiceNo, 'OLD')
  assert.equal(rows[0].amount, 170000000)
})

test('failed batch history is an error, never an empty or partial successful history', async () => {
  await assert.rejects(loadReceivableHistory([{ id: 'old' }], async () => ({ ok: true, data: [] }),
    async () => ({ ok: false, error: 'offline', data: [] })))
})

test('daily transfers sum FIFO allocations per WIB day and omit invoice details and other methods', () => {
  assert.equal(typeof history.groupTransferDays, 'function')
  const rows = [
    { id: 'a', amount: '12597358', paid_at: '2026-09-02T06:19:00Z', payment_method: 'transfer', _invoiceNo: 'INV-A' },
    { id: 'b', amount: 7402642, paid_at: '2026-09-02T06:19:00Z', payment_method: 'transfer', _invoiceNo: 'INV-B' },
    { id: 'c', amount: 25000000, paid_at: '2026-10-16T08:55:00Z', payment_method: 'transfer' },
    { id: 'cash', amount: 1000000, paid_at: '2026-09-02T06:19:00Z', payment_method: 'cash' },
    { id: 'qris', amount: 2000000, paid_at: '2026-09-02T06:19:00Z', payment_method: 'qris' },
    { id: 'deleted', amount: 9000000, paid_at: '2026-09-02T06:19:00Z', payment_method: 'transfer', deleted_at: '2026-09-03' },
  ]
  const original = structuredClone(rows)
  assert.deepEqual(history.groupTransferDays(rows), [
    { key: '2026-10-16', label: '16 Oktober 2026', total: 25000000 },
    { key: '2026-09-02', label: '2 September 2026', total: 20000000 },
  ])
  assert.deepEqual(rows, original)
})

test('daily transfers use WIB boundaries and preserve an explicit unknown date', () => {
  assert.equal(typeof history.groupTransferDays, 'function')
  assert.deepEqual(history.groupTransferDays([
    { id: 'a', amount: 10, paid_at: '2026-11-02T16:59:59Z', payment_method: 'transfer' },
    { id: 'b', amount: 20, paid_at: '2026-11-02T17:00:00Z', payment_method: ' Transfer ' },
    { id: 'c', amount: 30, paid_at: null, payment_method: 'transfer' },
  ]), [
    { key: '2026-11-03', label: '3 November 2026', total: 20 },
    { key: '2026-11-02', label: '2 November 2026', total: 10 },
    { key: 'unknown', label: 'Tanggal tidak tersedia', total: 30 },
  ])
})

test('daily transfers are empty for cash-only or unclassified payments', () => {
  assert.equal(typeof history.groupTransferDays, 'function')
  assert.deepEqual(history.groupTransferDays([]), [])
  assert.deepEqual(history.groupTransferDays([{ id: 'a', amount: 50, payment_method: 'cash' },
    { id: 'b', amount: 20, notes: 'transfer' }]), [])
})
