// Run from any directory: node --test /path/to/SKUPY-POS/tools/financial-audit/reports.test.js
// Synthetic reporting audit ONLY. No .env, sockets, real data client, effects,
// browser, mutations, SQL, or deployment. Outside package.json's test glob.
// Legacy auth mode (secureAuthEnabled=false), matching the reported runtime.
// Actual hooks/components load through Vite SSR. AST instrumentation only
// supplies useState inputs and observes locals; reporting formulas stay intact.
// The query double models UTC timestamptz casts for bare date bounds. It is not
// a PostgreSQL/RLS/RPC integration test. RPC results are explicit fixtures.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer as createHttpServer } from 'node:http'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'
import { transform } from 'esbuild'
import { parseAst } from 'rollup/parseAst'

const root = fileURLToPath(new URL('../../', import.meta.url))
const realDate = Date
const realFetch = globalThis.fetch
const oldTZ = process.env.TZ
const key = '__skupyFinancialReportsAudit'
let vite, modules
const context = { state: {}, captured: {}, tables: {}, rpc: {}, errors: {}, calls: [] }
const day = '2026-09-11'
const now = `${day}T12:00:00+07:00`
const parent = (overrides = {}) => ({
  id: 'synthetic-invoice', invoice_no: 'SYN-001', customer: 'Synthetic only',
  created_at: `${day}T09:00:00+07:00`, total: 1000000, paid: 500000,
  remaining: 500000, payment_method: 'cash', cashier_id: 'synthetic-a',
  order_status: 'pending', status: 'pending', deleted_at: null, book_id: 'synthetic-book',
  ...overrides,
})
const payment = (overrides = {}) => ({
  id: 'synthetic-payment', invoice_no: 'SYN-001', amount: 300000,
  paid_at: `${day}T10:00:00+07:00`, payment_method: 'transfer',
  cashier_id: 'synthetic-b', deleted_at: null, ...overrides,
})
const trx = (row = parent()) => ({
  ...row, date: row.created_at, invoiceNo: row.invoice_no,
  orderStatus: row.order_status, paymentMethod: row.payment_method,
  cashierId: row.cashier_id, items: [],
})

function reset(tables = {}, rpc = {}, errors = {}) {
  Object.assign(context, { state: {}, captured: {}, tables, rpc, errors, calls: [] })
}

// Only read queries are supported. Unsupported calls throw; no real transport.
function query(table) {
  const steps = []
  const q = { then(resolve, reject) {
    context.calls.push({ table, steps })
    try {
      if (context.errors[table]) return Promise.resolve({ data: null, error: { message: context.errors[table] } }).then(resolve, reject)
      let rows = structuredClone(context.tables[table] || [])
      for (const [method, col, value] of steps) {
        if (['eq', 'neq', 'is', 'in', 'gte', 'lte', 'gt', 'lt'].includes(method)) {
          rows = rows.filter(row => {
            const a = row[col]
            if (method === 'is') return value === null ? a == null : a === value
            if (a == null) return false
            if (method === 'eq') return a === value
            if (method === 'neq') return a !== value
            if (method === 'in') return value.includes(a)
            const timestamp = ['created_at', 'paid_at'].includes(col)
            const cast = v => /T/.test(String(v))
              ? new realDate(/(?:Z|[+-]\d\d:\d\d)$/.test(v) ? v : `${v}Z`).getTime()
              : new realDate(`${v}T00:00:00Z`).getTime()
            const left = timestamp ? cast(a) : a
            const right = timestamp ? cast(value) : value
            return method === 'gte' ? left >= right : method === 'lte' ? left <= right : method === 'gt' ? left > right : left < right
          })
        }
        if (method === 'limit') rows = rows.slice(0, col)
        if (method === 'range') rows = rows.slice(col, value + 1)
      }
      const count = rows.length
      const select = steps.find(s => s[0] === 'select')?.[1]
      if (select && select !== '*') rows = rows.map(row => Object.fromEntries(select.split(',').map(col => col.trim()).map(col => [col, row[col]])))
      return Promise.resolve({ data: rows, error: null, count }).then(resolve, reject)
    } catch (error) { return Promise.reject(error).then(resolve, reject) }
  } }
  for (const method of ['select', 'eq', 'neq', 'is', 'in', 'gte', 'lte', 'gt', 'lt', 'order', 'limit', 'range']) {
    q[method] = (...args) => { steps.push([method, ...args]); return q }
  }
  return q
}

