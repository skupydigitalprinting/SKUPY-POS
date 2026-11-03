import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { transformSync } from 'esbuild'
import * as history from '../src/utils/receivableHistory.js'
import * as helpers from '../src/utils/helpers.js'
import * as paymentDates from '../src/utils/paymentDates.js'

// Shallow hook runner, following the existing UI tests. No database/client is loaded.
function mount(file, initialProps = {}) {
  const slots = [], effects = [], modules = new Map()
  let cursor = 0, dirty = false, props = initialProps, tree, mounted = true
  const react = {
    lazy: () => 'Lazy',
    createElement: (type, props, ...children) => ({ type, props: { ...props, children: children.flat(Infinity) } }),
    useState(initial) {
      const i = cursor++
      if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial
      return [slots[i], value => { if (mounted) { slots[i] = typeof value === 'function' ? value(slots[i]) : value; dirty = true } }]
    },
    useRef(initial) { const i = cursor++; return slots[i] ||= { current: initial } },
    useMemo: fn => fn(),
    useId: () => `field-${cursor++}`,
    useEffect(fn, deps) {
      const i = cursor++, previous = slots[i]
      if (!previous || deps.some((value, n) => value !== previous.deps[n])) {
        effects.push(() => { previous?.cleanup?.(); slots[i] = { deps, cleanup: fn() } })
      }
    },
  }
  const load = path => {
    if (modules.has(path)) return modules.get(path)
    const mod = { exports: {} }
    const requireMock = id => {
      if (id === 'react') return { ...react, default: react, __esModule: true }
      if (id.endsWith('/PaymentDateInput')) return load('src/components/PaymentDateInput.jsx')
      if (id.endsWith('/receivableHistory')) return history
      if (id.endsWith('/paymentDates')) return paymentDates
      if (id.endsWith('/helpers')) return helpers
      if (id.endsWith('/dummyData')) return { ORDER_STATUS: ['menunggu'] }
      if (id.endsWith('/whatsapp')) return { TEMPLATES: { chat: () => '' } }
      if (id.endsWith('/supabase')) return { secureAuthEnabled: false }
      if (id.endsWith('/Toast')) return { useToast: () => ({ error() {}, success() {} }) }
      if (id.endsWith('/InvoicePreview')) return { useInvoicePreview: () => ({ openInvoice() {} }) }
      return new Proxy({ __esModule: true, default: id }, { get: (o, k) => k in o ? o[k] : String(k) })
    }
    new Function('require', 'module', 'exports', transformSync(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'), { loader: 'jsx', format: 'cjs' }).code)(requireMock, mod, mod.exports)
    modules.set(path, mod.exports)
    return mod.exports
  }
  const exports = load(file)
  const render = () => {
    do { dirty = false; cursor = 0; tree = exports.default(props); effects.splice(0).forEach(run => run()) } while (dirty)
    return tree
  }
  const nodes = (predicate, node = tree) => !node || typeof node !== 'object' ? []
    : [...(predicate(node) ? [node] : []), ...(node.props?.children || []).flatMap(child => child == null ? [] : nodes(predicate, child))]
  return { exports, render, nodes, update(next) { props = next; render() },
    async settle() { await new Promise(resolve => setImmediate(resolve)); render() },
    unmount() { mounted = false; slots.forEach(slot => slot?.cleanup?.()) } }
}

const invoice = { id: 'debt-1', invoiceNo: 'INV-1', paid: 100 }
const payment = { id: 'payment-1', debt_id: 'debt-1', paid_at: '2026-03-01T17:30:00Z',
  recorded_at: '2026-03-05T18:40:00Z', cashier: 'Kasir Asli', amount: 100, payment_method: 'transfer' }
const textOf = node => typeof node === 'string' || typeof node === 'number' ? String(node)
  : (node?.props?.children || []).map(textOf).join(' ')
const button = (ui, text) => ui.nodes(n => ['button', 'Button'].includes(n.type) && textOf(n).includes(text))[0]
const change = (node, value) => node.props.onChange({ target: { value } })
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }

test('date input uses WIB at midnight and rejects missing, impossible and future dates', () => {
  const ui = mount('src/components/PaymentDateInput.jsx', { value: '', onChange() {} })
  const { getWIBDate, isValidPaymentDate } = ui.exports
  assert.equal(getWIBDate(new Date('2026-11-02T17:00:00Z')), '2026-11-03')
  assert.equal(getWIBDate(new Date('2026-11-02T16:59:59Z')), '2026-11-02')
  for (const value of ['', '2026-02-29', '2026-04-31', '2026-13-01', '2026-1-01', '0000-01-01', '2026-11-04']) {
    assert.equal(isValidPaymentDate(value, '2026-11-03'), false, value)
  }
  assert.equal(isValidPaymentDate('2024-02-29', '2026-11-03'), true)
  ui.render()
  const input = ui.nodes(n => n.type === 'input')[0]
  assert.equal(input.props.type, 'date')
  assert.equal(input.props.required, true)
  assert.equal(input.props.max, getWIBDate())
})

async function historyUI(overrides = {}) {
  let loads = 0
  const props = { invoices: [invoice], getReceivablePayments: async () => { loads++; return { ok: true, data: [payment] } },
    onEditPaymentDate: async () => ({ ok: true }), ...overrides }
  const ui = mount('src/components/ReceivablePaymentHistory.jsx', props)
  ui.render(); await ui.settle()
  button(ui, 'Rincian Pembayaran').props.onClick(); ui.render()
  return { ui, props, loads: () => loads }
}

function openEditor(ui) {
  const edit = ui.nodes(n => n.type === 'button' && n.props['aria-label']?.startsWith('Ubah tanggal'))[0]
  assert.ok(edit, 'each allocation exposes its own date editor')
  edit.props.onClick(); ui.render()
}

test('detail uses effective day but retains original recording time and cashier, including legacy fallback', async () => {
  const { ui } = await historyUI({ getReceivablePayments: async () => ({ ok: true, data: [payment, { ...payment, id: 'legacy', recorded_at: null }] }) })
  assert.match(textOf(ui.render()), /2 Maret 2026/)
  assert.match(textOf(ui.render()), /Dicatat 6 Maret 2026.*01[.:]40 WIB/)
  assert.match(textOf(ui.render()), /Dicatat 2 Maret 2026.*00[.:]30 WIB/)
  assert.match(textOf(ui.render()), /Kasir Asli/)
  ui.unmount()
})

test('inline date editor validates, prevents duplicate saves, sends only row/date/reason and reloads', async () => {
  const pending = deferred(), calls = []
  const { ui, loads } = await historyUI({ onEditPaymentDate: (...args) => { calls.push(args); return pending.promise } })
  openEditor(ui)
  assert.equal(ui.nodes(n => n.type === 'form').length, 1)
  const dateField = () => ui.nodes(n => typeof n.type === 'function' && n.props.value === '2026-03-02')[0]
  assert.ok(dateField(), 'editor defaults to effective WIB date')
  let form = ui.nodes(n => n.type === 'form')[0]
  await form.props.onSubmit({ preventDefault() {} }); ui.render()
  assert.equal(calls.length, 0)
  change(ui.nodes(n => n.type === 'textarea')[0], '  Koreksi tanggal transfer  ')
  dateField().props.onChange('2026-03-01'); ui.render()
  form = ui.nodes(n => n.type === 'form')[0]
  const saving = form.props.onSubmit({ preventDefault() {} })
  form.props.onSubmit({ preventDefault() {} }); ui.render()
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0].id, 'payment-1')
  assert.deepEqual(calls[0][1], { paymentDate: '2026-03-01', reason: 'Koreksi tanggal transfer' })
  assert.equal(ui.nodes(n => n.type === 'textarea')[0].props.disabled, true)
  assert.equal(ui.nodes(n => n.type === 'button' && n.props.type === 'submit')[0].props.disabled, true)
  pending.resolve({ ok: true }); await saving; await ui.settle(); await ui.settle()
  assert.equal(loads(), 2)
  assert.equal(ui.nodes(n => n.type === 'form').length, 0)
  ui.unmount()
})

