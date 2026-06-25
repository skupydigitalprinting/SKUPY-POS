import React, { useEffect, useMemo, useState } from 'react'
import { TrendingUp, TrendingDown, Scale, Loader2, ArrowDownCircle, ArrowUpCircle } from 'lucide-react'
import Modal from './Modal'
import { formatRupiah, formatDateTimeWIB } from '../utils/helpers'

const RANGES = [
  { id: 'today', label: 'Hari Ini' },
  { id: 'week', label: 'Minggu Ini' },
  { id: 'month', label: 'Bulan Ini' },
  { id: 'year', label: 'Tahun Ini' },
  { id: 'all', label: 'All Time' },
]
const ymd = (d) => d.toISOString().slice(0, 10)
function computeRange(id) {
  const now = new Date()
  if (id === 'today') return { from: ymd(now), to: ymd(now) }
  if (id === 'week') { const d = new Date(now); const dow = (d.getDay() + 6) % 7; d.setDate(d.getDate() - dow); return { from: ymd(d), to: ymd(now) } }
  if (id === 'month') return { from: ymd(new Date(now.getFullYear(), now.getMonth(), 1)), to: ymd(now) }
  if (id === 'year') return { from: ymd(new Date(now.getFullYear(), 0, 1)), to: ymd(now) }
  return { from: '2000-01-01', to: ymd(now) }
}

const fmt = (n) => formatRupiah(Math.round(Number(n) || 0))

