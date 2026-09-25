const dayFormat = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit' })
const labelFormat = new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', day: 'numeric', month: 'long', year: 'numeric' })
const timestamp = p => p.paid_at ? new Date(p.paid_at).getTime() : NaN

export async function loadReceivableHistory(invoices, getDebtPayments) {
  const payments = new Map()
  for (const invoice of invoices) {
    const result = await getDebtPayments(invoice.id)
    if (!result?.ok) throw new Error('Riwayat pembayaran gagal dimuat. Silakan coba lagi.')
    for (const payment of result.data || []) {
      if (!payment.deleted_at) payments.set(payment.id, { ...payment, _invoiceNo: invoice.invoiceNo || payment.invoice_no })
    }
  }
  return [...payments.values()]
}

export function groupPaymentDays(payments) {
  const days = new Map()
  for (const payment of [...payments].sort((a, b) => (timestamp(b) || 0) - (timestamp(a) || 0))) {
    const time = timestamp(payment)
    const valid = Number.isFinite(time)
    const key = valid ? dayFormat.format(time) : 'unknown'
    if (!days.has(key)) days.set(key, { key, label: valid ? labelFormat.format(time) : 'Tanggal tidak tersedia', total: 0, payments: [] })
    const day = days.get(key)
    day.total += Number(payment.amount) || 0
    day.payments.push(payment)
  }
  return [...days.values()]
}