test('failed edits keep inline input and expose the error', async () => {
  const { ui } = await historyUI({ onEditPaymentDate: async () => ({ ok: false, error: 'Tidak diizinkan' }) })
  openEditor(ui)
  change(ui.nodes(n => n.type === 'textarea')[0], 'Koreksi'); ui.render()
  await ui.nodes(n => n.type === 'form')[0].props.onSubmit({ preventDefault() {} }); ui.render()
  assert.match(textOf(ui.render()), /Tidak diizinkan/)
  assert.equal(ui.nodes(n => n.type === 'textarea')[0].props.value, 'Koreksi')
  ui.unmount()
})

test('history without an edit callback stays read-only', async () => {
  const { ui } = await historyUI({ onEditPaymentDate: undefined })
  assert.equal(ui.nodes(n => n.type === 'button' && n.props['aria-label']?.startsWith('Ubah tanggal')).length, 0)
  ui.unmount()
})

test('inline validation rejects future dates and blank reasons even on direct submission', async () => {
  let calls = 0
  const { ui } = await historyUI({ onEditPaymentDate: async () => { calls++; return { ok: true } } })
  openEditor(ui)
  change(ui.nodes(n => n.type === 'textarea')[0], 'Koreksi')
  dateControl(ui).props.onChange('9999-01-01'); ui.render()
  await ui.nodes(n => n.type === 'form')[0].props.onSubmit({ preventDefault() {} }); ui.render()
  assert.equal(calls, 0)
  dateControl(ui).props.onChange('2026-01-02')
  change(ui.nodes(n => n.type === 'textarea')[0], '   '); ui.render()
  await ui.nodes(n => n.type === 'form')[0].props.onSubmit({ preventDefault() {} }); ui.render()
  assert.equal(calls, 0)
  assert.equal(ui.nodes(n => n.props.role === 'alert').length, 1)
  ui.unmount()
})

