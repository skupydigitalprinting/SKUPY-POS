import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { transformSync } from 'esbuild'

test('customer PDF never offers a saved group absent from current Book or account data', () => {
  const saved = { key: 'customer-a', customerId: 'customer-a', customer: { id: 'customer-a', name: 'A' },
    invoices: [{ id: 'debt-a', customerId: 'customer-a', invoiceNo: 'BOOK-A-1', totalDebt: 100, paid: 20 }], count: 1 }
  let source = readFileSync(new URL('../src/pages/Piutang.jsx', import.meta.url), 'utf8')
  const needle = 'const [detailTarget, setDetailTarget] = useState(null)'
  assert(source.includes(needle))
  // Seed an old open dialog; skip effects to exercise the render-time access guard.
  source = source.replace(needle, `const [detailTarget, setDetailTarget] = useState(${JSON.stringify(saved)})`)
  const noop = () => {}
  const react = { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useMemo: f => f(), useState: x => [typeof x === 'function' ? x() : x, noop], useEffect: noop, useRef: x => ({ current: x }) }
  const requireMock = id => {
    if (id === 'react') return { ...react, default: react, __esModule: true }
    if (id.endsWith('/supabase')) return { secureAuthEnabled: true }
    if (id.endsWith('/helpers')) return { toMoney: v => Number(v) || 0, formatRupiah: String, formatDate: String, timeAgo: String, parseCurrency: Number }
    if (id.endsWith('/Toast')) return { useToast: () => ({ error: noop }) }
    if (id.endsWith('/InvoicePreview')) return { useInvoicePreview: () => ({ openInvoice: noop }) }
    return new Proxy({ __esModule: true, default: id }, { get: (o, k) => k in o ? o[k] : String(k) })
  }
  const mod = { exports: {} }
  new Function('require', 'module', 'exports', transformSync(source, { loader: 'jsx', format: 'cjs' }).code)(requireMock, mod, mod.exports)
  const tree = mod.exports.default({ debts: [], customers: [], transactions: [], admins: [],
    currentUser: { id: 'owner', role: 'owner' }, activeBookId: 'book-b', bookName: 'Book B' })
  const hasStaleExport = node => {
    if (!node || typeof node !== 'object') return false
    if (node.type === '../components/CustomerReceivableDownload') return node.props.invoices?.some(d => d.id === 'debt-a')
    return (Array.isArray(node) ? node : node.props?.children || []).some(hasStaleExport)
  }
  assert.equal(hasStaleExport(tree), false)
})
