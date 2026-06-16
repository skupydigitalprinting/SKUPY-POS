import React, { useEffect, useMemo, useState } from 'react'
import { Wallet, Landmark, Smartphone, Scale, Loader2, ArrowDownCircle, ArrowUpCircle } from 'lucide-react'
import Modal from './Modal'
import { formatRupiah, formatDate } from '../utils/helpers'

const fmt = (n) => formatRupiah(Math.round(Number(n) || 0))
const ymd = (d) => d.toISOString().slice(0, 10)
const ALL_TIME_FROM = '2000-01-01'

/**
 * Detail Saldo (Kas & Bank) — rincian per metode + histori mutasi (all-time).
 * Saldo selalu kumulatif (≤ hari ini), bukan ikut filter tanggal.
 *
 * props:
 *   open, onClose
 *   d            → objek acc_dashboard (saldo_kas, saldo_rekening, masuk_*, keluar_*)
 *   loadCashflow → getCashflowDetail(from,to) untuk histori mutasi
 *   onInvoiceClick(invoiceNo) opsional
 */
export default function SaldoDetail({ open, onClose, d, loadCashflow, onInvoiceClick }) {
  const [cf, setCf] = useState({ masuk: [], keluar: [], totalMasuk: 0, totalKeluar: 0 })
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open) return
    let alive = true
    setLoading(true)
    loadCashflow(ALL_TIME_FROM, ymd(new Date())).then(r => {
      if (!alive) return
      setCf(r?.ok ? r : { masuk: [], keluar: [], totalMasuk: 0, totalKeluar: 0 })
      setLoading(false)
    })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Saldo per metode (semua diturunkan dari acc_dashboard, rekonsiliasi pas).
  const m = useMemo(() => {
    const saldoKas = Math.round(d?.saldo_kas || 0)
    const saldoRek = Math.round(d?.saldo_rekening || 0)
    const masukT = Math.round(d?.masuk_transfer || 0), keluarT = Math.round(d?.keluar_transfer || 0)
    const masukQ = Math.round(d?.masuk_qris || 0), keluarQ = Math.round(d?.keluar_qris || 0)
    // saldo_rekening = awal_bank + masukT + masukQ − keluarT − keluarQ
    // → awal_bank = saldo_rekening − (masukT + masukQ − keluarT − keluarQ)
    const awalBank = saldoRek - (masukT + masukQ - keluarT - keluarQ)
    const saldoQris = masukQ - keluarQ
    const saldoTransfer = saldoRek - saldoQris // termasuk saldo awal bank
    return { saldoKas, saldoTransfer, saldoQris, total: saldoKas + saldoRek, saldoAwal: Math.round(d?.saldo_awal || 0), awalBank }
  }, [d])

  const rows = useMemo(() => [...cf.masuk, ...cf.keluar].sort((a, b) => new Date(b.date) - new Date(a.date)), [cf])

  const Card = ({ icon: Icon, label, value, color }) => (
    <div className="rounded-2xl p-3.5 min-w-0" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
      <div className="flex items-center gap-1.5 mb-1"><Icon size={13} style={{ color }} /><span className="text-xs font-semibold" style={{ color: 'var(--text-secondary)', fontFamily: 'Syne' }}>{label}</span></div>
      <div className="font-bold" style={{ fontFamily: 'Syne', color, fontSize: 'clamp(14px,3.6vw,18px)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{fmt(value)}</div>
    </div>
  )

  return (
    <Modal open={open} onClose={onClose} title="Rincian Saldo (Kas & Bank)"
      subtitle="Uang riil — kumulatif s/d hari ini" size="xl" mobileFull>
      {/* Saldo per metode */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-3">
        <Card icon={Wallet} label="Kas (Cash)" value={m.saldoKas} color="#10d98a" />
        <Card icon={Landmark} label="Bank / Transfer" value={m.saldoTransfer} color="#3b82f6" />
        <Card icon={Smartphone} label="QRIS" value={m.saldoQris} color="#a78bfa" />
        <div className="rounded-2xl p-3.5 min-w-0" style={{ background: m.total >= 0 ? 'rgba(20,184,166,0.1)' : 'rgba(239,68,68,0.1)', border: `1px solid ${m.total >= 0 ? 'rgba(20,184,166,0.4)' : 'rgba(239,68,68,0.4)'}` }}>
          <div className="flex items-center gap-1.5 mb-1"><Scale size={13} style={{ color: '#14b8a6' }} /><span className="text-xs font-semibold" style={{ color: 'var(--text-secondary)', fontFamily: 'Syne' }}>Total Saldo</span></div>
          <div className="font-bold" style={{ fontFamily: 'Syne', color: m.total >= 0 ? '#14b8a6' : '#ef4444', fontSize: 'clamp(14px,3.6vw,18px)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{fmt(m.total)}</div>
        </div>
      </div>

      {/* Identitas rekonsiliasi */}
      <div className="rounded-xl p-3 mb-4 text-[11px] flex flex-wrap items-center gap-x-2 gap-y-1" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', color: 'var(--text-muted)' }}>
        <span>Saldo Awal <b style={{ color: 'var(--text-secondary)' }}>{fmt(m.saldoAwal)}</b></span><span>+</span>
        <span>Masuk <b style={{ color: '#10d98a' }}>{fmt(cf.totalMasuk)}</b></span><span>−</span>
        <span>Keluar <b style={{ color: '#ef4444' }}>{fmt(cf.totalKeluar)}</b></span><span>=</span>
        <span><b style={{ color: '#14b8a6' }}>{fmt(m.saldoAwal + cf.totalMasuk - cf.totalKeluar)}</b></span>
      </div>

      <div className="text-xs font-bold uppercase tracking-wider mb-2" style={{ color: 'var(--text-muted)', fontFamily: 'Syne' }}>Histori Mutasi (semua waktu)</div>
      {loading ? (
        <div className="flex justify-center py-8"><Loader2 size={20} className="animate-spin" style={{ color: 'var(--accent-light)' }} /></div>
      ) : rows.length === 0 ? (
        <p className="text-xs text-center py-8" style={{ color: 'var(--text-muted)' }}>Belum ada mutasi</p>
      ) : (
        <div className="overflow-x-auto -mx-1">
          <table className="w-full text-xs" style={{ borderCollapse: 'collapse', minWidth: 720 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                {['Tanggal', 'Tipe', 'Sumber', 'Referensi', 'Metode', 'Nominal'].map((h, i) => (
                  <th key={i} className={`px-2 py-2 font-bold uppercase tracking-wider ${i === 5 ? 'text-right' : 'text-left'}`}
                    style={{ color: 'var(--text-muted)', fontFamily: 'Syne', fontSize: 10, letterSpacing: '0.06em', whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, idx) => {
                const masuk = r.type === 'masuk'
                const color = masuk ? '#10d98a' : '#ef4444'
                const clickable = onInvoiceClick && r.invoiceNo
                return (
                  <tr key={`${r.type}-${r.id}-${idx}`} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td className="px-2 py-2.5 whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>{formatDate(r.date)}</td>
                    <td className="px-2 py-2.5">
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded font-bold" style={{ fontSize: 9, textTransform: 'uppercase', color, background: `${color}1f` }}>
                        {masuk ? <ArrowDownCircle size={10} /> : <ArrowUpCircle size={10} />}{masuk ? 'Masuk' : 'Keluar'}
                      </span>
                    </td>
                    <td className="px-2 py-2.5" style={{ color: 'var(--text-primary)', fontFamily: 'Syne', whiteSpace: 'nowrap' }}>{r.source}</td>
                    <td className="px-2 py-2.5" style={{ color: 'var(--text-secondary)' }}>
                      {clickable
                        ? <button onClick={() => onInvoiceClick(r.invoiceNo)} className="underline decoration-dotted" style={{ color: 'var(--accent-light)', fontWeight: 600 }}>{r.ref || r.invoiceNo}</button>
                        : (r.ref || r.category || '—')}
                    </td>
                    <td className="px-2 py-2.5 uppercase" style={{ color: 'var(--text-muted)', fontSize: 10 }}>{r.method || '—'}</td>
                    <td className="px-2 py-2.5 text-right font-bold whitespace-nowrap" style={{ color, fontVariantNumeric: 'tabular-nums' }}>{masuk ? '+' : '−'}{fmt(r.amount)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  )
}