test('a thrown edit remains visible and unlocks the inline form', async () => {
  const { ui } = await historyUI({ onEditPaymentDate: async () => { throw new Error('Offline') } })
  openEditor(ui)
  change(ui.nodes(n => n.type === 'textarea')[0], 'Koreksi'); ui.render()
  await ui.nodes(n => n.type === 'form')[0].props.onSubmit({ preventDefault() {} }); ui.render()
  assert.equal(ui.nodes(n => n.props.role === 'alert').length, 1)
  assert.equal(ui.nodes(n => n.type === 'textarea')[0].props.disabled, false)
  assert.equal(ui.nodes(n => n.type === 'textarea')[0].props.value, 'Koreksi')
  ui.unmount()
})

test('switching history scope ignores a late edit completion', async () => {
  const pending = deferred()
  const { ui, props, loads } = await historyUI({ onEditPaymentDate: () => pending.promise })
  openEditor(ui)
  change(ui.nodes(n => n.type === 'textarea')[0], 'Koreksi'); ui.render()
  const saving = ui.nodes(n => n.type === 'form')[0].props.onSubmit({ preventDefault() {} })
  ui.update({ ...props, invoices: [{ id: 'debt-2', invoiceNo: 'INV-2', paid: 0 }] }); await ui.settle()
  const count = loads()
  pending.resolve({ ok: true }); await saving; await ui.settle()
  assert.equal(loads(), count)
  assert.equal(ui.nodes(n => n.type === 'form').length, 0)
  assert.doesNotMatch(textOf(ui.render()), /Kasir Asli/)
  ui.unmount()
})

test('unmounting history ignores a late edit completion', async () => {
  const pending = deferred()
  const { ui, loads } = await historyUI({ onEditPaymentDate: () => pending.promise })
  openEditor(ui)
  change(ui.nodes(n => n.type === 'textarea')[0], 'Koreksi'); ui.render()
  const saving = ui.nodes(n => n.type === 'form')[0].props.onSubmit({ preventDefault() {} })
  ui.unmount()
  pending.resolve({ ok: true }); await saving
  assert.equal(loads(), 1)
})

