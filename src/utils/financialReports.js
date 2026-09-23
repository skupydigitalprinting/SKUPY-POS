import { toMoney } from './helpers.js'

// Reports use WIB calendar dates and an exclusive next-midnight upper bound.
export function reportDayBounds(from, to) {
  const start = from ? `${from}T00:00:00+07:00` : null
  let end = null
  if (to) {
    const date = new Date(`${to}T00:00:00Z`)
    date.setUTCDate(date.getUTCDate() + 1)
    end = `${date.toISOString().slice(0, 10)}T00:00:00+07:00`
  }
  return { start, end }
}

export function inReportPeriod(timestamp, from, to) {
  const { start, end } = reportDayBounds(from, to)
  const value = new Date(timestamp).getTime()
  return Number.isFinite(value) && (!start || value >= new Date(start).getTime()) && (!end || value < new Date(end).getTime())
}

export function installmentTotals(payments = []) {
  const totals = new Map()
  for (const p of payments) {
    if (p.deleted_at || !p.invoice_no) continue
    totals.set(p.invoice_no, (totals.get(p.invoice_no) || 0) + toMoney(p.amount))
  }
  return totals
}

// This is an inference from the available history, not a repair of legacy data.
// Include same-time split tenders and later installments; dp can be cumulative too.
export function initialTender(paid, installments = 0) {
  return Math.max(0, toMoney(paid) - installments)
}

// Match the existing exported acc_dashboard convention for a hutang cash DP.
export const initialTenderMethod = method => method === 'hutang' ? 'cash' : method

// A source error, missing payload, or unexplained short page must never be a
// successful partial aggregate. Exact counts also detect lower server row caps.
export async function readReportRows(buildQuery) {
  const rows = []
  const pageSize = 500
  let expected = null
  for (let offset = 0; ; offset += pageSize) {
    const { data, error, count } = await buildQuery().order('id', { ascending: true }).range(offset, offset + pageSize - 1)
    if (error) throw new Error(error.message || 'Report source unavailable')
    if (!Array.isArray(data) || !Number.isInteger(count) || count < 0) throw new Error('Incomplete report source')
    if (typeof count === 'number') {
      if (expected !== null && count !== expected) throw new Error('Report source changed during read')
      expected = count
    }
    rows.push(...data)
    if (rows.length > expected) throw new Error('Incomplete report source')
    if (rows.length === expected) return { data: rows, error: null }
    if (data.length < pageSize) {
      if (expected !== null && rows.length !== expected) throw new Error('Incomplete report source')
      return { data: rows, error: null }
    }
  }
}

export function periodReportState(state, from, to) {
  return state?.from === from && state?.to === to
    ? state
    : { from, to, status: 'loading', data: null, error: '' }
}

export async function loadPeriodReport({ from, to, load, publish, isCurrent = () => true }) {
  if (isCurrent()) publish({ from, to, status: 'loading', data: null, error: '' })
  try {
    const result = await load()
    if (!result?.ok) throw new Error(result?.error || 'Laporan tidak tersedia')
    if (isCurrent()) publish({ from, to, status: 'ready', data: result, error: '' })
    return result
  } catch (error) {
    if (isCurrent()) publish({ from, to, status: 'error', data: null, error: error?.message || 'Laporan tidak tersedia' })
    return null
  }
}
