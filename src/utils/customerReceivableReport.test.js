import test from 'node:test'
import assert from 'node:assert/strict'

const invoices = [
  { id: 'a', customerId: 'c1', invoiceNo: 'INV-A', totalDebt: 2000000, paid: 1500000 },
  { id: 'b', customerId: 'c1', invoiceNo: 'INV-B', totalDebt: 1000000, paid: 1000000 },
]
const customer = { id: 'c1', name: 'Ningrum', ownerName: 'Admin Utama' }
const payments = [
  { id: 'p1', debt_id: 'a', amount: 500000, paid_at: '2026-10-01T18:00:00Z', payment_method: 'transfer' },
  { id: 'p2', debt_id: 'b', amount: 1000000, paid_at: '2026-10-01T18:00:00Z', payment_method: 'cash' },
]
test('customer export contains only selected customer notes and actual deduplicated payments', async () => {
  const { buildCustomerReceivableReport } = await import('./customerReceivableReport.js')
  let requested
  const report = await buildCustomerReceivableReport({ invoices, customer, getReceivablePayments: async ids => {
    requested = ids
    return { ok: true, data: [...payments, payments[0], { id: 'other', debt_id: 'x', amount: 999 }, { id: 'deleted', debt_id: 'a', amount: 999, deleted_at: '2026-11-01' }] }
  } })
  assert.deepEqual(requested, ['a', 'b'])
  assert.equal(report.customerName, 'Ningrum')
  assert.equal(report.totals.paid, 2500000)
  assert.equal(report.totals.remaining, 500000)
  assert.equal(report.paymentHistory.total, 1500000)
  assert.equal(report.paymentHistory.difference, 1000000)
  assert.equal(report.paymentHistory.days[0].key, '2026-10-02')
  assert.equal(report.paymentHistory.days[0].payments.length, 2)
  assert.equal(report.invoices.find(i => i.invoice === 'INV-B').status, 'Lunas')
})

test('customer export rejects mixed customer inputs, read failures and invalid payment amounts', async () => {
  const { buildCustomerReceivableReport } = await import('./customerReceivableReport.js')
  const args = { invoices, customer, getReceivablePayments: async () => ({ ok: false }) }
  await assert.rejects(buildCustomerReceivableReport(args), /Riwayat/)
  await assert.rejects(buildCustomerReceivableReport({ ...args, invoices: [...invoices, { id: 'x', customerId: 'c2' }] }), /customer/i)
  await assert.rejects(buildCustomerReceivableReport({ ...args, getReceivablePayments: async () => ({ ok: true, data: [{ ...payments[0], amount: 'bad' }] }) }), /nominal/i)
  const empty = await buildCustomerReceivableReport({ ...args, getReceivablePayments: async () => ({ ok: true, data: [] }) })
  assert.equal(empty.paymentHistory.total, 0)
  assert.equal(empty.paymentHistory.difference, 2500000)
})

test('customer PDF includes totals, invoices, payment dates, amounts and history gap', async () => {
  const { buildCustomerReceivableReport } = await import('./customerReceivableReport.js')
  const { createReceivablePDF } = await import('./receivablePdf.js')
  const report = await buildCustomerReceivableReport({ invoices, customer, getReceivablePayments: async () => ({ ok: true, data: payments }) })
  const doc = createReceivablePDF(report)
  const pdf = doc.output()
  for (const expected of ['Ningrum', '3.000.000', '2.500.000', '500.000', 'INV-A', 'INV-B', 'RIWAYAT PEMBAYARAN', '2 Oktober 2026', '1.500.000', 'Selisih']) assert(pdf.includes(expected), expected)
  assert(doc.getNumberOfPages() >= 3)
})

test('corrected payment day drives PDF totals while original entry timestamp stays separate', async () => {
  const { buildCustomerReceivableReport } = await import('./customerReceivableReport.js')
  const { createReceivablePDF } = await import('./receivablePdf.js')
  const report = await buildCustomerReceivableReport({ invoices, customer,
    getReceivablePayments: async () => ({ ok: true, data: [{ ...payments[0],
      paid_at: '2026-10-18T17:00:00Z', recorded_at: '2026-10-20T02:15:00Z' }] }) })
  assert.equal(report.paymentHistory.days[0].key, '2026-10-19')
  assert.equal(report.paymentHistory.total, 500000)
  const pdf = createReceivablePDF(report).output()
  assert(pdf.includes('19 Oktober 2026'))
  assert(pdf.includes('Dicatat: 20 Okt 2026'))
  assert(pdf.includes('09.15 WIB'))
  assert.equal(report.totals.remaining, 500000)
})