const dateControl = ui => ui.nodes(n => typeof n.type === 'function' && n.type.name === 'PaymentDateInput')[0]
const currentUser = { id: 'cashier', role: 'cashier' }
const debt = { ...invoice, customerId: 'customer-1', totalDebt: 500, paid: 100, createdAt: '2026-01-01T00:00:00Z' }
const piutangProps = { debts: [debt], customers: [{ id: 'customer-1', name: 'Pelanggan' }], transactions: [], currentUser }

test('Order passes selected date as fourth argument, rejects invalid dates, resets on each opening', async () => {
  const calls = []
  const transaction = { id: 'trx-1', invoiceNo: 'INV-1', total: 500, paid: 100, remaining: 400,
    status: 'pending', orderStatus: 'menunggu', cashierId: 'cashier', createdAt: new Date().toISOString(), items: [] }
  const ui = mount('src/pages/Order.jsx', { transactions: [transaction], currentUser, storeInfo: {},
    updateTransactionPayment: async (...args) => { calls.push(args); return { ok: true } } })
  ui.render()
  button(ui, 'Bayar').props.onClick(); ui.render()
  assert.ok(dateControl(ui), 'Order payment modal includes a date control')
  const today = dateControl(ui).props.value
  dateControl(ui).props.onChange('2026-02-30'); ui.render()
  assert.equal(button(ui, 'Konfirmasi').props.disabled, true)
  await button(ui, 'Konfirmasi').props.onClick()
  assert.equal(calls.length, 0)
  dateControl(ui).props.onChange('2026-01-02'); ui.render()
  await button(ui, 'Konfirmasi').props.onClick(); ui.render()
  assert.deepEqual(calls, [['trx-1', 400, 'cash', '2026-01-02']])
  button(ui, 'Bayar').props.onClick(); ui.render()
  assert.equal(dateControl(ui).props.value, today)
  ui.unmount()
})

for (const fallback of [false, true]) test(`Piutang ${fallback ? 'fallback allocations' : 'customer FIFO'} passes date and resets every opening`, async () => {
  const calls = []
  const ui = mount('src/pages/Piutang.jsx', { ...piutangProps,
    payCustomerDebtsFIFO: fallback ? undefined : async args => { calls.push(args); return { ok: true } },
    payDebt: async (...args) => { calls.push(args); return { ok: true } } })
  ui.render()
  button(ui, 'Bayar Gabungan').props.onClick(); ui.render()
  assert.ok(dateControl(ui), 'Piutang payment modal includes a date control')
  const today = dateControl(ui).props.value
  dateControl(ui).props.onChange(''); ui.render()
  assert.equal(button(ui, 'Konfirmasi').props.disabled, true)
  await button(ui, 'Konfirmasi').props.onClick()
  assert.equal(calls.length, 0)
  dateControl(ui).props.onChange('2026-01-02'); ui.render()
  await button(ui, 'Konfirmasi').props.onClick(); ui.render()
  assert.deepEqual(calls, fallback ? [['debt-1', 400, 'transfer', 'Pembayaran gabungan (FIFO)', '2026-01-02']]
    : [{ customerId: 'customer-1', amount: 400, paymentMethod: 'transfer', paymentDate: '2026-01-02' }])
  button(ui, 'Bayar Gabungan').props.onClick(); ui.render()
  assert.equal(dateControl(ui).props.value, today)
  ui.unmount()
})

