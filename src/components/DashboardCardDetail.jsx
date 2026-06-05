import React, { useState } from 'react'
import { Pencil, Trash2, Check, X, AlertTriangle, Loader2, Wallet } from 'lucide-react'
import Modal from './Modal'
import { Button, Badge } from './ui'
import { formatRupiah, formatDate, parseCurrency, STATUS_MAP } from '../utils/helpers'

const PAY_LABEL = { cash: 'Cash', transfer: 'Transfer', qris: 'QRIS', hutang: 'Hutang' }

/**
 * Modal "Detail Sumber Data" untuk kartu Dashboard owner.
 * Menampilkan baris transaksi pembentuk angka + tombol Edit & Hapus (owner).
 *
 * Props:
 *   open, onClose
 *   title           judul kartu (mis. "Total Omzet")
 *   rows            array transaksi { id, invoiceNo, date, customer, cashierName,
 *                   paymentMethod, total, paid, remaining, status, _amount }
 *   total           angka total kartu (untuk dicocokkan dengan footer)
 *   isCount         true → tampilkan total sebagai jumlah baris, bukan rupiah
 *   onEdit(id, fields) / onDelete(id)  → async, owner only
 */
export default function DashboardCardDetail({ open, onClose, title, rows = [], total = 0, isCount = false, onEdit, onDelete, showDue = false, onManage, manageLabel = 'Kelola' }) {
  const [editId, setEditId] = useState(null)
  const [form, setForm] = useState(null)
  const [busy, setBusy] = useState(false)
  const [delId, setDelId] = useState(null)
  const [err, setErr] = useState('')

  const startEdit = (r) => {
    setErr('')
    setEditId(r.id)
    setForm({
      customer: r.customer || '',
      total: String(Math.round(r.total || 0)),
      discount: String(Math.round(r.discount || 0)),
      paid: String(Math.round(r.paid || 0)),
      paymentMethod: r.paymentMethod || 'cash',
      dueDate: r.dueDate || '',
    })
  }
  const cancelEdit = () => { setEditId(null); setForm(null); setErr('') }

  const saveEdit = async () => {
    if (!form || busy) return
    setBusy(true); setErr('')
    try {
      const res = await onEdit(editId, {
        customer: form.customer,
        total: parseCurrency(form.total),
        discount: parseCurrency(form.discount),
        paid: parseCurrency(form.paid),
        paymentMethod: form.paymentMethod,
        dueDate: form.dueDate || null,
      })
      if (res?.ok) cancelEdit()
      else setErr(res?.error || 'Gagal menyimpan')
    } finally { setBusy(false) }
  }

  const doDelete = async (id) => {
    if (busy) return
    setBusy(true); setErr('')
    try {
      const res = await onDelete(id)
      if (res?.ok) setDelId(null)
      else setErr(res?.error || 'Gagal menghapus')
    } finally { setBusy(false) }
  }

  const th = { color: 'var(--text-muted)', fontFamily: 'Syne', fontSize: 10, letterSpacing: '0.06em' }

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
              <tr><td colSpan={showDue ? 11 : 10} className="px-2 py-6 text-center" style={{ color: 'var(--text-muted)' }}>Tidak ada data</td></tr>
            )}
            {rows.map(r => {
              const s = STATUS_MAP[r.status] || { label: r.status || '-', color: 'gray' }
              if (editId === r.id) {
                return (
                  <tr key={r.id} style={{ borderBottom: '1px solid var(--border)', background: 'rgba(139,92,246,0.05)' }}>
                    <td className="px-2 py-2" style={{ color: 'var(--text-muted)' }}>{r.invoiceNo || '—'}</td>
                    <td className="px-2 py-2" colSpan={showDue ? 9 : 8}>
                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                        <input value={form.customer} onChange={e => setForm(p => ({ ...p, customer: e.target.value }))}
                          placeholder="Customer" className="px-2 py-1.5 rounded-lg text-xs"
                          style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', color: 'var(--text-primary)' }} />
                        <input value={form.total} onChange={e => setForm(p => ({ ...p, total: e.target.value.replace(/[^\d]/g, '') }))}
                          placeholder="Total" inputMode="numeric" className="px-2 py-1.5 rounded-lg text-xs"
                          style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', color: 'var(--text-primary)' }} />
                        <input value={form.discount} onChange={e => setForm(p => ({ ...p, discount: e.target.value.replace(/[^\d]/g, '') }))}
                          placeholder="Diskon" inputMode="numeric" className="px-2 py-1.5 rounded-lg text-xs"
                          style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', color: 'var(--text-primary)' }} />
                        <input value={form.paid} onChange={e => setForm(p => ({ ...p, paid: e.target.value.replace(/[^\d]/g, '') }))}
                          placeholder="Dibayar" inputMode="numeric" className="px-2 py-1.5 rounded-lg text-xs"
                          style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', color: 'var(--text-primary)' }} />
                        <select value={form.paymentMethod} onChange={e => setForm(p => ({ ...p, paymentMethod: e.target.value }))}
                          className="px-2 py-1.5 rounded-lg text-xs"
                          style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}>
                          {['cash', 'transfer', 'qris', 'hutang'].map(m => <option key={m} value={m}>{PAY_LABEL[m]}</option>)}
                        </select>
                        <input type="date" value={form.dueDate || ''} onChange={e => setForm(p => ({ ...p, dueDate: e.target.value }))}
                          className="px-2 py-1.5 rounded-lg text-xs" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', color: 'var(--text-primary)', colorScheme: 'dark' }} />
                      </div>
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
              if (delId === r.id) {
                return (
                  <tr key={r.id} style={{ borderBottom: '1px solid var(--border)', background: 'rgba(255,77,106,0.05)' }}>
                    <td className="px-2 py-2.5" colSpan={showDue ? 10 : 9} style={{ color: 'var(--text-secondary)' }}>
                      Hapus invoice <strong>{r.invoiceNo || '—'}</strong>? Data piutang & pembayaran terkait ikut terhapus.
                    </td>
                    <td className="px-2 py-2.5 text-right whitespace-nowrap">
                      <div className="flex gap-1 justify-end">
                        <button onClick={() => doDelete(r.id)} disabled={busy}
                          className="px-2 h-7 rounded-lg inline-flex items-center justify-center text-[11px] font-bold"
                          style={{ background: 'rgba(255,77,106,0.12)', color: 'var(--red)', border: '1px solid rgba(255,77,106,0.3)' }}>
                          {busy ? <Loader2 size={12} className="animate-spin" /> : 'Hapus'}
                        </button>
                        <button onClick={() => setDelId(null)} disabled={busy}
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
                    {onEdit && onDelete && r.editable !== false && (
                      <div className="flex gap-1 justify-end">
                        <button onClick={() => startEdit(r)} title="Edit"
                          className="w-7 h-7 rounded-lg inline-flex items-center justify-center"
                          style={{ background: 'rgba(139,92,246,0.1)', color: 'var(--accent-light)', border: '1px solid rgba(139,92,246,0.2)' }}>
                          <Pencil size={12} />
                        </button>
                        <button onClick={() => setDelId(r.id)} title="Hapus"
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
