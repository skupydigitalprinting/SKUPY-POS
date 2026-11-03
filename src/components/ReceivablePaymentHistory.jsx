import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, Pencil, RefreshCw, Save, X } from 'lucide-react'
import PaymentDateInput, { getWIBDate, isValidPaymentDate } from './PaymentDateInput'
import { formatRupiah } from '../utils/helpers'
import { groupPaymentDays, groupTransferDays, loadReceivableHistory } from '../utils/receivableHistory'

const timeFormat = new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit' })
const dateFormat = new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', day: 'numeric', month: 'long', year: 'numeric' })
const methods = { cash: 'Tunai', transfer: 'Transfer', qris: 'QRIS', debit: 'Debit', credit: 'Kartu Kredit' }

export default function ReceivablePaymentHistory({ invoices, getDebtPayments, getReceivablePayments, openInvoice, onEditPaymentDate, revision }) {
  const [state, setState] = useState({ loading: true, rows: [], error: '' })
  const [attempt, setAttempt] = useState(0)
  const [view, setView] = useState('transfer')
  const [editing, setEditing] = useState(null)
  const [saving, setSaving] = useState(false)
  const editScope = useRef(null)
  const pendingEdit = useRef(null)
  const source = JSON.stringify(invoices.map(d => ({ id: d.id, invoiceNo: d.invoiceNo, paid: d.paid })))
  useEffect(() => {
    let active = true
    const scope = { source, active: true }
    editScope.current = scope
    pendingEdit.current = null
    setEditing(null)
    setSaving(false)
    setState({ loading: true, rows: [], error: '' })
    loadReceivableHistory(JSON.parse(source), getDebtPayments, getReceivablePayments).then(
      rows => { if (active) setState({ source, loading: false, rows, error: '' }) },
      () => { if (active) setState({ source, loading: false, rows: [], error: 'Riwayat pembayaran gagal dimuat.' }) },
    )
    return () => { active = false; scope.active = false }
  }, [source, getDebtPayments, getReceivablePayments, onEditPaymentDate, attempt, revision])
  const saveDate = async event => {
    event.preventDefault()
    const scope = editScope.current
    if (!editing || !onEditPaymentDate || pendingEdit.current || !scope?.active || scope.source !== source) return
    if (!isValidPaymentDate(editing.paymentDate) || !editing.reason.trim()) {
      setEditing(prev => ({ ...prev, error: 'Isi tanggal yang valid (maksimal hari ini WIB) dan alasan perubahan.' }))
      return
    }
    const request = {}
    pendingEdit.current = request
    setSaving(true)
    setEditing(prev => ({ ...prev, error: '' }))
    const isCurrent = () => scope.active && editScope.current === scope && pendingEdit.current === request
    try {
      const result = await onEditPaymentDate(editing.payment, { paymentDate: editing.paymentDate, reason: editing.reason.trim() })
      if (!isCurrent()) return
      if (result?.ok === true) {
        setEditing(null)
        setAttempt(n => n + 1)
      } else setEditing(prev => ({ ...prev, error: result?.error || 'Tanggal pembayaran gagal disimpan.' }))
    } catch {
      if (isCurrent()) setEditing(prev => ({ ...prev, error: 'Tanggal pembayaran belum terkonfirmasi. Muat ulang riwayat sebelum mencoba lagi.' }))
    } finally {
      if (isCurrent()) { pendingEdit.current = null; setSaving(false) }
    }
  }
  const days = useMemo(() => groupPaymentDays(state.rows), [state.rows])
  const transferDays = useMemo(() => groupTransferDays(state.rows), [state.rows])
  const displayedDays = view === 'transfer' ? transferDays : days
  if (state.loading || state.source !== source) return <div role="status" className="flex items-center justify-center gap-2 py-8"><Loader2 size={18} className="animate-spin" /> Memuat pembayaran...</div>
  if (state.error) return <div role="alert" className="py-4 space-y-3"><p style={{ color: 'var(--red)' }}>{state.error}</p><button className="inline-flex items-center gap-2" onClick={() => setAttempt(n => n + 1)}><RefreshCw size={16} /> Coba lagi</button></div>
  return <div className="space-y-4">
    <div role="group" aria-label="Tampilan riwayat pembayaran" className="grid grid-cols-2 gap-1 rounded-lg p-1"
      style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
      {[['transfer', 'Transfer Harian'], ['detail', 'Rincian Pembayaran']].map(([value, label]) => <button
        key={value} type="button" aria-pressed={view === value} disabled={saving} onClick={() => { setView(value); setEditing(null) }}
        className="min-w-0 rounded-md px-2 py-2 text-sm font-semibold"
        style={{ color: view === value ? 'var(--accent-light)' : 'var(--text-secondary)',
          background: view === value ? 'rgba(139,92,246,0.15)' : 'transparent' }}>{label}</button>)}
    </div>
    <div className="flex items-center justify-between gap-3 text-sm">
      <span style={{ color: 'var(--text-secondary)' }}>{view === 'transfer' ? 'Total transfer tercatat' : 'Total riwayat tercatat'}</span>
      <strong style={{ color: '#10d98a' }}>{formatRupiah(displayedDays.reduce((sum, day) => sum + day.total, 0))}</strong>
    </div>
    {view === 'transfer' ? <>
      {transferDays.length === 0 ? <p className="text-sm py-6 text-center" style={{ color: 'var(--text-secondary)' }}>Belum ada pembayaran transfer tercatat.</p>
        : <table aria-label="Total transfer harian" className="w-full table-fixed text-sm" style={{ borderCollapse: 'collapse' }}>
          <thead><tr style={{ borderBottom: '1px solid var(--border)', color: 'var(--text-secondary)' }}>
            <th scope="col" className="w-1/2 py-3 pr-2 text-left font-semibold">Tanggal (WIB)</th>
            <th scope="col" className="w-1/2 py-3 pl-2 text-right font-semibold">Total Transfer</th>
          </tr></thead>
          <tbody>{transferDays.map(day => <tr key={day.key} style={{ borderBottom: '1px solid var(--border)' }}>
            <td className="py-3 pr-2 break-words">{day.label}</td>
            <td className="py-3 pl-2 text-right font-semibold break-words" style={{ color: '#10d98a', fontVariantNumeric: 'tabular-nums' }}>{formatRupiah(day.total)}</td>
          </tr>)}</tbody>
        </table>}
    </> : <>
    <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Waktu WIB. Pembayaran gabungan tercatat per alokasi nota. DP lama yang tidak memiliki catatan pembayaran terpisah tidak termasuk daftar ini.</p>
    {days.length === 0 && <p className="text-sm py-6 text-center" style={{ color: 'var(--text-secondary)' }}>Belum ada riwayat pembayaran tercatat.</p>}
    {days.map(day => <section key={day.key}>
      <div className="flex flex-wrap justify-between gap-2 py-2 text-sm" style={{ borderBottom: '1px solid var(--border)' }}>
        <h3 className="font-semibold">{day.label}</h3><span>Total harian: <strong>{formatRupiah(day.total)}</strong></span>
      </div>
      <ul>{day.payments.map(payment => {
        const recordedAt = payment.recorded_at || payment.paid_at
        const date = recordedAt ? new Date(recordedAt) : null
        return <li key={payment.id} className="py-3 text-sm" style={{ borderBottom: '1px solid var(--border)' }}>
          <div className="flex flex-wrap justify-between items-center gap-2"><span>{methods[payment.payment_method] || payment.payment_method || 'Metode tidak tercatat'}</span>
            <div className="flex items-center gap-2 min-w-0"><strong className="break-all" style={{ color: '#10d98a' }}>{formatRupiah(payment.amount)}</strong>
              {onEditPaymentDate && <button type="button" disabled={saving} title="Ubah tanggal alokasi pembayaran ini"
                aria-label={`Ubah tanggal pembayaran ${payment._invoiceNo || payment.id}`}
                onClick={() => setEditing({ payment, paymentDate: payment.paid_at ? getWIBDate(payment.paid_at) : '', reason: '', error: '' })}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md disabled:opacity-50"
                style={{ color: 'var(--text-secondary)', border: '1px solid var(--border)' }}><Pencil size={14} /></button>}
            </div>
          </div>
          <div className="text-xs mt-1 break-words" style={{ color: 'var(--text-secondary)' }}>{date && Number.isFinite(date.getTime()) ? `Dicatat ${dateFormat.format(date)}, ${timeFormat.format(date)} WIB` : 'Waktu pencatatan tidak tersedia'} · {payment.cashier || 'Petugas tidak tercatat'}</div>
          {payment._invoiceNo && <button disabled={saving} className="text-xs mt-1 underline break-all text-left" style={{ color: 'var(--accent-light)' }} onClick={() => openInvoice(payment._invoiceNo)}>{payment._invoiceNo}</button>}
          {payment.notes && <p className="text-xs mt-1 break-words" style={{ color: 'var(--text-muted)' }}>{payment.notes}</p>}
          {editing?.payment.id === payment.id && <form onSubmit={saveDate} aria-label="Ubah tanggal alokasi pembayaran" aria-busy={saving}
            className="mt-3 space-y-3 border-t pt-3" style={{ borderColor: 'var(--border)' }}>
            <PaymentDateInput value={editing.paymentDate} onChange={paymentDate => setEditing(prev => ({ ...prev, paymentDate, error: '' }))} disabled={saving} />
            <label className="block text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>Alasan perubahan
              <textarea required maxLength={1000} value={editing.reason} disabled={saving} rows={2}
                onChange={event => setEditing(prev => ({ ...prev, reason: event.target.value, error: '' }))}
                className="mt-2 block w-full min-w-0 rounded-lg px-3 py-2 text-sm font-normal"
                style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', color: 'var(--text-primary)' }} />
            </label>
            {editing.error && <p role="alert" className="text-xs break-words" style={{ color: 'var(--red)' }}>{editing.error}</p>}
            <div className="flex flex-wrap justify-end gap-3">
              <button type="button" disabled={saving} onClick={() => setEditing(null)} className="inline-flex items-center gap-1 text-xs disabled:opacity-50"><X size={14} /> Batal</button>
              <button type="submit" disabled={saving || !isValidPaymentDate(editing.paymentDate) || !editing.reason.trim()}
                className="inline-flex items-center gap-1 text-xs font-semibold disabled:opacity-50" style={{ color: 'var(--accent-light)' }}>
                {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}{saving ? 'Menyimpan...' : 'Simpan tanggal'}
              </button>
            </div>
          </form>}
        </li>
      })}</ul>
    </section>)}
    </>}
  </div>
}
