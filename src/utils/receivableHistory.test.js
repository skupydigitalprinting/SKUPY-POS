import test from 'node:test'
import assert from 'node:assert/strict'
import { loadReceivableHistory, groupPaymentDays } from './receivableHistory.js'

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
