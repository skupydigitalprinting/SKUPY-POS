import React, { useState } from 'react'
import { Pencil, Trash2, Check, X, Loader2, Wallet } from 'lucide-react'
import Modal from './Modal'
import { Button, Badge } from './ui'
import { formatRupiah, formatDate, parseCurrency, STATUS_MAP } from '../utils/helpers'
import { useToast } from './Toast'

const PAY_LABEL = { cash: 'Cash', transfer: 'Transfer', qris: 'QRIS', hutang: 'Hutang' }
const isoDay = (d) => (d ? String(d).slice(0, 10) : '')

/**
 * Modal "Detail Sumber Data" untuk kartu Dashboard owner.
 *
 * Mode:
 *  • default     → edit transaksi (onEdit/onDelete by id)
 *  • paymentMode → edit PEMBAYARAN (metode/nominal/tanggal/admin/keterangan).
 *                  Save/Delete dirutekan via onSavePaymentRow(row, fields) /
 *                  onDeletePaymentRow(row) sehingga baris cicilan (debt_payments)
 *                  maupun transaksi langsung bisa diperbaiki.
 */
export default function DashboardCardDetail({
  open, onClose, title, rows = [], total = 0, isCount = false,
  onEdit, onDelete, showDue = false, onManage, manageLabel = 'Kelola',
  paymentMode = false, admins = [], onSavePaymentRow, onDeletePaymentRow,
}) {
  const toast = useToast()
  const [editRow, setEditRow] = useState(null)
  const [form, setForm] = useState(null)
  const [busy, setBusy] = useState(false)
  const [delRow, setDelRow] = useState(null)
  const [err, setErr] = useState('')

  const colCount = (showDue ? 11 : 10)

  const startEdit = (r) => {
    setErr('')
    setEditRow(r)
    if (paymentMode) {
      setForm({
        paymentMethod: r.paymentMethod || 'cash',
        amount: String(Math.round(r.paid || r.amount || 0)),
        date: isoDay(r.paidAt || r.date),
        cashierId: r.cashierId || '',
        customer: r.customer || '',
      })
    } else {
      setForm({
        customer: r.customer || '',
        total: String(Math.round(r.total || 0)),
        discount: String(Math.round(r.discount || 0)),
        paid: String(Math.round(r.paid || 0)),
        paymentMethod: r.paymentMethod || 'cash',
        dueDate: r.dueDate || '',
      })
    }
  }
  const cancelEdit = () => { setEditRow(null); setForm(null); setErr('') }

  const saveEdit = async () => {
    if (!form || busy || !editRow) return
    setBusy(true); setErr('')
    try {
      let res
      if (paymentMode) {
        res = await onSavePaymentRow(editRow, {
          paymentMethod: form.paymentMethod,
          amount: parseCurrency(form.amount),
          date: form.date || null,
          cashierId: form.cashierId || null,
          customer: form.customer,
        })
      } else {
        res = await onEdit(editRow.id, {
          customer: form.customer,
          total: parseCurrency(form.total),
          discount: parseCurrency(form.discount),
          paid: parseCurrency(form.paid),
          paymentMethod: form.paymentMethod,
          dueDate: form.dueDate || null,
        })
      }
      if (res?.ok) {
        cancelEdit()
        if (paymentMode) toast.success('Pembayaran berhasil diperbarui')
      } else setErr(res?.error || 'Gagal menyimpan')
    } finally { setBusy(false) }
  }

  const doDelete = async (row) => {
    if (busy) return
    setBusy(true); setErr('')
    try {
      const res = paymentMode ? await onDeletePaymentRow(row) : await onDelete(row.id)
      if (res?.ok) {
        setDelRow(null)
        if (paymentMode) toast.success('Pembayaran dihapus')
      } else setErr(res?.error || 'Gagal menghapus')
    } finally { setBusy(false) }
  }

  const th = { color: 'var(--text-muted)', fontFamily: 'Syne', fontSize: 10, letterSpacing: '0.06em' }
  const inp = { background: 'var(--bg-elevated)', border: '1px solid var(--border)', color: 'var(--text-primary)' }

  const canAct = (r) => r.editable !== false && (paymentMode ? (onSavePaymentRow && onDeletePaymentRow) : (onEdit && onDelete))

  return (
    <Modal open={open} onClose={onClose} title={`Detail Sumber Data: ${title}`}
      subtitle={`${rows.length} baris`} size="xl">
      {err && (
        <div className="flex items-center gap-2 px-3 py-2.5 rounded-xl text-xs font-semibold mb-3"
          style={{ background: 'rgba(255,77,106,0.08)', color: 'var(--red)', border: '1px solid rgba(255,77,106,0.25)' }}>
          <X size={13} /> {err}
        </div>
      )}

      <div className="overflow-x-auto -mx-1">
        <table className="w-full text-xs" style={{ borderCollapse: 'collapse', minWidth: 720 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border)' }}>
              {['Invoice', 'Tanggal', 'Customer', 'Admin', 'Metode', 'Total', 'Dibayar', 'Sisa', ...(showDue ? ['Jatuh Tempo'] : []), 'Status', ''].map((h, i) => (
                <th key={i} className={`px-2 py-2 font-bold uppercase ${(h === 'Total' || h === 'Dibayar' || h === 'Sisa') ? 'text-right' : 'text-left'}`} style={th}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={colCount} className="px-2 py-6 text-center" style={{ color: 'var(--text-muted)' }}>Tidak ada data</td></tr>
            )}
            {rows.map(r => {
              const s = STATUS_MAP[r.status] || { label: r.status || '-', color: 'gray' }

              if (editRow && editRow.id === r.id) {
                return (
                  <tr key={r.id} style={{ borderBottom: '1px solid var(--border)', background: 'rgba(139,92,246,0.05)' }}>
                    <td className="px-2 py-2" style={{ color: 'var(--text-muted)' }}>{r.invoiceNo || '—'}</td>
                    <td className="px-2 py-2" colSpan={colCount - 2}>
                      {paymentMode ? (
                        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                          <select value={form.paymentMethod} onChange={e => setForm(p => ({ ...p, paymentMethod: e.target.value }))}
                            className="px-2 py-1.5 rounded-lg text-xs" style={inp} title="Metode">
                            {['cash', 'transfer', 'qris'].map(m => <option key={m} value={m}>{PAY_LABEL[m]}</option>)}
                          </select>
                          <input value={form.amount} onChange={e => setForm(p => ({ ...p, amount: e.target.value.replace(/[^\d]/g, '') }))}
                            placeholder="Nominal" inputMode="numeric" className="px-2 py-1.5 rounded-lg text-xs" style={inp} />
                          <input type="date" value={form.date || ''} onChange={e => setForm(p => ({ ...p, date: e.target.value }))}
                            className="px-2 py-1.5 rounded-lg text-xs" style={{ ...inp, colorScheme: 'dark' }} title="Tanggal" />
                          <select value={form.cashierId || ''} onChange={e => setForm(p => ({ ...p, cashierId: e.target.value }))}
                            className="px-2 py-1.5 rounded-lg text-xs" style={inp} title="Admin">
                            <option value="">— Admin —</option>
                            {admins.map(a => <option key={a.id} value={a.id}>{a.name || a.username}</option>)}
                          </select>
                          <input value={form.customer} onChange={e => setForm(p => ({ ...p, customer: e.target.value }))}
                            placeholder="Customer / keterangan" className="px-2 py-1.5 rounded-lg text-xs sm:col-span-2" style={inp} />
                        </div>
                      ) : (
                        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                          <input value={form.customer} onChange={e => setForm(p => ({ ...p, customer: e.target.value }))}
                            placeholder="Customer" className="px-2 py-1.5 rounded-lg text-xs" style={inp} />
                          <input value={form.total} onChange={e => setForm(p => ({ ...p, total: e.target.value.replace(/[^\d]/g, '') }))}
                            placeholder="Total" inputMode="numeric" className="px-2 py-1.5 rounded-lg text-xs" style={inp} />
                          <input value={form.discount} onChange={e => setForm(p => ({ ...p, discount: e.target.value.replace(/[^\d]/g, '') }))}
                            placeholder="Diskon" inputMode="numeric" className="px-2 py-1.5 rounded-lg text-xs" style={inp} />
                          <input value={form.paid} onChange={e => setForm(p => ({ ...p, paid: e.target.value.replace(/[^\d]/g, '') }))}
                            placeholder="Dibayar" inputMode="numeric" className="px-2 py-1.5 rounded-lg text-xs" style={inp} />
                          <select value={form.paymentMethod} onChange={e => setForm(p => ({ ...p, paymentMethod: e.target.value }))}
                            className="px-2 py-1.5 rounded-lg text-xs" style={inp}>
                            {['cash', 'transfer', 'qris', 'hutang'].map(m => <option key={m} value={m}>{PAY_LABEL[m]}</option>)}
                          </select>
                          <input type="date" value={form.dueDate || ''} onChange={e => setForm(p => ({ ...p, dueDate: e.target.value }))}
                            className="px-2 py-1.5 rounded-lg text-xs" style={{ ...inp, colorScheme: 'dark' }} />
                        </div>
                      )}
                    </td>
                    <td className="px-2 py-2 text-right whitespace-nowrap">
                      <div className="flex gap-1 justify-end">
                        <button onClick={saveEdit} disabled={busy}
                          className="w-7 h-7 rounded-lg inline-flex items-center justify-center"
                          style={{ background: 'rgba(16,217,138,0.12)', color: '#10d98a', border: '1px solid rgba(16,217,138,0.3)' }}>
                          {busy ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                        </button>
                        <button onClick={cancelEdit} disabled={busy}
                          className="w-7 h-7 rounded-lg inline-flex items-center justify-center"
                          style={{ background: 'rgba(255,255,255,0.05)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}>
                          <X size={12} />
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              }

              if (delRow && delRow.id === r.id) {
                return (
                  <tr key={r.id} style={{ borderBottom: '1px solid var(--border)', background: 'rgba(255,77,106,0.05)' }}>
                    <td className="px-2 py-2.5" colSpan={colCount - 1} style={{ color: 'var(--text-secondary)' }}>
                      {paymentMode
                        ? <>Hapus pembayaran <strong>{r.invoiceNo || '—'}</strong> ({formatRupiah(r.paid)})? Saldo hutang akan disesuaikan.</>
                        : <>Hapus invoice <strong>{r.invoiceNo || '—'}</strong>? Data piutang & pembayaran terkait ikut terhapus.</>}
                    </td>
                    <td className="px-2 py-2.5 text-right whitespace-nowrap">
                      <div className="flex gap-1 justify-end">
                        <button onClick={() => doDelete(r)} disabled={busy}
                          className="px-2 h-7 rounded-lg inline-flex items-center justify-center text-[11px] font-bold"
                          style={{ background: 'rgba(255,77,106,0.12)', color: 'var(--red)', border: '1px solid rgba(255,77,106,0.3)' }}>
                          {busy ? <Loader2 size={12} className="animate-spin" /> : 'Hapus'}
                        </button>
                        <button onClick={() => setDelRow(null)} disabled={busy}
                          className="w-7 h-7 rounded-lg inline-flex items-center justify-center"
                          style={{ background: 'rgba(255,255,255,0.05)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}>
                          <X size={12} />
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              }

              return (
                <tr key={r.id} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td className="px-2 py-2.5 font-semibold" style={{ color: 'var(--text-primary)', fontFamily: 'Syne' }}>{r.invoiceNo || '—'}</td>
                  <td className="px-2 py-2.5" style={{ color: 'var(--text-secondary)' }}>{r.date ? formatDate(r.date) : '—'}</td>
                  <td className="px-2 py-2.5" style={{ color: 'var(--text-secondary)' }}>{r.customer || '—'}</td>
                  <td className="px-2 py-2.5" style={{ color: 'var(--text-muted)' }}>{r.cashierName || '—'}</td>
                  <td className="px-2 py-2.5" style={{ color: 'var(--text-muted)' }}>{PAY_LABEL[r.paymentMethod] || r.paymentMethod || '—'}</td>
                  <td className="px-2 py-2.5 text-right" style={{ color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>{formatRupiah(r.total)}</td>
                  <td className="px-2 py-2.5 text-right" style={{ color: '#10d98a', fontVariantNumeric: 'tabular-nums' }}>{formatRupiah(r.paid)}</td>
                  <td className="px-2 py-2.5 text-right" style={{ color: r.remaining > 0 ? '#ef4444' : 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>{formatRupiah(r.remaining)}</td>
                  {showDue && <td className="px-2 py-2.5" style={{ color: 'var(--text-secondary)' }}>{r.dueDate ? formatDate(r.dueDate) : '—'}</td>}
                  <td className="px-2 py-2.5"><Badge color={s.color}>{s.label}</Badge></td>
                  <td className="px-2 py-2.5 text-right whitespace-nowrap">
                    {canAct(r) && (
                      <div className="flex gap-1 justify-end">
                        <button onClick={() => startEdit(r)} title="Edit"
                          className="w-7 h-7 rounded-lg inline-flex items-center justify-center"
                          style={{ background: 'rgba(139,92,246,0.1)', color: 'var(--accent-light)', border: '1px solid rgba(139,92,246,0.2)' }}>
                          <Pencil size={12} />
                        </button>
                        <button onClick={() => setDelRow(r)} title="Hapus"
                          className="w-7 h-7 rounded-lg inline-flex items-center justify-center"
                          style={{ background: 'rgba(255,77,106,0.08)', color: 'var(--red)', border: '1px solid rgba(255,77,106,0.15)' }}>
                          <Trash2 size={12} />
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Footer total — harus cocok dengan angka kartu */}
      <div className="flex justify-between items-center mt-4 pt-3" style={{ borderTop: '1px solid var(--border)' }}>
        <span className="text-xs uppercase tracking-wider font-bold" style={{ color: 'var(--text-muted)', fontFamily: 'Syne' }}>Total</span>
        <span className="text-lg font-bold" style={{ color: 'var(--accent-light)', fontFamily: 'Syne', fontVariantNumeric: 'tabular-nums' }}>
          {isCount ? `${total} item` : formatRupiah(total)}
        </span>
      </div>

      {onManage && (
        <Button variant="success" className="w-full mt-4" onClick={onManage}>
          <Wallet size={14} /> {manageLabel}
        </Button>
      )}
    </Modal>
  )
}
