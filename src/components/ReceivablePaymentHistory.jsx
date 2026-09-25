import React, { useEffect, useMemo, useState } from 'react'
import { Loader2, RefreshCw } from 'lucide-react'
import { formatRupiah } from '../utils/helpers'
import { groupPaymentDays, loadReceivableHistory } from '../utils/receivableHistory'

const timeFormat = new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit' })
const methods = { cash: 'Tunai', transfer: 'Transfer', qris: 'QRIS', debit: 'Debit', credit: 'Kartu Kredit' }

export default function ReceivablePaymentHistory({ invoices, getDebtPayments, openInvoice }) {
  const [state, setState] = useState({ loading: true, rows: [], error: '' })
  const [attempt, setAttempt] = useState(0)
  const source = JSON.stringify(invoices.map(d => ({ id: d.id, invoiceNo: d.invoiceNo, paid: d.paid })))
  useEffect(() => {
    let active = true
    setState({ loading: true, rows: [], error: '' })
    loadReceivableHistory(JSON.parse(source), getDebtPayments).then(
      rows => { if (active) setState({ loading: false, rows, error: '' }) },
      () => { if (active) setState({ loading: false, rows: [], error: 'Riwayat pembayaran gagal dimuat.' }) },
    )
    return () => { active = false }
  }, [source, getDebtPayments, attempt])
  const days = useMemo(() => groupPaymentDays(state.rows), [state.rows])
  if (state.loading) return <div role="status" className="flex items-center justify-center gap-2 py-8"><Loader2 size={18} className="animate-spin" /> Memuat pembayaran...</div>
  if (state.error) return <div role="alert" className="py-4 space-y-3"><p style={{ color: 'var(--red)' }}>{state.error}</p><button className="inline-flex items-center gap-2" onClick={() => setAttempt(n => n + 1)}><RefreshCw size={16} /> Coba lagi</button></div>
  return <div className="space-y-4">
    <div className="flex items-center justify-between gap-3 text-sm">
      <span style={{ color: 'var(--text-secondary)' }}>Total riwayat tercatat</span>
      <strong style={{ color: '#10d98a' }}>{formatRupiah(days.reduce((sum, day) => sum + day.total, 0))}</strong>
    </div>
    <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Waktu WIB. Pembayaran gabungan tercatat per alokasi nota. DP lama yang tidak memiliki catatan pembayaran terpisah tidak termasuk daftar ini.</p>
    {days.length === 0 && <p className="text-sm py-6 text-center" style={{ color: 'var(--text-secondary)' }}>Belum ada riwayat pembayaran tercatat.</p>}
    {days.map(day => <section key={day.key}>
      <div className="flex flex-wrap justify-between gap-2 py-2 text-sm" style={{ borderBottom: '1px solid var(--border)' }}>
        <h3 className="font-semibold">{day.label}</h3><span>Total harian: <strong>{formatRupiah(day.total)}</strong></span>
      </div>
      <ul>{day.payments.map(payment => {
        const date = payment.paid_at ? new Date(payment.paid_at) : null
        return <li key={payment.id} className="py-3 text-sm" style={{ borderBottom: '1px solid var(--border)' }}>
          <div className="flex flex-wrap justify-between gap-2"><span>{methods[payment.payment_method] || payment.payment_method || 'Metode tidak tercatat'}</span><strong style={{ color: '#10d98a' }}>{formatRupiah(payment.amount)}</strong></div>
          <div className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>{date && Number.isFinite(date.getTime()) ? `${timeFormat.format(date)} WIB` : 'Jam tidak tersedia'} · {payment.cashier || 'Petugas tidak tercatat'}</div>
          {payment._invoiceNo && <button className="text-xs mt-1 underline break-all text-left" style={{ color: 'var(--accent-light)' }} onClick={() => openInvoice(payment._invoiceNo)}>{payment._invoiceNo}</button>}
          {payment.notes && <p className="text-xs mt-1 break-words" style={{ color: 'var(--text-muted)' }}>{payment.notes}</p>}
        </li>
      })}</ul>
    </section>)}
  </div>
}
