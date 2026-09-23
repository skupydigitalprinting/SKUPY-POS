import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as reports from './financialReports.js'
const { reportDayBounds, inReportPeriod, initialTender, initialTenderMethod, installmentTotals, readReportRows } = reports

test('WIB bounds roll over leap day and year, independently of host timezone', () => {
  assert.equal(reportDayBounds('2024-02-29', '2024-02-29').end, '2024-03-01T00:00:00+07:00')
  assert.equal(reportDayBounds(null, '2026-12-31').end, '2027-01-01T00:00:00+07:00')
  assert.equal(inReportPeriod('2026-09-11T16:59:59.999Z', '2026-09-11', '2026-09-11'), true)
  assert.equal(inReportPeriod('2026-09-11T17:00:00Z', '2026-09-11', '2026-09-11'), false)
  assert.equal(inReportPeriod('2026-09-12T10:00:00Z', '2026-09-11'), true)
})
test('available history is an inference, never proof of repaired historical DP', () => {
  const totals = installmentTotals([{ invoice_no: 'a', amount: 30 }, { invoice_no: 'a', amount: 40, deleted_at: 'deleted' }])
  assert.equal(initialTender(50, totals.get('a')), 20)
  assert.equal(initialTender(20, 30), 0)
  assert.equal(initialTenderMethod('hutang'), 'cash')
  assert.equal(initialTenderMethod('unknown'), 'unknown')
})
function source(pages) {
  let index = 0
  return () => ({ order() { return this }, range() { return pages[index++] } })
}
test('aggregate reader rejects malformed, uncounted, short and changing sources', async () => {
  for (const page of [{ data: null, count: 0 }, { data: [], count: null }, { data: [{ id: 1 }], count: 2 }]) {
    await assert.rejects(readReportRows(source([page])), /Incomplete/)
  }
  await assert.rejects(readReportRows(source([
    { data: Array(500).fill({}), count: 501 }, { data: [{ id: 501 }], count: 502 },
  ])), /changed/)
})
test('period loader clears previous totals and publishes failures without fallback', async () => {
  const updates = []
  await reports.loadPeriodReport({ from: 'a', to: 'b', load: async () => ({ ok: false, error: 'Unavailable' }), publish: state => updates.push(state) })
  assert.deepEqual(updates.map(s => [s.status, s.data]), [['loading', null], ['error', null]])
  assert.equal(updates[1].from, 'a')
})
test('period loader does not publish a response after its request is invalidated', async () => {
  let current = true, finish
  const updates = []
  const pending = reports.loadPeriodReport({ from: 'a', to: 'b', load: () => new Promise(resolve => { finish = resolve }), publish: state => updates.push(state), isCurrent: () => current })
  current = false
  finish({ ok: true, totalMasuk: 123 })
  await pending
  assert.deepEqual(updates.map(s => s.status), ['loading'])
})
test('exactly 500 and 1000 rows stop at the exact count before PostgREST range 416', async () => {
  for (const count of [500, 1000]) {
    let requests = 0
    const result = await readReportRows(() => ({
      order() { return this },
      range(start, end) {
        requests += 1
        if (start >= count) return { data: null, error: { code: 'PGRST103', message: 'Requested range not satisfiable' }, count, status: 416 }
        return { data: Array.from({ length: Math.min(end + 1, count) - start }, (_, i) => ({ id: start + i })), error: null, count }
      },
    }))
    assert.equal(result.data.length, count)
    assert.equal(requests, count / 500)
  }
})
test('more rows than the exact count is incomplete, not successful', async () => {
  await assert.rejects(readReportRows(source([{ data: Array(500).fill({}), count: 499 }])), /Incomplete/)
})