const observations = {
  Dashboard: ['uangMasuk', 'labaRugi', 'adminPerformance', 'piutangData'],
  Accounting: ['ukBasis', 'laba', 'totalCashIn', 'totalCashOut', 'netCashFlow', 'totalHutang', 'rentAgg'],
}

before(async () => {
  process.env.TZ = 'Asia/Jakarta'
  globalThis.Date = class extends realDate {
    constructor(...args) { super(...(args.length ? args : [now])) }
    static now() { return new realDate(now).getTime() }
  }
  globalThis.fetch = () => { throw new Error('Network forbidden in financial audit') }
  globalThis[key] = context
  context.client = {
    from: query,
    rpc: async (name, params) => {
      context.calls.push({ rpc: name, params })
      if (!Object.hasOwn(context.rpc, name)) throw new Error(`Unscripted RPC forbidden: ${name}`)
      return structuredClone(context.rpc[name])
    },
  }
  vite = await createServer({
    root, configFile: false, envFile: false,
    cacheDir: `/private/tmp/skupy-financial-reports-${process.pid}`,
    server: { middlewareMode: true, hmr: { server: createHttpServer() }, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
    plugins: [{
      name: 'synthetic-financial-report-boundaries', enforce: 'pre',
      resolveId(id) {
        if (/(^|\/)lib\/supabase(?:\.js)?$/.test(id)) return '\0reports-data'
        if (id === '@supabase/supabase-js') throw new Error('Real data SDK forbidden')
        const match = id.match(/(?:components\/(Toast|Confirm|InvoicePreview)|hooks\/(useCategories))(?:\.jsx?)?$/)
        if (match) return `\0reports-${match[1] || match[2]}`
      },
      load(id) {
        if (id === '\0reports-data') return `
          export const getDataClient = () => globalThis.${key}.client;
          export const secureAuthEnabled = false;
          export const isSupabaseConfigured = false;
          export const uploadLogo = () => { throw new Error('Upload forbidden') };
          export const deleteLogo = uploadLogo;
        `
        if (id === '\0reports-Toast') return 'export const useToast = () => ({});'
        if (id === '\0reports-Confirm') return 'export const useConfirm = () => () => { throw new Error("Mutation forbidden") };'
        if (id === '\0reports-InvoicePreview') return 'export const useInvoicePreview = () => ({});'
        if (id === '\0reports-useCategories') return 'export const useCategories = () => ({categories: []}); export const getCatLabel = x => x;'
      },
      async transform(code, id) {
        if (!/\/src\/(?:hooks\/useStore\.js|pages\/(?:Dashboard|Accounting)\.jsx)$/.test(id)) return
        const js = (await transform(code, { loader: id.endsWith('.jsx') ? 'jsx' : 'js', jsx: 'automatic', target: 'esnext' })).code
        const ast = parseAst(js)
        const fn = ast.body.map(n => n.declaration).find(n => n?.type === 'FunctionDeclaration' && ['useStore', 'Dashboard', 'Accounting'].includes(n.id?.name))
        assert.ok(fn, `AST component/hook missing: ${id}`)
        const name = fn.id.name
        const edits = []
        for (const stmt of fn.body.body) {
          if (stmt.type !== 'VariableDeclaration') continue
          for (const decl of stmt.declarations) {
            if (decl.id.type !== 'ArrayPattern' || decl.init?.callee?.name !== 'useState') continue
            const state = decl.id.elements[0].name
            const arg = decl.init.arguments[0]
            assert.ok(arg, `No initializer for ${name}.${state}`)
            edits.push({ start: arg.start, end: arg.end, text: `(Object.hasOwn(globalThis.${key}.state.${name} || {}, '${state}') ? globalThis.${key}.state.${name}.${state} : (${js.slice(arg.start, arg.end)}))` })
          }
        }
        if (observations[name]) {
          const ret = fn.body.body.find(n => n.type === 'ReturnStatement')
          assert.ok(ret, `No component return: ${name}`)
          edits.push({ start: ret.start, end: ret.start, text: `globalThis.${key}.captured = {${observations[name].join(',')}};\n` })
        }
        let output = js
        for (const edit of edits.sort((a, b) => b.start - a.start)) output = output.slice(0, edit.start) + edit.text + output.slice(edit.end)
        return { code: output, map: null }
      },
    }],
  })
  modules = {
    store: (await vite.ssrLoadModule('/src/hooks/useStore.js')).useStore,
    accounting: (await vite.ssrLoadModule('/src/hooks/useAccounting.js')).useAccounting,
    Dashboard: (await vite.ssrLoadModule('/src/pages/Dashboard.jsx')).default,
    Accounting: (await vite.ssrLoadModule('/src/pages/Accounting.jsx')).default,
  }
})

after(async () => {
  try { await vite?.close() } finally {
    globalThis.Date = realDate
    globalThis.fetch = realFetch
    delete globalThis[key]
    if (oldTZ === undefined) delete process.env.TZ
    else process.env.TZ = oldTZ
  }
})

function invoke(fn, props) {
  let value
  function Capture() { value = fn(props); return null }
  renderToStaticMarkup(React.createElement(Capture))
  return value
}
function stats(rows) {
  context.state.useStore = { transactions: rows }
  return invoke(modules.store, { user: { id: 'synthetic-owner', role: 'owner' } }).stats
}
function dashboard(rows = [], payments = [], state = {}) {
  const value = stats(rows)
  context.state.Dashboard = state
  const tree = invoke(modules.Dashboard, {
    stats: value, transactions: rows, debtPayments: payments,
    admins: [{ id: 'synthetic-a', name: 'Synthetic A' }],
    currentUser: { role: 'owner' }, storeInfo: {}, products: [], debts: [],
  })
  assert.ok(React.isValidElement(tree), 'Actual Dashboard must produce a React tree')
  return context.captured
}
function accounting(state) {
  context.state.Accounting = state
  const tree = invoke(modules.Accounting, { currentUser: { role: 'owner' } })
  assert.ok(React.isValidElement(tree), 'Actual Accounting must produce a React tree')
  return context.captured
}
function check(t, label, actual, expected) {
  t.diagnostic(`${label}: expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`)
  assert.deepEqual(actual, expected, label)
}

test('control: invoice omzet includes DP/unpaid balance, excludes cancelled [useStore:2193]', t => {
  reset()
  const s = stats([trx(), trx(parent({ id: 'cancel', total: 700000, order_status: 'dibatalkan' }))])
  check(t, 'total/today/month omzet', [s.totalOmzet, s.todayOmzet, s.monthOmzet], [1000000, 1000000, 1000000])
})
test('weekly chart must include valid DP invoice [useStore:2217]', t => {
  reset()
  check(t, 'today chart omzet', stats([trx()]).chartData.at(-1).omzet, 1000000)
})
test('weekly chart must exclude cancelled paid invoice [useStore:2217]', t => {
  reset()
  check(t, 'cancelled chart omzet', stats([trx(parent({ status: 'lunas', order_status: 'dibatalkan', paid: 1000000, remaining: 0 }))]).chartData.at(-1).omzet, 0)
})
test('month omzet must not include next calendar month [useStore:2176]', t => {
  reset()
  check(t, 'September omzet', stats([trx(), trx(parent({ created_at: '2026-10-01T12:00:00+07:00' }))]).monthOmzet, 1000000)
})
test('control: headline receipts count cumulative paid once [Dashboard:149]', t => {
  reset()
  check(t, 'DP 200000 + transfer installment 300000', dashboard([trx()], [payment()]).uangMasuk.total, 500000)
})
test('mixed methods must reconcile DP cash + transfer + QRIS [Dashboard:153,161]', t => {
  reset()
  const u = dashboard([trx(parent({ paid: 600000, remaining: 400000 }))], [payment(), payment({ id: 'qris', amount: 100000, payment_method: 'qris' })]).uangMasuk
  check(t, 'cash/transfer/qris/total', [u.cash, u.transfer, u.qris, u.total], [200000, 300000, 100000, 600000])
})
test('cancellation without refund must preserve cash received [Dashboard:148]', t => {
  reset()
  const u = dashboard([trx(parent({ order_status: 'dibatalkan' }))], [payment()]).uangMasuk
  check(t, 'unrefunded total/method sum', [u.total, u.cash + u.transfer + u.qris], [500000, 500000])
})
test('control: fallback period revenue includes pending and excludes cancelled [Dashboard:358]', t => {
  reset()
  const d = dashboard([trx(), trx(parent({ order_status: 'dibatalkan' }))])
  check(t, 'period invoice revenue', d.labaRugi.revenue, 1000000)
})
test('Dashboard end date includes final fractional second [Dashboard:366]', t => {
  reset()
  check(t, '23:59:59.500 WIB invoice', dashboard([trx(parent({ created_at: `${day}T23:59:59.500+07:00` }))]).labaRugi.revenue, 1000000)
})
test('admin today excludes tomorrow [Dashboard:446]', t => {
  reset()
  check(t, 'admin omzetToday', dashboard([trx(), trx(parent({ created_at: '2026-09-12T10:00:00+07:00' }))]).adminPerformance[0].omzetToday, 1000000)
})
test('control: cashflow reconstructs DP and mixed methods once [useAccounting:649]', async t => {
  reset({ transactions: [parent()], debt_payments: [payment()] })
  const cf = await invoke(modules.accounting).getCashflowDetail(day, day)
  check(t, 'in/out/net', [cf.totalMasuk, cf.totalKeluar, cf.net], [500000, 0, 500000])
  check(t, 'cash DP and transfer installment', cf.masuk.map(r => [r.method, r.amount]).sort(), [['cash', 200000], ['transfer', 300000]])
  check(t, 'unreceived balance stays outside receipts', cf.pending[0].amount, 500000)
})
test('control: later installment does not move prior-period DP [useAccounting:639]', async t => {
  reset({ transactions: [parent()], debt_payments: [payment({ paid_at: '2026-09-12T10:00:00+07:00' })] })
  const acc = invoke(modules.accounting)
  const first = await acc.getCashflowDetail(day, day)
  const second = await acc.getCashflowDetail('2026-09-12', '2026-09-12')
  check(t, 'day1/day2 receipts', [first.totalMasuk, second.totalMasuk], [200000, 300000])
})
test('cashflow preserves DP and installment when cancelled without refund [useAccounting:647]', async t => {
  reset({ transactions: [parent({ order_status: 'dibatalkan' })], debt_payments: [payment()] })
  check(t, 'unrefunded receipts', (await invoke(modules.accounting).getCashflowDetail(day, day)).totalMasuk, 500000)
})
test('cashflow includes final fractional second [useAccounting:632]', async t => {
  reset({ transactions: [parent({ paid: 200000, created_at: `${day}T23:59:59.500+07:00` })] })
  check(t, 'end-of-day receipt', (await invoke(modules.accounting).getCashflowDetail(day, day)).totalMasuk, 200000)
})
test('book omzet uses WIB day bounds (UTC cast model) [useAccounting:1203]', async t => {
  reset({ transactions: [parent({ created_at: `${day}T00:30:00+07:00` })] })
  check(t, '00:30 WIB invoice omzet', await invoke(modules.accounting).sumOmsetByBook({ from: day, to: day, bookId: 'synthetic-book' }), 1000000)
})
test('active receivables exclude deleted balances [useAccounting:69]', async t => {
  reset({ debts: [
    { total_debt: 1000000, paid: 200000, deleted_at: null },
    { total_debt: 500000, paid: 0, deleted_at: now },
  ] })
  check(t, 'active balance', (await invoke(modules.accounting).getPiutangAktif()).value, 800000)
})
test('control: book receivable sum excludes deleted and clamps overpaid [useAccounting:1217]', async t => {
  reset({ debts: [
    { total_debt: 1000000, paid: 200000, deleted_at: null },
    { total_debt: 500000, paid: 0, deleted_at: now },
    { total_debt: 100, paid: 200, deleted_at: null },
  ] })
  check(t, 'book balance', await invoke(modules.accounting).sumPiutangByBook(), 800000)
})
test('control: admin POS + manual + migration + installments reconcile [useAccounting:404]', async t => {
  reset({
    credibook_income: [{ amount: 100000, income_type: 'omzet', created_by: 'synthetic-a', transaction_date: day }, { amount: 50000, income_type: 'capital', created_by: null, transaction_date: day }],
    migration_details: [{ amount: 70000, type: 'old_income', cashier_id: 'synthetic-b', trx_date: day }],
    debt_payments: [payment()],
  }, { acc_recap_admin: { data: [{ cashier_id: 'synthetic-a', revenue: 1000000, cash_in: 200000 }], error: null } })
  const r = await invoke(modules.accounting).getRecapAdmin(day, day)
  check(t, 'revenue/cash_in totals (RPC POS initial receipts fixture)', r.data.reduce((s, x) => [s[0] + x.revenue, s[1] + x.cash_in], [0, 0]), [1170000, 720000])
  check(t, 'unassigned receipt preserved', r.data.find(x => x.cashier_id === null).cash_in, 50000)
})
test('admin recap must flag unavailable supplementary totals [useAccounting:425]', async t => {
  reset({}, { acc_recap_admin: { data: [{ cashier_id: 'synthetic-a', revenue: 1000000, cash_in: 200000 }], error: null } }, { debt_payments: 'Synthetic read failed' })
  check(t, 'success flag for incomplete recap', Number((await invoke(modules.accounting).getRecapAdmin(day, day)).ok), 0)
})
test('cashflow must flag unavailable source totals [useAccounting:638,716]', async t => {
  reset({}, {}, { transactions: 'Synthetic read failed' })
  check(t, 'success flag for incomplete cashflow', Number((await invoke(modules.accounting).getCashflowDetail(day, day)).ok), 0)
})
test('capital deposits and loan proceeds appear in financing receipts [useAccounting:673]', async t => {
  reset({ migration_details: [
    { id: 'capital', type: 'modal', amount: 400000, method: 'cash', trx_date: day },
    { id: 'loan', type: 'loan_cash', amount: 600000, method: 'transfer', trx_date: day },
  ] })
  const cf = await invoke(modules.accounting).getCashflowDetail(day, day)
  check(t, 'total receipts/financing receipts', [cf.totalMasuk, cf.activities.financing.cashIn], [1000000, 1000000])
})
test('control: Accounting consumes actual cashflow totals [Accounting:669]', t => {
  reset()
  const a = accounting({ from: day, to: day, dPeriod: `${day}|${day}`, d: { penjualan: 1000000, uang_masuk_total: 999999, pengeluaran_total: 888888 }, pengOut: { from: day, to: day, status: 'ready', data: { total: 100000 } }, cashflowSummary: { from: day, to: day, status: 'ready', data: { totalMasuk: 500000, totalKeluar: 200000 } } })
  check(t, 'cash in/out/net', [a.totalCashIn, a.totalCashOut, a.netCashFlow], [500000, 200000, 300000])
  check(t, 'displayed profit formula, not accounting-standard compliance', a.laba, 900000)
})
test('control: Accounting cashflow zero is not replaced by stale RPC [Accounting:669]', t => {
  reset()
  const a = accounting({ from: day, to: day, dPeriod: `${day}|${day}`, d: { penjualan: 1000000, uang_masuk_total: 999999, pengeluaran_total: 888888 }, cashflowSummary: { from: day, to: day, status: 'ready', data: { totalMasuk: 0, totalKeluar: 0 } } })
  check(t, 'empty-period actual cash', [a.totalCashIn, a.totalCashOut, a.netCashFlow], [0, 0, 0])
})
test('control: Accounting bank + supplier + asset liabilities [Accounting:665]', t => {
  reset()
  const a = accounting({ d: { hutang_supplier: 200000, hutang_bank: 300000 }, assets: [{ payment_tracking: true, purchase_outstanding: 400000 }] })
  check(t, 'liabilities', a.totalHutang, 900000)
})
test('control: cashflow outflow source totals and activity conservation [useAccounting:716]', async t => {
  reset({ expenses: [{ id: 'expense', expense_date: day, amount: 100000 }], purchases: [{ id: 'cash', purchase_date: day, amount: 200000, is_credit: false }, { id: 'credit', purchase_date: day, amount: 900000, is_credit: true }], prepaid_rents: [{ id: 'rent', payment_date: day, total_amount: 300000, status: 'active' }] })
  const acc = invoke(modules.accounting)
  const out = await acc.getOutflowTransactions(day, day)
  const cf = await acc.getCashflowDetail(day, day)
  check(t, 'non-rent outflow/rent-inclusive cashflow/net', [out.total, cf.totalKeluar, cf.net], [300000, 600000, -600000])
  check(t, 'activity net conservation', Object.values(cf.activities).reduce((s, a) => s + a.net, 0), cf.net)
})

test('exported-schema contract (NOT fresh production): cashflow debt_payments select columns [useAccounting:656]', async t => {
  reset({ transactions: [parent()], debt_payments: [payment()] })
  await invoke(modules.accounting).getCashflowDetail(day, day)
  const manifest = JSON.parse(await readFile(new URL('../security-lab/business-manifest.json', import.meta.url), 'utf8'))
  const table = manifest.tables.find(table => table.name === 'debt_payments')
  assert.ok(table?.columns?.length, 'Exported debt_payments column metadata must exist')
  const known = new Set(table.columns.map(column => column.name))
  const selects = context.calls.filter(call => call.table === 'debt_payments')
    .flatMap(call => call.steps.filter(step => step[0] === 'select').map(step => step[1]))
  assert.ok(selects.length > 0, 'Actual getCashflowDetail must issue a debt_payments select')
  const selected = [...new Set(selects.flatMap(select => select.split(',').map(column => column.trim())))]
  assert.ok(selected.every(column => /^[a-z_][a-z0-9_]*$/.test(column)), 'Contract check requires explicit simple column names')
  // Arithmetic mocks permit absent properties; this separate contract must not.
  const missing = selected.filter(column => !known.has(column)).sort()
  check(t, 'exported-schema missing debt_payments columns (not fresh production)', missing, [])
})
