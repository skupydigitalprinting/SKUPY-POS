import assert from 'node:assert/strict'
import { before, after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import { createServer as httpServer } from 'node:http'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'
import { transform } from 'esbuild'
import { parseAst } from 'rollup/parseAst'

const root = fileURLToPath(new URL('../', import.meta.url))
const key = '__boundedReportsTest'
const day = '2026-09-11'
const realDate = Date, oldTZ = process.env.TZ, realFetch = globalThis.fetch
const ctx = { tables: {}, errors: {}, state: {}, calls: [] }
let vite, useAccounting, Dashboard, Accounting
const invoice = (overrides = {}) => ({ id: 't1', invoice_no: 'INV-1', created_at: `${day}T09:00:00+07:00`, total: 1000, paid: 600, remaining: 400, payment_method: 'cash', order_status: 'pending', status: 'pending', cashier_id: 'admin', deleted_at: null, ...overrides })
const payment = (overrides = {}) => ({ id: 'p1', invoice_no: 'INV-1', paid_at: `${day}T10:00:00+07:00`, amount: 300, payment_method: 'transfer', cashier_id: 'admin', notes: 'Receipt note', deleted_at: null, ...overrides })
function reset(tables = {}, errors = {}) { Object.assign(ctx, { tables, errors, state: {}, calls: [], captured: {}, stateWrites: {} }) }

// In-memory read transport only. Production callbacks and formulas execute unchanged.
function query(table) {
  const steps = []
  const q = { then(resolve, reject) {
    ctx.calls.push({ table, steps })
    try {
      const failure = typeof ctx.errors[table] === 'function' ? ctx.errors[table](steps) : ctx.errors[table]
      if (failure instanceof Error) throw failure
      if (failure) return Promise.resolve({ data: null, error: { message: failure } }).then(resolve, reject)
      let rows = structuredClone(ctx.tables[table] || [])
      let count
      for (const [method, col, value] of steps) {
        if (['eq', 'neq', 'is', 'in', 'gte', 'lt', 'lte'].includes(method)) rows = rows.filter(row => {
          const a = row[col]
          if (method === 'is') return a == null
          if (method === 'eq') return a === value
          if (method === 'neq') return a != null && a !== value
          if (method === 'in') return value.includes(a)
          if (a == null) return false
          const timestamp = ['created_at', 'paid_at', 'moved_at'].includes(col)
          const cast = v => new realDate(/T/.test(v) ? (/(Z|[+-]\d\d:\d\d)$/.test(v) ? v : `${v}Z`) : `${v}T00:00:00Z`).getTime()
          const left = timestamp ? cast(a) : a, right = timestamp ? cast(value) : value
          return method === 'gte' ? left >= right : method === 'lt' ? left < right : left <= right
        })
        if (method === 'range') { count = rows.length; rows = rows.slice(col, value + 1) }
        if (method === 'limit') { count = rows.length; rows = rows.slice(0, col) }
      }
      count ??= rows.length
      rows = rows.slice(0, 1000) // Supabase's default response cap.
      const select = steps.find(s => s[0] === 'select')?.[1]
      if (select && select !== '*') rows = rows.map(r => Object.fromEntries(select.split(',').map(s => s.trim()).map(k => [k, r[k]])))
      return Promise.resolve({ data: rows, error: null, count }).then(resolve, reject)
    } catch (error) { return Promise.reject(error).then(resolve, reject) }
  } }
  for (const method of ['select', 'eq', 'neq', 'is', 'in', 'gte', 'lt', 'lte', 'order', 'range', 'limit']) q[method] = (...args) => { steps.push([method, ...args]); return q }
  return q
}
before(async () => {
  process.env.TZ = 'Asia/Jakarta'
  globalThis.Date = class extends realDate {
    constructor(...args) { super(...(args.length ? args : [`${day}T12:00:00+07:00`])) }
    static now() { return new realDate(`${day}T12:00:00+07:00`).getTime() }
  }
  globalThis.fetch = () => { throw new Error('Network forbidden') }
  globalThis[key] = ctx
  ctx.client = { from: query, rpc: async name => ctx.errors[name] ? ({ data: null, error: { message: ctx.errors[name] } }) : ({ data: [{ cashier_id: 'admin', revenue: 1000, cash_in: 200, penjualan: 1000 }], error: null }) }
  vite = await createServer({ root, configFile: false, envFile: false,
    cacheDir: `/private/tmp/skupy-bounded-reports-${process.pid}`,
    server: { middlewareMode: true, hmr: { server: httpServer() }, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
    plugins: [{ name: 'bounded-reports-fixture', enforce: 'pre',
      resolveId(id) {
        if (/(^|\/)lib\/supabase(?:\.js)?$/.test(id)) return '\0report-client'
        if (id === '@supabase/supabase-js') throw new Error('Real SDK forbidden')
        const name = id.match(/(?:components\/(Toast|Confirm|InvoicePreview)|hooks\/(useCategories))(?:\.jsx?)?$/)
        if (name) return `\0report-${name[1] || name[2]}`
      },
      load(id) {
        if (id === '\0report-client') return `export const getDataClient = () => globalThis.${key}.client; export const secureAuthEnabled = false;`
        if (id === '\0report-Toast') return 'export const useToast = () => ({error() {}});'
        if (id === '\0report-Confirm') return 'export const useConfirm = () => () => { throw new Error("Mutation forbidden") };'
        if (id === '\0report-InvoicePreview') return 'export const useInvoicePreview = () => ({});'
        if (id === '\0report-useCategories') return 'export const useCategories = () => ({categories: []}); export const getCatLabel = x => x;'
      },
      async transform(code, id) {
        if (!/\/src\/pages\/(Dashboard|Accounting)\.jsx$/.test(id)) return
        const name = id.endsWith('/Accounting.jsx') ? 'Accounting' : 'Dashboard'
        const js = (await transform(code, { loader: 'jsx', jsx: 'automatic' })).code
        const fn = parseAst(js).body.map(n => n.declaration).find(n => n?.id?.name === name)
        const edits = []
        for (const stmt of fn.body.body) for (const d of stmt.declarations || []) {
          if (d.id.type !== 'ArrayPattern' || d.init?.callee?.name !== 'useState') continue
          const name = d.id.elements[0].name, a = d.init.arguments[0]
          edits.push({ start: a.start, end: a.end, text: `(Object.hasOwn(globalThis.${key}.state, '${name}') ? globalThis.${key}.state.${name} : (${js.slice(a.start, a.end)}))` })
          if (name === 'pengOut') {
            const setter = d.id.elements[1]
            edits.push({ start: setter.start, end: setter.end, text: '_setPengOut' })
            edits.push({ start: stmt.end, end: stmt.end, text: `const setPengOut = value => { globalThis.${key}.lastOutflowWrite = value; _setPengOut(value); };` })
          }
          if (name === 'labaReport') {
            const setter = d.id.elements[1]
            edits.push({ start: setter.start, end: setter.end, text: '_setLabaReport' })
            edits.push({ start: stmt.end, end: stmt.end, text: `const setLabaReport = value => { globalThis.${key}.lastLabaWrite = value; _setLabaReport(value); };` })
          }
          if (['d', 'dPeriod', 'loadError'].includes(name)) {
            const setter = d.id.elements[1]
            const setterName = js.slice(setter.start, setter.end)
            edits.push({ start: setter.start, end: setter.end, text: `_${setterName}` })
            edits.push({ start: stmt.end, end: stmt.end, text: `const ${setterName} = value => { globalThis.${key}.stateWrites.${name} = value; _${setterName}(value); };` })
          }
        }
        const ret = fn.body.body.find(n => n.type === 'ReturnStatement')
        const fields = name === 'Dashboard' ? 'uangMasuk, labaRugi, adminPerformance, filteredTrx, piutangData, buildCard, loadLabaReport: typeof loadLabaReport === "function" ? loadLabaReport : null' : 'totalCashIn, totalCashOut, netCashFlow, ukBasis, laba, openDetail, loadDashboard'
        edits.push({ start: ret.start, end: ret.start, text: `globalThis.${key}.captured = { ${fields} };` })
        let output = js
        for (const e of edits.sort((a, b) => b.start - a.start)) output = output.slice(0, e.start) + e.text + output.slice(e.end)
        return { code: output, map: null }
      },
    }],
  })
  useAccounting = (await vite.ssrLoadModule('/src/hooks/useAccounting.js')).useAccounting
  Dashboard = (await vite.ssrLoadModule('/src/pages/Dashboard.jsx')).default
  Accounting = (await vite.ssrLoadModule('/src/pages/Accounting.jsx')).default
})
after(async () => {
  await vite?.close()
  globalThis.Date = realDate; globalThis.fetch = realFetch; delete globalThis[key]
  if (oldTZ === undefined) delete process.env.TZ; else process.env.TZ = oldTZ
})
function invoke(fn, props) { let result; function Capture() { result = fn(props); return null } renderToStaticMarkup(React.createElement(Capture)); return result }
function dashboard(rows = [], payments = [], state = {}, debts = []) {
  ctx.state = state
  const transactions = rows.map(r => ({ ...r, date: r.created_at, invoiceNo: r.invoice_no, orderStatus: r.order_status, paymentMethod: r.payment_method, cashierId: r.cashier_id, items: [] }))
  const tree = invoke(Dashboard, { transactions, debtPayments: payments, debts, admins: [{ id: 'admin' }], currentUser: { role: 'owner' }, stats: { chartData: [], todayTrx: [], topProducts: [] }, storeInfo: {} })
  assert.ok(React.isValidElement(tree))
  return ctx.captured
}

test('Dashboard subtracts all matching events once, including a same-time initial split', () => {
  reset()
  const rows = [invoice({ paid: 600 })]
  const payments = [payment({ paid_at: rows[0].created_at }), payment({ id: 'q', amount: 100, payment_method: 'qris' })]
  const d = dashboard(rows, payments)
  assert.deepEqual(d.uangMasuk, { total: 600, cash: 200, transfer: 300, qris: 100, cicilan: 400 })
  for (const method of ['cash', 'transfer', 'qris']) {
    const card = d.buildCard(method)
    assert.equal(card.rows.reduce((s, r) => s + r.paid, 0), card.total)
  }
})
test('cancelled unrefunded receipts remain while invoice turnover and pending stay excluded', async () => {
  const row = invoice({ order_status: 'dibatalkan' })
  reset({ transactions: [row], debt_payments: [payment()] })
  const d = dashboard([row], [payment()])
  assert.equal(d.uangMasuk.total, 600)
  assert.equal(d.labaRugi.revenue, 0)
  assert.equal(d.buildCard('uangMasuk').rows[0].paid, 600)
  const cf = await invoke(useAccounting).getCashflowDetail(day, day)
  assert.equal(cf.totalMasuk, 600)
  assert.equal(cf.pending.length, 0)
})
test('Dashboard includes the full selected end day and bounds admin month/today', () => {
  reset()
  const late = invoice({ created_at: `${day}T23:59:59.999+07:00` })
  const tomorrow = invoice({ id: 'future', created_at: '2026-09-12T00:00:00+07:00' })
  const d = dashboard([late, tomorrow], [], { dateFrom: day, dateTo: day })
  assert.equal(d.labaRugi.revenue, 1000)
  assert.equal(d.filteredTrx.length, 1)
  assert.equal(d.adminPerformance[0].omzetToday, 1000)
  assert.equal(d.adminPerformance[0].omzetMonth, 1000)
  assert.equal(d.buildCard('omzetMonth').total, 1000)
})
test('cashflow and book turnover include WIB dawn and fractional end, excluding next midnight', async () => {
  reset({ transactions: ['00:00:00', '23:59:59.999'].map((time, i) => invoice({ id: String(i), invoice_no: String(i), paid: 200, created_at: `${day}T${time}+07:00` })).concat(invoice({ created_at: '2026-09-12T00:00:00+07:00' })) })
  const acc = invoke(useAccounting)
  assert.equal((await acc.getCashflowDetail(day, day)).totalMasuk, 400)
  assert.equal(await acc.sumOmsetByBook({ from: day, to: day }), 2000)
})
test('future installment does not move the initial tender to a different period', async () => {
  reset({ transactions: [invoice()], debt_payments: [payment({ paid_at: '2026-09-12T00:00:00+07:00' })] })
  const acc = invoke(useAccounting)
  assert.equal((await acc.getCashflowDetail(day, day)).totalMasuk, 300)
  assert.equal((await acc.getCashflowDetail('2026-09-12', '2026-09-12')).totalMasuk, 300)
})
test('cashflow uses only exported debt payment columns and preserves notes', async () => {
  reset({ debt_payments: [payment()] })
  const cf = await invoke(useAccounting).getCashflowDetail(day, day)
  assert.equal(cf.masuk[0].note, 'Receipt note')
  const manifest = JSON.parse(await readFile(new URL('../tools/security-lab/business-manifest.json', import.meta.url)))
  const known = new Set(manifest.tables.find(t => t.name === 'debt_payments').columns.map(c => c.name))
  for (const call of ctx.calls.filter(c => c.table === 'debt_payments')) for (const step of call.steps.filter(s => s[0] === 'select')) {
    assert.deepEqual(step[1].split(',').map(s => s.trim()).filter(c => !known.has(c)), [])
  }
})
for (const source of ['transactions', 'debt_payments', 'credibook_income', 'migration_details', 'employee_cash_advance_payments', 'asset_sales', 'expenses', 'purchases', 'supplier_debt_payments', 'bank_loan_payments', 'employee_cash_advances', 'prepaid_rents', 'asset_purchase_payments']) {
  test(`cashflow fails closed when ${source} is unavailable`, async () => {
    reset({ transactions: [invoice()] }, { [source]: 'Synthetic unavailable source' })
    const cf = await invoke(useAccounting).getCashflowDetail(day, day)
    assert.equal(cf.ok, false)
    assert.deepEqual(cf.masuk, [])
    assert.equal(cf.totalMasuk, 0)
  })
}
for (const source of ['credibook_income', 'migration_details', 'debt_payments']) test(`recap fails closed for ${source}`, async () => {
  reset({}, { [source]: 'Synthetic source failed' })
  const r = await invoke(useAccounting).getRecapAdmin(day, day)
  assert.equal(r.ok, false)
  assert.deepEqual(r.data, [])
})
test('outflow failure does not return partial totals', async () => {
  reset({ expenses: [{ id: 'e', expense_date: day, amount: 100 }] }, { purchases: 'Synthetic failed' })
  const r = await invoke(useAccounting).getOutflowTransactions(day, day)
  assert.equal(r.ok, false)
  assert.deepEqual(r.rows, [])
})
test('capital and loan migration receipts retain financing classification and date scope', async () => {
  reset({ migration_details: [
    { id: 'a', type: 'modal', trx_date: day, amount: 400 },
    { id: 'b', type: 'loan_cash', trx_date: day, amount: 600 },
    { id: 'c', type: 'old_income', trx_date: day, amount: 100 },
    { id: 'd', type: 'modal', trx_date: '2026-09-12', amount: 999 },
    { id: 'e', type: 'modal', trx_date: day, amount: 999, deleted_at: day },
  ] })
  const cf = await invoke(useAccounting).getCashflowDetail(day, day)
  assert.equal(cf.totalMasuk, 1100)
  assert.equal(cf.activities.financing.cashIn, 1000)
  assert.equal(cf.activities.operating.cashIn, 100)
  assert.equal(Object.values(cf.activities).reduce((s, a) => s + a.net, 0), cf.net)
})
test('diagnostic receivables exclude deleted and clamp overpayment', async () => {
  reset({ debts: [{ id: 'a', total_debt: 100, paid: 20 }, { id: 'b', total_debt: 99, deleted_at: day }, { id: 'c', total_debt: 10, paid: 20 }] })
  assert.equal((await invoke(useAccounting).getPiutangAktif()).value, 80)
})
test('aggregate reads retrieve more than 1000 rows, including all matching installments', async () => {
  const payments = Array.from({ length: 1205 }, (_, i) => payment({ id: `p${i}`, amount: 1 }))
  reset({ transactions: [invoice({ paid: 1405 })], debt_payments: payments })
  const cf = await invoke(useAccounting).getCashflowDetail(day, day)
  assert.equal(cf.totalMasuk, 1405)
  assert.equal(cf.masuk.find(r => r.source === 'Penjualan').amount, 200)
  assert.equal(cf.masuk.filter(r => r.source === 'Pembayaran Piutang').length, 1205)
})
test('a later page failure invalidates the whole cashflow', async () => {
  reset({ debt_payments: Array.from({ length: 1205 }, (_, i) => payment({ id: `p${i}` })) }, {
    debt_payments: steps => steps.some(s => s[0] === 'range' && s[1] >= 500) ? 'Later page failed' : null,
  })
  const cf = await invoke(useAccounting).getCashflowDetail(day, day)
  assert.equal(cf.ok, false)
  assert.equal(cf.totalMasuk, 0)
})
test('all cashflow source columns match exported schema and retain employee/rent notes', async () => {
  reset({
    employee_cash_advances: [{ id: 'a', advance_date: day, amount: 100, employee_name: 'Synthetic', notes: 'Advance', is_opening: false }],
    employee_cash_advance_payments: [{ id: 'p', cash_advance_id: 'a', payment_date: day, amount: 20, notes: 'Repayment' }],
    prepaid_rents: [{ id: 'r', payment_date: day, total_amount: 50, notes: 'Rent' }],
  })
  const cf = await invoke(useAccounting).getCashflowDetail(day, day)
  const manifest = JSON.parse(await readFile(new URL('../tools/security-lab/business-manifest.json', import.meta.url)))
  for (const call of ctx.calls) {
    const known = new Set(manifest.tables.find(t => t.name === call.table).columns.map(c => c.name))
    for (const step of call.steps.filter(s => s[0] === 'select')) {
      assert.deepEqual(step[1].split(',').map(s => s.trim()).filter(c => !known.has(c)), [], call.table)
    }
  }
  assert.equal(cf.masuk[0].ref, 'Synthetic')
  assert.equal(cf.masuk[0].note, 'Repayment')
  assert.equal(cf.keluar.find(r => r.source === 'Kasbon Karyawan').note, 'Advance')
  assert.equal(cf.keluar.find(r => r.source === 'Sewa Dibayar Dimuka').note, 'Rent')
})
test('card detail debt payment select also uses the supported notes column', async () => {
  reset({ debt_payments: [payment()] })
  const r = await invoke(useAccounting).getCardDetail('uang_masuk', day, day)
  assert.equal(r.rows.find(r => r.kind === 'debt_payment').note, 'Receipt note')
})
test('book turnover aggregates all pages instead of treating the server cap as a total', async () => {
  reset({ transactions: Array.from({ length: 1205 }, (_, i) => invoice({ id: `t${i}`, total: 1 })) })
  assert.equal(await invoke(useAccounting).sumOmsetByBook({ from: day, to: day }), 1205)
})
function accountingState(state) {
  ctx.state = { from: day, to: day, dPeriod: `${day}|${day}`, d: { penjualan: 1000, uang_masuk_total: 999, pengeluaran_total: 888 }, ...state }
  const tree = invoke(Accounting, { currentUser: { role: 'owner' } })
  return { ...ctx.captured, html: renderToStaticMarkup(tree) }
}
test('Accounting rejects unkeyed and previous-period cashflow instead of RPC fallback', () => {
  reset()
  for (const cashflowSummary of [null, { totalMasuk: 500, totalKeluar: 200 }, { from: '2026-09-10', to: '2026-09-10', status: 'ready', data: { totalMasuk: 500, totalKeluar: 200 } }]) {
    const a = accountingState({ cashflowSummary })
    assert.deepEqual([a.totalCashIn, a.totalCashOut, a.netCashFlow], [null, null, null])
    assert.match(a.html, /Memuat/)
  }
})
test('Accounting failed current-period reads display unavailable, not stale or RPC totals', () => {
  reset()
  const failed = { from: day, to: day, status: 'error', error: 'Synthetic failure', data: null }
  const a = accountingState({ cashflowSummary: failed, pengOut: failed })
  assert.deepEqual([a.totalCashIn, a.totalCashOut, a.netCashFlow, a.ukBasis, a.laba], [null, null, null, null, null])
  assert.match(a.html, /Tidak tersedia/)
})
test('Accounting current-period ready totals preserve zero and the existing profit formula', () => {
  reset()
  for (const amount of [0, 500]) {
    const a = accountingState({ cashflowSummary: { from: day, to: day, status: 'ready', data: { totalMasuk: amount, totalKeluar: 0 } }, pengOut: { from: day, to: day, status: 'ready', data: { total: 100 } } })
    assert.deepEqual([a.totalCashIn, a.totalCashOut, a.netCashFlow, a.laba], [amount, 0, amount, 900])
  }
})
test('Accounting detail refresh retains the keyed outflow state contract', async () => {
  reset({ expenses: [{ id: 'e', expense_date: day, amount: 100 }] })
  const a = accountingState({})
  await a.openDetail('uang_keluar', 'Pengeluaran', 'red')
  assert.equal(ctx.lastOutflowWrite.from, day)
  assert.equal(ctx.lastOutflowWrite.to, day)
  assert.equal(ctx.lastOutflowWrite.status, 'ready')
  assert.equal(ctx.lastOutflowWrite.data.total, 100)
})
test('Dashboard never mixes prior-period server revenue/count/expense with a new period', () => {
  reset()
  const d = dashboard([invoice()], [], { labaFrom: day, labaTo: day, omsetAcc: 900, omsetCount: 9, pengeluaranAcc: 700,
    labaReport: { from: '2026-09-10', to: '2026-09-10', status: 'ready', data: { revenue: 900, count: 9, expenses: 700 } },
  })
  assert.deepEqual([d.labaRugi.revenue, d.labaRugi.count, d.labaRugi.pengeluaran, d.labaRugi.profit], [null, null, null, null])
})
for (const source of ['acc_dashboard', 'transactions', 'expenses']) test(`Dashboard failed ${source} read publishes unavailable for the requested period`, async () => {
  reset({ transactions: [invoice()], expenses: [{ id: 'e', expense_date: day, amount: 100 }] }, { [source]: 'Synthetic unavailable' })
  const state = { labaFrom: day, labaTo: day }
  const d = dashboard([invoice()], [], state)
  assert.equal(typeof d.loadLabaReport, 'function')
  await d.loadLabaReport()
  assert.equal(ctx.lastLabaWrite.status, 'error')
  assert.equal(ctx.lastLabaWrite.from, day)
  assert.equal(ctx.lastLabaWrite.to, day)
  const rerender = dashboard([invoice()], [], { ...state, labaReport: ctx.lastLabaWrite })
  assert.deepEqual([rerender.labaRugi.revenue, rerender.labaRugi.count, rerender.labaRugi.pengeluaran, rerender.labaRugi.profit], [null, null, null, null])
})
test('Dashboard publishes current-period revenue/count/expense together after complete reads', async () => {
  reset({ transactions: [invoice()], expenses: [{ id: 'e', expense_date: day, amount: 100 }] })
  const state = { labaFrom: day, labaTo: day }
  await dashboard([invoice()], [], state).loadLabaReport()
  assert.equal(ctx.lastLabaWrite.status, 'ready')
  const d = dashboard([invoice()], [], { ...state, labaReport: ctx.lastLabaWrite })
  assert.deepEqual([d.labaRugi.revenue, d.labaRugi.count, d.labaRugi.pengeluaran, d.labaRugi.profit], [1000, 1, 100, 900])
})
test('Accounting does not calculate profit from old RPC revenue and fresh outflow', () => {
  reset()
  const a = accountingState({ dPeriod: '2026-09-10|2026-09-10', pengOut: { from: day, to: day, status: 'ready', data: { total: 100 } } })
  assert.equal(a.laba, null)
})
test('Accounting RPC failure clears previous revenue and displays a load error', async () => {
  reset({}, { acc_dashboard: 'Synthetic RPC failed' })
  await accountingState({}).loadDashboard()
  assert.equal(ctx.stateWrites.d, null)
  assert.equal(ctx.stateWrites.dPeriod, null)
  assert.match(ctx.stateWrites.loadError, /Synthetic RPC failed/)
})
