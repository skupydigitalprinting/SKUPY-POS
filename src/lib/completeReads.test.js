import test from 'node:test'
import assert from 'node:assert/strict'
import { readBookRows, readCompleteRows } from './completeReads.js'
import { inReportPeriod } from '../utils/financialReports.js'

function clientFor(rows, cap = 80) {
  const calls = []
  return { calls, from(table) {
    let data = [...rows]
    const q = {
      select(columns, options) { assert.equal(options.count, 'exact'); return q },
      is(key) { data = data.filter(row => row[key] == null); return q },
      eq(key, value) { data = data.filter(row => row[key] === value); return q },
      order() { return q },
      range(from, to) { calls.push({ table, from, to }); return Promise.resolve({ data: data.slice(from, Math.min(to + 1, from + cap)), count: data.length, error: null }) },
    }
    return q
  } }
}
test('all date/PIC filters retain old rows beyond 200, 500 and the server cap', async () => {
  const rows = Array.from({ length: 1250 }, (_, i) => ({ id: `n${i}`, book_id: 'a', created_at: '2026-11-03T10:00:00+07:00', total: 1 }))
  rows.push({ id: 'oct1', book_id: 'a', created_at: '2026-10-01T00:00:00+07:00', cashier_id: 'susan', total: 1000000 },
    { id: 'oct31', book_id: 'a', created_at: '2026-10-31T23:59:59.999+07:00', cashier_id: 'susan', total: 2000000 },
    { id: 'other', book_id: 'b', created_at: '2026-10-01T00:00:00+07:00', total: 99 },
    { id: 'deleted', book_id: 'a', deleted_at: '2026-11-01', total: 99 })
  const client = clientFor(rows)
  const result = await readBookRows(client, 'transactions', 'a')
  assert.equal(result.error, null)
  assert.equal(result.count, 1252)
  const month = result.data.filter(row => inReportPeriod(row.created_at, '2026-10-01', '2026-10-31'))
  assert.equal(month.length, 2)
  assert.equal(month.filter(row => row.cashier_id === 'susan').reduce((s, row) => s + row.total, 0), 3000000)
  assert.deepEqual(client.calls.slice(0, 3).map(c => c.from), [0, 80, 160])
})

test('page errors, changing counts, missing counts and duplicate rows never return partial success', async () => {
  for (const pages of [
    [{ data: [{ id: '1' }], count: 2 }, { data: null, error: { message: 'Offline' } }],
    [{ data: [{ id: '1' }], count: 2 }, { data: [{ id: '2' }], count: 3 }],
    [{ data: [{ id: '1' }], count: 2 }, { data: [{ id: '1' }], count: 2 }],
    [{ data: [], count: 2 }],
    [{ data: [{ id: '1' }], count: null }],
  ]) {
    const result = await readCompleteRows(() => ({ order() { return this }, range() { return pages.shift() } }))
    assert.equal(result.data, null)
    assert.ok(result.error)
  }
})
