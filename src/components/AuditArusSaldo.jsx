import React, { useEffect, useMemo, useState } from 'react'
import { TrendingUp, TrendingDown, Scale, Loader2, ChevronRight, ChevronDown, CheckCircle2, AlertTriangle } from 'lucide-react'
import Modal from './Modal'
import { formatRupiah, formatDateTimeWIB } from '../utils/helpers'

const RANGES = [
  { id: 'today', label: 'Hari Ini' }, { id: 'week', label: 'Minggu Ini' },
  { id: 'month', label: 'Bulan Ini' }, { id: 'year', label: 'Tahun Ini' }, { id: 'all', label: 'All Time' },
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
const mlow = (m) => String(m || '').toLowerCase()

// Kelompokkan baris masuk → kategori audit.
function groupMasuk(masuk) {
  const g = {
    pjCash: { label: 'Penjualan Lunas Cash', rows: [] },
    pjTransfer: { label: 'Penjualan Lunas Transfer', rows: [] },
    pjQris: { label: 'Penjualan Lunas QRIS', rows: [] },
    dp: { label: 'DP Diterima (Hutang)', rows: [] },
    piutang: { label: 'Pembayaran / Cicilan Piutang', rows: [] },
    aset: { label: 'Penjualan Aset', rows: [] },
    lain: { label: 'Pemasukan Lain (Credibook/Kasbon/Migrasi)', rows: [] },
  }
  masuk.forEach(r => {
    const m = mlow(r.method)
    if (r.source === 'Penjualan') {
      if (m === 'transfer') g.pjTransfer.rows.push(r)
      else if (m === 'qris') g.pjQris.rows.push(r)
      else if (m === 'hutang') g.dp.rows.push(r)
      else g.pjCash.rows.push(r)
    } else if (r.source === 'Pembayaran Piutang') g.piutang.rows.push(r)
    else if (r.source === 'Penjualan Aset') g.aset.rows.push(r)
    else g.lain.rows.push(r)
  })
  return g
}
// Kelompokkan baris keluar → kategori audit (pakai kind/category dari getOutflowTransactions).
function groupKeluar(keluar) {
  const g = {
    operasional: { label: 'Pengeluaran Operasional', rows: [] },
    bahan: { label: 'Pembelian Bahan', rows: [] },
    gaji: { label: 'Gaji', rows: [] },
    kasbon: { label: 'Kasbon Karyawan', rows: [] },
    supplier: { label: 'Angsuran Hutang Supplier', rows: [] },
    bank: { label: 'Angsuran Hutang Bank', rows: [] },
    sewa: { label: 'Pembayaran Sewa', rows: [] },
    lain: { label: 'Pengeluaran Lain', rows: [] },
  }
  keluar.forEach(r => {
    const cat = String(r.category || ''); const kind = r.kind
    if (kind === 'kasbon') g.kasbon.rows.push(r)
    else if (kind === 'supplier_payment') g.supplier.rows.push(r)
    else if (kind === 'bank_payment') g.bank.rows.push(r)
    else if (r.source === 'Sewa Dibayar Dimuka') g.sewa.rows.push(r)
    else if (cat === 'Pembelian Bahan' || kind === 'purchase') g.bahan.rows.push(r)
    else if (cat === 'Gaji' || cat === 'Gaji Karyawan') g.gaji.rows.push(r)
    else if (kind === 'expense') g.operasional.rows.push(r)
    else g.lain.rows.push(r)
  })
  return g
}
const sumRows = (rows) => rows.reduce((s, r) => s + Math.round(r.amount || 0), 0)

export default function AuditArusSaldo({ open, onClose, loadCashflow, loadSummary, getOutflowTotal, admins = [], initialFrom, initialTo, onInvoiceClick }) {
  const [rangeId, setRangeId] = useState('today')
  const [custom, setCustom] = useState({ from: '', to: '' })
  const range = useMemo(() => rangeId === 'custom' ? { from: custom.from || ymd(new Date()), to: custom.to || ymd(new Date()) } : computeRange(rangeId), [rangeId, custom])

  const [data, setData] = useState({ masuk: [], keluar: [], totalMasuk: 0, totalKeluar: 0 })
  const [rpcMasuk, setRpcMasuk] = useState(null)
  const [loading, setLoading] = useState(false)
  const [expand, setExpand] = useState({})       // kategori yang dibuka (trace)
  const [check, setCheck] = useState(null)        // hasil Cek Rumus

  const adminName = (id) => { const a = admins.find(x => x.id === id); return a ? (a.name || a.username) : '—' }

  useEffect(() => {
    if (!open || !initialFrom || !initialTo) return
    const preset = RANGES.map(r => r.id).find(id => { const r = computeRange(id); return r.from === initialFrom && r.to === initialTo })
    if (preset) setRangeId(preset); else { setCustom({ from: initialFrom, to: initialTo }); setRangeId('custom') }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    if (!open) return
    let alive = true
    setLoading(true); setCheck(null); setExpand({})
    Promise.all([loadCashflow(range.from, range.to), loadSummary ? loadSummary(range.from, range.to) : Promise.resolve(null)])
      .then(([r, s]) => {
        if (!alive) return
        setData(r?.ok ? r : { masuk: [], keluar: [], totalMasuk: 0, totalKeluar: 0 })
        setRpcMasuk((s && s.ok && s.data) ? Math.round(s.data.uang_masuk_total || 0) : null)
        setLoading(false)
      })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, range.from, range.to])

  const gMasuk = useMemo(() => groupMasuk(data.masuk || []), [data])
  const gKeluar = useMemo(() => groupKeluar(data.keluar || []), [data])
  const totalMasuk = rpcMasuk != null ? rpcMasuk : data.totalMasuk
  const totalKeluar = data.totalKeluar
  const net = totalMasuk - totalKeluar
  const reconDiff = Math.round(totalMasuk - (data.totalMasuk || 0))

  const doCheck = async () => {
    // Hitung ulang dari rincian, bandingkan dengan angka dashboard (RPC).
    const sumItem = sumRows(data.masuk || [])
    const diff = rpcMasuk != null ? (rpcMasuk - sumItem) : 0
    setCheck({ ok: Math.abs(diff) <= 1, diff, sumItem, rpc: rpcMasuk })
  }

  const inp = { background: 'var(--bg-card)', border: '1px solid var(--border)', color: 'var(--text-primary)', colorScheme: 'dark' }

  const Section = ({ title, color, groups, order, extra }) => (
    <div className="rounded-2xl p-3 mb-3" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
      <div className="text-xs font-bold uppercase tracking-wider mb-2" style={{ color, fontFamily: 'Syne' }}>{title}</div>
      {order.map(key => {
        const grp = groups[key]; if (!grp) return null
        const tot = sumRows(grp.rows)
        if (tot === 0 && grp.rows.length === 0) return null
        const opened = expand[key]
        return (
          <div key={key} style={{ borderBottom: '1px solid var(--border)' }}>
            <button onClick={() => setExpand(e => ({ ...e, [key]: !e[key] }))} className="w-full flex items-center justify-between py-2 text-left">
              <span className="text-xs inline-flex items-center gap-1" style={{ color: 'var(--text-secondary)' }}>
                {grp.rows.length > 0 ? (opened ? <ChevronDown size={12} /> : <ChevronRight size={12} />) : <span style={{ width: 12 }} />} {grp.label}
                <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>({grp.rows.length})</span>
              </span>
              <span className="text-xs font-bold" style={{ color, fontVariantNumeric: 'tabular-nums' }}>{fmt(tot)}</span>
            </button>
            {opened && grp.rows.length > 0 && (
              <div className="pb-2 pl-4">
                <table className="w-full text-[11px]" style={{ borderCollapse: 'collapse' }}>
                  <thead><tr style={{ color: 'var(--text-muted)' }}>{['Tanggal & Jam', 'Ref/Invoice', 'Admin', 'Metode', 'Nominal'].map((h, i) => <th key={i} className={`py-1 ${i === 4 ? 'text-right' : 'text-left'}`} style={{ fontWeight: 600 }}>{h}</th>)}</tr></thead>
                  <tbody>
                    {grp.rows.map((r, i) => (
                      <tr key={`${r.id}-${i}`} style={{ borderTop: '1px solid var(--border)' }}>
                        <td className="py-1 whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>{formatDateTimeWIB(r.date, r.createdAt)}</td>
                        <td className="py-1" style={{ color: 'var(--text-secondary)' }}>
                          {onInvoiceClick && r.invoiceNo ? <button onClick={() => onInvoiceClick(r.invoiceNo)} className="underline decoration-dotted" style={{ color: 'var(--accent-light)' }}>{r.ref || r.invoiceNo}</button> : (r.ref || r.category || '—')}
                        </td>
                        <td className="py-1" style={{ color: 'var(--text-muted)' }}>{r.cashierId ? adminName(r.cashierId) : '—'}</td>
                        <td className="py-1 uppercase" style={{ color: 'var(--text-muted)' }}>{r.method || '—'}</td>
                        <td className="py-1 text-right font-semibold" style={{ color, fontVariantNumeric: 'tabular-nums' }}>{fmt(r.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )
      })}
      {extra}
      <div className="flex items-center justify-between pt-2 mt-1 font-bold" style={{ borderTop: '2px solid var(--border-strong)' }}>
        <span className="text-xs" style={{ color: 'var(--text-primary)', fontFamily: 'Syne' }}>TOTAL</span>
        <span className="text-sm" style={{ color, fontVariantNumeric: 'tabular-nums' }}>{fmt(title.includes('MASUK') ? totalMasuk : totalKeluar)}</span>
      </div>
    </div>
  )

  return (
    <Modal open={open} onClose={onClose} title="Audit Arus Saldo Bersih" subtitle="Telusuri setiap angka sampai ke transaksi" size="xl" mobileFull>
      {/* Filter */}
      <div className="flex flex-wrap gap-1.5 mb-3">
        {RANGES.map(r => (
          <button key={r.id} onClick={() => setRangeId(r.id)} className="px-3 py-1.5 rounded-lg text-xs font-semibold"
            style={{ background: rangeId === r.id ? 'linear-gradient(135deg, var(--accent), #6366f1)' : 'var(--bg-card)', color: rangeId === r.id ? '#fff' : 'var(--text-secondary)', border: `1px solid ${rangeId === r.id ? 'transparent' : 'var(--border)'}`, fontFamily: 'Syne' }}>{r.label}</button>
        ))}
        <input type="date" value={custom.from} onChange={e => { setCustom(c => ({ ...c, from: e.target.value })); setRangeId('custom') }} className="px-2 py-1.5 rounded-lg text-xs" style={inp} />
        <input type="date" value={custom.to} onChange={e => { setCustom(c => ({ ...c, to: e.target.value })); setRangeId('custom') }} className="px-2 py-1.5 rounded-lg text-xs" style={inp} />
      </div>

      {loading ? <div className="flex justify-center py-10"><Loader2 size={22} className="animate-spin" style={{ color: 'var(--accent-light)' }} /></div> : (
        <>
          {/* Rumus */}
          <div className="rounded-2xl p-4 mb-4 text-center" style={{ background: 'linear-gradient(180deg, rgba(20,184,166,0.08), rgba(99,102,241,0.05))', border: '1px solid rgba(20,184,166,0.3)' }}>
            <div className="flex items-center justify-center gap-2 flex-wrap text-sm">
              <span style={{ color: '#10d98a', fontWeight: 700, fontFamily: 'Syne' }}>{fmt(totalMasuk)}</span>
              <span style={{ color: 'var(--text-muted)' }}>(Masuk)</span>
              <span style={{ color: 'var(--text-muted)' }}>−</span>
              <span style={{ color: '#ef4444', fontWeight: 700, fontFamily: 'Syne' }}>{fmt(totalKeluar)}</span>
              <span style={{ color: 'var(--text-muted)' }}>(Keluar)</span>
              <span style={{ color: 'var(--text-muted)' }}>=</span>
            </div>
            <div className="mt-1 font-extrabold" style={{ color: net >= 0 ? '#14b8a6' : '#ef4444', fontFamily: 'Syne', fontSize: 'clamp(18px,5vw,26px)' }}>{fmt(net)}</div>
            <div className="text-[10px] uppercase tracking-wider mt-0.5" style={{ color: 'var(--text-muted)' }}>Arus Saldo Bersih</div>
          </div>

          {/* Cek Rumus */}
          <div className="flex items-center gap-2 mb-3 flex-wrap">
            <button onClick={doCheck} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-bold btn-press" style={{ background: 'rgba(139,92,246,0.12)', color: 'var(--accent-light)', border: '1px solid rgba(139,92,246,0.3)', fontFamily: 'Syne' }}>
              <Scale size={13} /> Cek Rumus
            </button>
            {check && (
              <span className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-xl" style={{ background: check.ok ? 'rgba(16,217,138,0.1)' : 'rgba(239,68,68,0.1)', color: check.ok ? '#10d98a' : '#ef4444', border: `1px solid ${check.ok ? 'rgba(16,217,138,0.3)' : 'rgba(239,68,68,0.3)'}` }}>
                {check.ok ? <><CheckCircle2 size={13} /> Cocok — rincian = dashboard</> : <><AlertTriangle size={13} /> Selisih ditemukan: {fmt(Math.abs(check.diff))}</>}
              </span>
            )}
          </div>
          {check && !check.ok && (
            <div className="rounded-xl p-3 mb-3 text-[11px]" style={{ background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.25)', color: 'var(--text-secondary)' }}>
              Dashboard (RPC): <b>{fmt(check.rpc)}</b> · Jumlah rincian: <b>{fmt(check.sumItem)}</b> · Selisih <b style={{ color: '#ef4444' }}>{fmt(check.diff)}</b>.
              Selisih ditampilkan sebagai baris "Penerimaan Lain (penyeimbang)" agar audit transparan. Kirim ke developer bila perlu ditelusuri sumbernya.
            </div>
          )}

          <Section title="RINCIAN UANG MASUK" color="#10d98a" groups={gMasuk}
            order={['pjCash', 'pjTransfer', 'pjQris', 'dp', 'piutang', 'aset', 'lain']}
            extra={reconDiff > 0 ? (
              <div className="flex items-center justify-between py-2" style={{ borderBottom: '1px solid var(--border)' }}>
                <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>Penerimaan Lain (penyeimbang ke dashboard)</span>
                <span className="text-xs font-bold" style={{ color: '#10d98a', fontVariantNumeric: 'tabular-nums' }}>{fmt(reconDiff)}</span>
              </div>
            ) : null}
          />
          <Section title="RINCIAN UANG KELUAR" color="#ef4444" groups={gKeluar}
            order={['operasional', 'bahan', 'gaji', 'kasbon', 'supplier', 'bank', 'sewa', 'lain']} />
        </>
      )}
    </Modal>
  )
}
