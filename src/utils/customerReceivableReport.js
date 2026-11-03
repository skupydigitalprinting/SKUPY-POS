import { buildReceivableReport } from './receivableReport.js'
import { groupPaymentDays, loadReceivableHistory } from './receivableHistory.js'

export async function buildCustomerReceivableReport({ invoices, customer, admins = [], getDebtPayments, getReceivablePayments }) {
  const active = invoices.filter(d => !d.deletedAt && !d.deleted_at)
  const customerId = customer?.id || active[0]?.customerId
  if (active.some(d => (d.customerId || null) !== (customerId || null))) {
    throw new Error('Data customer berubah. Buka kembali detail customer sebelum mengunduh.')
  }
  const key = customerId || 'customer-report'
  const report = buildReceivableReport(active.map(d => ({ ...d, customerId: key })), [{ ...customer, id: key }], admins)
  const payments = await loadReceivableHistory(active, getDebtPayments, getReceivablePayments)
  for (const payment of payments) {
    const amount = Number(payment.amount)
    if (payment.amount == null || !Number.isFinite(amount) || amount < 0) throw new Error('Nominal pembayaran tidak valid. Muat ulang sebelum mengunduh.')
  }
  const days = groupPaymentDays(payments.map(p => ({ ...p, amount: Math.round(Number(p.amount)) })))
  const total = days.reduce((sum, d) => sum + d.total, 0)
  return { ...report, customerName: customer?.name || 'Customer tidak tersedia',
    paymentHistory: { days, total, difference: report.totals.paid - total } }
}