test('Piutang wires row date editing in both history views and closes history on Book change', () => {
  const editPaymentDate = async () => ({ ok: true })
  const ui = mount('src/pages/Piutang.jsx', { ...piutangProps, editPaymentDate, invoiceRevision: 4 })
  ui.render()
  button(ui, 'Lihat Rincian').props.onClick(); ui.render()
  button(ui, 'Riwayat Pembayaran').props.onClick(); ui.render()
  let histories = ui.nodes(n => n.type === '../components/ReceivablePaymentHistory')
  assert.equal(histories.length, 1)
  assert.equal(histories[0].props.onEditPaymentDate, editPaymentDate)
  button(ui, 'Riwayat').props.onClick(); ui.render()
  histories = ui.nodes(n => n.type === '../components/ReceivablePaymentHistory')
  assert.equal(histories.length, 2)
  assert.ok(histories.every(n => n.props.onEditPaymentDate === editPaymentDate))
  assert.deepEqual(histories.map(n => n.props.revision), [4, 4])
  ui.update({ ...piutangProps, editPaymentDate, invoiceRevision: 5 })
  histories = ui.nodes(n => n.type === '../components/ReceivablePaymentHistory')
  assert.deepEqual(histories.map(n => n.props.revision), [5, 5])
  ui.update({ ...piutangProps, activeBookId: 'another-book', editPaymentDate })
  assert.equal(ui.nodes(n => n.type === '../components/ReceivablePaymentHistory').length, 0)
  ui.unmount()
})

test('committed date edit with refresh failure closes the editor and only reloads history', async () => {
  let writes = 0
  const { ui, loads } = await historyUI({ onEditPaymentDate: async () => {
    writes++
    return { ok: true, committed: true, needsRefresh: true }
  } })
  try {
    openEditor(ui)
    change(ui.nodes(n => n.type === 'textarea')[0], 'Koreksi')
    dateControl(ui).props.onChange('2026-03-01'); ui.render()
    await ui.nodes(n => n.type === 'form')[0].props.onSubmit({ preventDefault() {} })
    await ui.settle(); await ui.settle()
    assert.equal(writes, 1)
    assert.equal(loads(), 2)
    assert.equal(ui.nodes(n => n.type === 'form').length, 0)
    assert.equal(ui.nodes(n => n.props.role === 'alert').length, 0)
  } finally { ui.unmount() }
})

test('shared revision refreshes both mounted histories after a date-only change', async () => {
  let row = { ...payment }
  const getReceivablePayments = async () => ({ ok: true, data: [{ ...row }] })
  const first = await historyUI({ getReceivablePayments, revision: 1 })
  const second = await historyUI({ getReceivablePayments, revision: 1 })
  try {
    for (const { ui } of [first, second]) {
      button(ui, 'Transfer Harian').props.onClick(); ui.render()
      assert.match(textOf(ui.render()), /2 Maret 2026/)
    }
    row = { ...row, paid_at: '2026-02-28T17:00:00Z' }
    for (const { ui, props } of [first, second]) {
      ui.update({ ...props, revision: 2 })
      await ui.settle()
      assert.match(textOf(ui.render()), /1 Maret 2026/)
      assert.doesNotMatch(textOf(ui.render()), /2 Maret 2026/)
      button(ui, 'Rincian Pembayaran').props.onClick(); ui.render()
      assert.match(textOf(ui.render()), /Dicatat 6 Maret 2026.*01[.:]40 WIB/)
      assert.match(textOf(ui.render()), /Kasir Asli/)
    }
  } finally { first.ui.unmount(); second.ui.unmount() }
})

test('revision reload ignores a late older read without reverting the corrected payment day', async () => {
  const oldRead = deferred()
  let reads = 0
  const props = { invoices: [invoice], revision: 1, getReceivablePayments: () => {
    reads++
    return reads === 1 ? oldRead.promise
      : Promise.resolve({ ok: true, data: [{ ...payment, paid_at: '2026-02-28T17:00:00Z' }] })
  } }
  const ui = mount('src/components/ReceivablePaymentHistory.jsx', props)
  try {
    ui.render()
    ui.update({ ...props, revision: 2 }); await ui.settle()
    assert.equal(reads, 2)
    assert.match(textOf(ui.render()), /1 Maret 2026/)
    oldRead.resolve({ ok: true, data: [payment] }); await ui.settle()
    assert.match(textOf(ui.render()), /1 Maret 2026/)
    assert.doesNotMatch(textOf(ui.render()), /2 Maret 2026/)
  } finally { ui.unmount() }
})
