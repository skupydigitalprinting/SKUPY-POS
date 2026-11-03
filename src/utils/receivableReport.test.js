import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const fixture = () => [
  { id: 'd1', customerId: 'c1', invoiceNo: 'INV-1', totalDebt: '2000000', paid: '500000', createdAt: '2026-10-01T00:00:00+07:00' },
  { id: 'd2', customerId: 'c1', invoiceNo: 'INV-2', totalDebt: 1000000, paid: 1000000, createdAt: '2026-10-02T00:00:00+07:00' },
  { id: 'd3', customerId: 'c2', invoiceNo: 'INV-3', totalDebt: 500000, paid: 100000 },
  { id: 'd4', customerId: 'missing', invoiceNo: 'INV-4', totalDebt: 100000, paid: 0 },
  { id: 'deleted', totalDebt: 9000000, paid: 0, deletedAt: '2026-11-01' },
]
const customers = [{ id: 'c1', name: 'Nama sama', ownerName: 'Nadia' }, { id: 'c2', name: 'Nama sama', ownerName: 'Susan' }]

test('PDF model reconciles all notes, includes paid notes and excludes deleted notes', async () => {
  const { buildReceivableReport } = await import('./receivableReport.js')
  const debts = fixture(), before = JSON.stringify(debts)
  const r = buildReceivableReport(debts, customers)
  assert.deepEqual(r.totals, { total: 3600000, paid: 1600000, remaining: 2000000, invoices: 4, customers: 3, activeInvoices: 3 })
  assert.equal(r.customers.length, 3)
  assert.equal(r.customers.find(c => c.id === 'c1').total, 3000000)
  assert.equal(r.customers.find(c => c.id === 'c2').pic, 'Susan')
  assert.equal(r.invoices.find(d => d.id === 'd2').status, 'Lunas')
  assert.equal(r.invoices.find(d => d.id === 'd4').customer, 'Customer tidak tersedia')
  assert.equal(JSON.stringify(debts), before)
})

test('PDF model has no row cap and does not offset overpayments against other invoices', async () => {
  const { buildReceivableReport } = await import('./receivableReport.js')
  const debts = Array.from({ length: 1201 }, (_, i) => ({ id: `d${i}`, customerId: 'c1', totalDebt: 100, paid: 10 }))
  debts.push({ id: 'overpaid', customerId: 'c1', totalDebt: 100, paid: 200 })
  const r = buildReceivableReport(debts, customers)
  assert.equal(r.invoices.length, 1202)
  assert.equal(r.totals.remaining, 1201 * 90)
  assert.throws(() => buildReceivableReport([{ id: 'bad', totalDebt: 'broken' }], []), /nominal/i)
  assert.throws(() => buildReceivableReport([debts[0], debts[0]], customers), /duplikat/i)
})

test('PDF output is downloadable, multipage and includes full report totals and last invoice', async () => {
  const { buildReceivableReport } = await import('./receivableReport.js')
  const { createReceivablePDF } = await import('./receivablePdf.js')
  const debts = Array.from({ length: 1201 }, (_, i) => ({ id: `d${i}`, customerId: 'c1', invoiceNo: `INV-20261103-${String(i).padStart(4, '0')}-long-identifier`, totalDebt: 2000000, paid: 500000, createdAt: '2026-11-03T01:00:00Z' }))
  const doc = createReceivablePDF(buildReceivableReport(debts, customers), { bookName: 'Semua Book', generatedAt: new Date('2026-11-03T03:00:00Z'), storeName: 'SKUPY' })
  assert(doc.getNumberOfPages() > 3)
  const pdf = doc.output()
  assert(pdf.startsWith('%PDF-'))
  assert(pdf.includes('1.801.500.000'))
  assert(pdf.includes('1200'))
  assert(pdf.includes('Halaman 1 /'))
  const empty = createReceivablePDF(buildReceivableReport([], []), {})
  assert.equal(empty.getNumberOfPages(), 1)
  assert(empty.output().includes('Tidak ada catatan piutang'))
})

test('PDF limits long metadata to keep summaries on the first page', async () => {
  const { buildReceivableReport } = await import('./receivableReport.js')
  const { createReceivablePDF } = await import('./receivablePdf.js')
  const doc = createReceivablePDF(buildReceivableReport([], []), { bookName: 'Book '.repeat(1000) })
  assert(doc.output().length < 15000, 'Metadata must not grow beyond its reserved space')
  assert.equal(doc.getNumberOfPages(), 1)
})

test('PDF embeds a Unicode font for non-Latin customer names', async () => {
  const { buildReceivableReport } = await import('./receivableReport.js')
  const { createReceivablePDF, loadReceivablePdfFont } = await import('./receivablePdf.js')
  assert.equal(await loadReceivablePdfFont(buildReceivableReport([], []), {}), null)
  const fontData = (await readFile(new URL('../assets/fonts/NotoSansSC-Regular.ttf', import.meta.url))).toString('base64')
  const doc = createReceivablePDF(buildReceivableReport(fixture(), [{ id: 'c1', name: '\u738b\u5c0f\u660e' }]), { fontData })
  const font = doc.internal.getFont('NotoSansSC', 'normal')
  for (const char of '\u738b\u5c0f\u660e') assert(font.metadata.characterToGlyph(char.codePointAt(0)) > 0)
  assert(doc.output().includes('/Identity-H'))
  assert(doc.output().includes('/ToUnicode'))
})