// loadCashflow(from,to) → { ok, masuk[], keluar[], totalMasuk, totalKeluar, net }
// onInvoiceClick(invoiceNo) opsional → buka preview invoice.
export default function ArusKasDetail({ open, onClose, loadCashflow, loadSummary, onInvoiceClick, initialFrom, initialTo, cardCashIn, cardCashOut, cardNet }) {
  const [rangeId, setRangeId] = useState('today')
  const [custom, setCustom] = useState({ from: '', to: '' })
  const range = useMemo(() => {
    if (rangeId === 'custom') return { from: custom.from || ymd(new Date()), to: custom.to || ymd(new Date()) }
    return computeRange(rangeId)
  }, [rangeId, custom])

  const [data, setData] = useState({ masuk: [], keluar: [], pending: [], totalMasuk: 0, totalKeluar: 0, net: 0 })
  // Total Masuk OTORITATIF = sama dengan kartu "Uang Masuk" dashboard (acc_dashboard.uang_masuk_total).
  const [rpcMasuk, setRpcMasuk] = useState(null)
  const [loading, setLoading] = useState(false)

  // Saat dibuka dari kartu, ikuti periode halaman (from/to) agar nilainya SAMA
  // dengan kartu Uang Masuk / Arus Saldo. Cocokkan ke preset bila pas.
  useEffect(() => {
    if (!open || !initialFrom || !initialTo) return
    const presetId = (RANGES.map(r => r.id).find(id => { const r = computeRange(id); return r.from === initialFrom && r.to === initialTo }))
    if (presetId) setRangeId(presetId)
    else { setCustom({ from: initialFrom, to: initialTo }); setRangeId('custom') }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    if (!open) return
    let alive = true
    setLoading(true)
    Promise.all([
      loadCashflow(range.from, range.to),
      loadSummary ? loadSummary(range.from, range.to) : Promise.resolve(null),
    ]).then(([r, s]) => {
      if (!alive) return
      // Uang Masuk operasional TIDAK termasuk pembayaran kasbon karyawan → buang dari masuk.
      if (r?.ok) {
        const masukOps = (r.masuk || []).filter(x => x.source !== 'Pembayaran Kasbon')
        r = { ...r, masuk: masukOps, totalMasuk: masukOps.reduce((sum, x) => sum + Math.round(x.amount || 0), 0) }
      }
      setData(r?.ok ? r : { masuk: [], keluar: [], pending: [], totalMasuk: 0, totalKeluar: 0, net: 0 })
      // RPC uang_masuk_total dikurangi pembayaran kasbon (kasbon_masuk) agar konsisten dgn kartu.
      setRpcMasuk((s && s.ok && s.data) ? Math.round((s.data.uang_masuk_total || 0) - (s.data.kasbon_masuk || 0)) : null)
      setLoading(false)
    })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, range.from, range.to])

  // HELPER TUNGGAL dari kartu dashboard. Saat periode popup = periode halaman,
  // headline memakai angka kartu PERSIS (totalCashIn/Out/net) supaya
  // Arus Saldo Bersih popup = kartu = Uang Masuk − Uang Keluar.
  const atPagePeriod = initialFrom && initialTo && range.from === initialFrom && range.to === initialTo
  const useCard = atPagePeriod && cardNet != null
  // Total Masuk = angka dashboard (RPC) bila tersedia; fallback ke jumlah rincian.
  const totalMasuk = useCard ? Math.round(cardCashIn || 0) : (rpcMasuk != null ? rpcMasuk : data.totalMasuk)
  const totalKeluar = useCard ? Math.round(cardCashOut || 0) : data.totalKeluar
  const net = useCard ? Math.round(cardNet) : totalMasuk - totalKeluar
  // Selisih rekonsiliasi: bila jumlah baris masuk < angka dashboard, tampilkan 1
  // baris penyeimbang agar tabel = Total Masuk (transparan, biasanya 0).
  const reconDiff = Math.round(totalMasuk - (data.totalMasuk || 0))

  // Gabung & urutkan terbaru dulu untuk tabel. `pending` ikut TAMPIL tapi
  // TIDAK dihitung ke total (uang belum diterima).
  const rows = useMemo(() => {
    const extra = reconDiff > 0
      ? [{ id: 'recon', type: 'masuk', date: range.to, source: 'Penerimaan Lain', ref: 'Penyeimbang ke total dashboard', category: 'Rekonsiliasi', method: '—', status: 'valid', amount: reconDiff }]
      : []
    return [...data.masuk, ...extra, ...data.keluar, ...(data.pending || [])].sort((a, b) => new Date(b.date) - new Date(a.date))
  }, [data, reconDiff, range.to])

  // Breakdown per metode (cash / transfer / qris). 'hutang' (DP invoice hutang) → cash.
  const bd = useMemo(() => {
    const bucket = (mthd) => { const m = String(mthd || '').toLowerCase(); return m === 'transfer' ? 'transfer' : m === 'qris' ? 'qris' : 'cash' }
    const z = { cash: 0, transfer: 0, qris: 0 }
    const masuk = { ...z }, keluar = { ...z }
    data.masuk.forEach(r => { masuk[bucket(r.method)] += Math.round(r.amount || 0) })
    data.keluar.forEach(r => { keluar[bucket(r.method)] += Math.round(r.amount || 0) })
    if (reconDiff > 0) masuk.cash += reconDiff // penyeimbang → bucket Kas, agar total cocok
    return { masuk, keluar }
  }, [data, reconDiff])

  const inp = { background: 'var(--bg-card)', border: '1px solid var(--border)', color: 'var(--text-primary)', colorScheme: 'dark' }

  return (
    <Modal open={open} onClose={onClose} title="Detail — Arus Saldo (Kas & Bank)"
      subtitle="Mutasi saldo aktual: Cash · Transfer · QRIS" size="xl" mobileFull>
      {/* Filter waktu */}
      <div className="flex gap-1.5 mb-3 overflow-x-auto pb-1" style={{ scrollbarWidth: 'none' }}>
        {RANGES.map(r => (
          <button key={r.id} onClick={() => setRangeId(r.id)} className="flex-shrink-0 px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap"
            style={{ background: rangeId === r.id ? 'linear-gradient(135deg, var(--accent), #6366f1)' : 'var(--bg-card)', color: rangeId === r.id ? '#fff' : 'var(--text-secondary)', border: `1px solid ${rangeId === r.id ? 'transparent' : 'var(--border)'}`, fontFamily: 'Syne' }}>{r.label}</button>
        ))}
      </div>
      {/* Custom date */}
      <div className="flex flex-wrap items-end gap-2 mb-4">
        <div>
          <label className="block text-[10px] uppercase tracking-wider mb-1" style={{ color: 'var(--text-muted)' }}>Dari tanggal</label>
          <input type="date" value={custom.from} onChange={e => { setCustom(c => ({ ...c, from: e.target.value })); setRangeId('custom') }} className="px-2.5 py-1.5 rounded-lg text-xs" style={inp} />
        </div>
        <div>
          <label className="block text-[10px] uppercase tracking-wider mb-1" style={{ color: 'var(--text-muted)' }}>Sampai tanggal</label>
          <input type="date" value={custom.to} onChange={e => { setCustom(c => ({ ...c, to: e.target.value })); setRangeId('custom') }} className="px-2.5 py-1.5 rounded-lg text-xs" style={inp} />
        </div>
        {rangeId === 'custom' && <span className="text-[11px] px-2 py-1 rounded-lg" style={{ background: 'rgba(139,92,246,0.1)', color: 'var(--accent-light)' }}>Rentang kustom aktif</span>}
      </div>

      {/* Ringkasan */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
        <div className="rounded-2xl p-3.5" style={{ background: 'rgba(16,217,138,0.08)', border: '1px solid rgba(16,217,138,0.3)' }}>
          <div className="flex items-center gap-1.5 mb-1"><TrendingUp size={13} style={{ color: '#10d98a' }} /><span className="text-xs font-semibold" style={{ color: '#10d98a', fontFamily: 'Syne' }}>Total Masuk</span></div>
          <div className="font-bold" style={{ fontFamily: 'Syne', color: '#10d98a', fontSize: 'clamp(15px,4vw,20px)' }}>{fmt(totalMasuk)}</div>
        </div>
        <div className="rounded-2xl p-3.5" style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)' }}>
          <div className="flex items-center gap-1.5 mb-1"><TrendingDown size={13} style={{ color: '#ef4444' }} /><span className="text-xs font-semibold" style={{ color: '#ef4444', fontFamily: 'Syne' }}>Total Keluar</span></div>
          <div className="font-bold" style={{ fontFamily: 'Syne', color: '#ef4444', fontSize: 'clamp(15px,4vw,20px)' }}>{fmt(totalKeluar)}</div>
        </div>
        <div className="rounded-2xl p-3.5" style={{ background: net >= 0 ? 'rgba(20,184,166,0.1)' : 'rgba(239,68,68,0.1)', border: `1px solid ${net >= 0 ? 'rgba(20,184,166,0.4)' : 'rgba(239,68,68,0.4)'}` }}>
          <div className="flex items-center gap-1.5 mb-1"><Scale size={13} style={{ color: '#14b8a6' }} /><span className="text-xs font-semibold" style={{ color: 'var(--text-secondary)', fontFamily: 'Syne' }}>Arus Saldo Bersih</span></div>
          <div className="font-bold" style={{ fontFamily: 'Syne', color: net >= 0 ? '#14b8a6' : '#ef4444', fontSize: 'clamp(15px,4vw,20px)' }}>{fmt(net)}</div>
        </div>
      </div>

      {/* Breakdown per metode */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mb-4">
        {[
          ['Cash Masuk', bd.masuk.cash, '#10d98a'], ['Transfer Masuk', bd.masuk.transfer, '#10d98a'], ['QRIS Masuk', bd.masuk.qris, '#10d98a'],
          ['Cash Keluar', bd.keluar.cash, '#ef4444'], ['Transfer Keluar', bd.keluar.transfer, '#ef4444'], ['QRIS Keluar', bd.keluar.qris, '#ef4444'],
        ].map(([label, val, color]) => (
          <div key={label} className="rounded-xl px-3 py-2" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
            <div className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--text-muted)', letterSpacing: '0.04em' }}>{label}</div>
            <div className="text-xs font-bold" style={{ color, fontFamily: 'Syne', fontVariantNumeric: 'tabular-nums' }}>{fmt(val)}</div>
          </div>
        ))}
      </div>

      {/* Tabel */}
      {loading ? (
        <div className="flex justify-center py-8"><Loader2 size={20} className="animate-spin" style={{ color: 'var(--accent-light)' }} /></div>
      ) : rows.length === 0 ? (
        <p className="text-xs text-center py-8" style={{ color: 'var(--text-muted)' }}>Tidak ada mutasi saldo pada periode ini</p>
      ) : (
        <div className="overflow-x-auto -mx-1">
          <table className="w-full text-xs" style={{ borderCollapse: 'collapse', minWidth: 720 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                {['Tanggal', 'Tipe', 'Sumber', 'Kategori / Ref', 'Metode', 'Status', 'Nominal'].map((h, i) => (
                  <th key={i} className={`px-2 py-2 font-bold uppercase tracking-wider ${i === 6 ? 'text-right' : 'text-left'}`}
                    style={{ color: 'var(--text-muted)', fontFamily: 'Syne', fontSize: 10, letterSpacing: '0.06em', whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, idx) => {
                const isPending = r.type === 'pending'
                const masuk = r.type === 'masuk'
                const color = isPending ? '#94a3b8' : masuk ? '#10d98a' : '#ef4444'
                const refTxt = r.ref || r.category || '—'
                const clickable = onInvoiceClick && r.invoiceNo
                return (
                  <tr key={`${r.type}-${r.id}-${idx}`} style={{ borderBottom: '1px solid var(--border)', opacity: isPending ? 0.7 : 1 }}>
                    <td className="px-2 py-2.5 whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>{formatDateTimeWIB(r.date, r.createdAt)}</td>
                    <td className="px-2 py-2.5">
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded font-bold" style={{ fontSize: 9, textTransform: 'uppercase', color, background: `${color}1f` }}>
                        {isPending ? null : masuk ? <ArrowDownCircle size={10} /> : <ArrowUpCircle size={10} />}{isPending ? 'Pending' : masuk ? 'Masuk' : 'Keluar'}
                      </span>
                    </td>
                    <td className="px-2 py-2.5" style={{ color: 'var(--text-primary)', fontFamily: 'Syne', whiteSpace: 'nowrap' }}>{r.source}</td>
                    <td className="px-2 py-2.5" style={{ color: 'var(--text-secondary)' }}>
                      {clickable ? (
                        <button onClick={() => onInvoiceClick(r.invoiceNo)} className="underline decoration-dotted" style={{ color: 'var(--accent-light)', fontWeight: 600 }}>{refTxt}</button>
                      ) : (r.category && r.ref ? `${r.category} · ${r.ref}` : refTxt)}
                    </td>
                    <td className="px-2 py-2.5 uppercase" style={{ color: 'var(--text-muted)', fontSize: 10 }}>{r.method || '—'}</td>
                    <td className="px-2 py-2.5 uppercase" style={{ color: 'var(--text-muted)', fontSize: 10 }}>{r.status || '—'}</td>
                    <td className="px-2 py-2.5 text-right font-bold whitespace-nowrap" style={{ color, fontVariantNumeric: 'tabular-nums' }}>
                      {isPending ? '(belum)' : (masuk ? '+' : '−') + ''}{isPending ? ' ' : ''}{fmt(r.amount)}
                    </td>
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
