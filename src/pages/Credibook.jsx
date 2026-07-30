import React, { useEffect, useMemo, useState } from 'react'
import {
  TrendingUp, TrendingDown, Scale, Plus, Pencil, Trash2, Check, X, Loader2,
  Receipt, Wallet, Calendar, NotebookPen, ArrowRight,
} from 'lucide-react'
import { formatRupiah, formatCurrency, parseCurrency, formatDateTimeWIB } from '../utils/helpers'
import { useAccounting } from '../hooks/useAccounting'
import { useToast } from '../components/Toast'
import { useConfirm } from '../components/Confirm'

const METHODS = [{ id: 'cash', label: 'Cash' }, { id: 'transfer', label: 'Transfer' }, { id: 'qris', label: 'QRIS' }]
// Jenis pemasukkan → hanya 'omzet' yang menambah Omset. Lainnya = kas masuk saja.
const INCOME_TYPES = [
  { id: 'omzet', label: 'Omset', hint: 'Pendapatan usaha → menambah Omset' },
  { id: 'refund', label: 'Refund', hint: 'Uang kembali → kas masuk, bukan Omset' },
  { id: 'capital', label: 'Modal Tambahan', hint: 'Suntikan modal → kas & aset, bukan Omset/Laba' },
  { id: 'other', label: 'Pemasukkan Lainnya', hint: 'Kas masuk lain → bukan Omset' },
]
const ITYPE_LABEL = Object.fromEntries(INCOME_TYPES.map(t => [t.id, t.label]))
const ITYPE_COLOR = { omzet: '#10d98a', refund: '#3b82f6', capital: '#a78bfa', other: '#64748b' }
const fmt = (n) => formatRupiah(Math.round(Number(n) || 0))
const dt = (d) => (d ? new Date(d).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' }) : '—')
const todayISO = () => new Date().toISOString().slice(0, 10)
// Format tanggal LOKAL (WIB-accurate, bukan UTC) untuk SEMUA preset.
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

// Rentang waktu cepat
const RANGES = [
  { id: 'today', label: 'Hari Ini' },
  { id: 'week', label: 'Minggu Ini' },
  { id: 'month', label: 'Bulan Ini' },
  { id: 'lastmonth', label: 'Bulan Lalu' },
  { id: 'year', label: 'Tahun Ini' },
  { id: 'all', label: 'Semua Waktu' },
]
function computeRange(id) {
  const now = new Date()
  if (id === 'today') return { from: ymd(now), to: ymd(now) }
  if (id === 'week') { const d = new Date(now); const dow = (d.getDay() + 6) % 7; d.setDate(d.getDate() - dow); return { from: ymd(d), to: ymd(now) } }
  if (id === 'month') return { from: ymd(new Date(now.getFullYear(), now.getMonth(), 1)), to: ymd(now) }
  if (id === 'lastmonth') return { from: ymd(new Date(now.getFullYear(), now.getMonth() - 1, 1)), to: ymd(new Date(now.getFullYear(), now.getMonth(), 0)) }
  if (id === 'year') return { from: ymd(new Date(now.getFullYear(), 0, 1)), to: ymd(now) }
  return { from: '2000-01-01', to: ymd(now) }
}

function MoneyInput({ value, onChange, placeholder = '0', className, style }) {
  const display = (value === '' || value == null) ? '' : formatCurrency(value)
  return <input inputMode="numeric" value={display} placeholder={placeholder}
    onChange={(e) => { const d = (e.target.value || '').replace(/[^\d]/g, ''); onChange(d === '' ? '' : String(parseInt(d, 10))) }}
    className={className} style={style} />
}

// Kartu statistik dashboard Credibook (module-level).
function MiniCard({ icon: Icon, label, value, color, sub, highlight }) {
  return (
    <div className="rounded-2xl p-4 min-w-0" style={{ background: highlight ? `${color}14` : 'var(--bg-card)', border: `1px solid ${highlight ? `${color}66` : 'var(--border)'}` }}>
      <div className="flex items-center gap-2 mb-2">
        <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: `${color}1f`, border: `1px solid ${color}4d` }}>
          <Icon size={15} style={{ color }} />
        </div>
        <span className="text-xs font-semibold leading-tight" style={{ color: 'var(--text-secondary)' }}>{label}</span>
      </div>
      <div className="font-bold" style={{ fontFamily: 'Syne', color, fontSize: 'clamp(15px,4.4vw,22px)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{fmt(value)}</div>
      {sub && <div className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>{sub}</div>}
    </div>
  )
}

// Module-level (jangan di dalam komponen) agar input tidak remount tiap ketik.
function Field({ icon: Icon, label, required, error, children }) {
  return (
    <div>
      <label className="flex items-center gap-1.5 mb-1.5 text-xs font-semibold" style={{ color: 'var(--text-secondary)', fontFamily: 'Syne' }}>
        {Icon && <Icon size={12} style={{ color: 'var(--accent-light)' }} />}<span>{label}</span>{required && <span style={{ color: '#ef4444' }}>*</span>}
      </label>
      {children}
      {error && <p className="mt-1 text-[11px]" style={{ color: '#ef4444' }}>{error}</p>}
    </div>
  )
}

export default function Credibook({ currentUser, activeBookId, defaultBookId, books = [], setActivePage, onPengeluaran, onChanged }) {
  const acc = useAccounting()
  const toast = useToast()
  const confirm = useConfirm()
  const [rangeId, setRangeId] = useState('month')
  const range = useMemo(() => computeRange(rangeId), [rangeId])
  const bookId = activeBookId || defaultBookId || null
  const activeBook = books.find(b => b.id === bookId)

  const [rows, setRows] = useState([]); const [loading, setLoading] = useState(false)
  const [expTotal, setExpTotal] = useState(0)
  const [omsetInvoice, setOmsetInvoice] = useState(0) // omset dari invoice/kasir (per book)
  const [piutangBook, setPiutangBook] = useState(0)   // piutang aktif (per book)
  const inp = { background: 'var(--bg-elevated)', border: '1px solid var(--border)', color: 'var(--text-primary)' }
  const FIELD = 'w-full px-3.5 py-3 rounded-xl text-sm'

  const blank = { incomeType: 'omzet', name: '', date: todayISO(), amount: '', method: 'transfer', note: '' }
  const [form, setForm] = useState(blank); const [err, setErr] = useState({}); const [saving, setSaving] = useState(false)
  const [edit, setEdit] = useState(null) // baris yang diedit inline

  const load = async () => {
    setLoading(true)
    const r = await acc.listCredibookIncome({ bookId: activeBookId || undefined, from: range.from, to: range.to })
    setRows(r.ok ? r.data : [])
    const [exp, omset, piutang] = await Promise.all([
      acc.sumExpensesRange(range.from, range.to),
      acc.sumOmsetByBook({ bookId: activeBookId || undefined, from: range.from, to: range.to }),
      acc.sumPiutangByBook({ bookId: activeBookId || undefined }),
    ])
    setExpTotal(exp); setOmsetInvoice(omset); setPiutangBook(piutang)
    setLoading(false)
  }
  // Muat ulang saat range / book berubah (realtime saat pindah book).
  useEffect(() => { load() /* eslint-disable-next-line */ }, [rangeId, activeBookId])

  // ── 6 angka dashboard (semua per Book aktif) ──
  const omsetCredibook = useMemo(() => rows.filter(x => (x.income_type || 'omzet') === 'omzet').reduce((s, x) => s + Math.round(x.amount || 0), 0), [rows])
  const nonOmset = useMemo(() => rows.filter(x => (x.income_type || 'omzet') !== 'omzet').reduce((s, x) => s + Math.round(x.amount || 0), 0), [rows])
  const omsetBook = omsetInvoice + omsetCredibook      // 1
  const totalPemasukan = omsetBook + nonOmset          // 3
  const saldoBook = totalPemasukan - expTotal          // 6
  // kompat lama
  const totalMasuk = totalPemasukan
  const saldoBersih = saldoBook

  const submit = async () => {
    const e = {}
    if (!form.name.trim()) e.name = 'Nama pemasukkan wajib diisi'
    if (!form.date) e.date = 'Tanggal wajib diisi'
    if (!(parseCurrency(form.amount) > 0)) e.amount = 'Nominal harus lebih dari 0'
    if (!form.method) e.method = 'Metode pembayaran wajib dipilih'
    setErr(e); if (Object.keys(e).length) return
    setSaving(true)
    const r = await acc.addCredibookIncome({
      name: form.name, date: form.date, amount: parseCurrency(form.amount), method: form.method, note: form.note,
      incomeType: form.incomeType, bookId, createdBy: currentUser?.id, createdByName: currentUser?.name || currentUser?.username || '',
    })
    setSaving(false)
    if (r.ok) { toast.success('Pemasukkan dicatat'); setForm(blank); setErr({}); load(); onChanged?.() } else toast.error(r.error)
  }
  const saveEdit = async () => {
    if (!(parseCurrency(edit.amount) > 0)) return toast.error('Nominal harus > 0')
    const r = await acc.updateCredibookIncome(edit.id, { name: edit.name, date: edit.date, amount: parseCurrency(edit.amount), method: edit.method, note: edit.note, incomeType: edit.incomeType })
    if (r.ok) { toast.success('Diperbarui'); setEdit(null); load(); onChanged?.() } else toast.error(r.error)
  }
  const del = async (row) => {
    if (!(await confirm({ title: 'Yakin ingin menghapus pemasukkan ini?', message: 'Data dihapus dari laporan & mengurangi Omset, Uang Masuk, dan Saldo (Kas & Bank).' }))) return
    const r = await acc.deleteCredibookIncome(row.id)
    if (r.ok) { toast.success('Dihapus'); load(); onChanged?.() } else toast.error(r.error)
  }

  const inpErr = (has) => has ? { ...inp, border: '1px solid #ef4444' } : inp

  return (
    <div className="flex-1 overflow-y-auto overflow-x-hidden mesh-bg" style={{ WebkitOverflowScrolling: 'touch' }}>
      <div className="p-4 sm:p-6 max-w-5xl mx-auto" style={{ paddingBottom: 'calc(110px + env(safe-area-inset-bottom))' }}>
        <div className="flex items-start justify-between gap-3 mb-4 flex-wrap">
          <div>
            <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>Pembukuan Sederhana</div>
            <h2 className="text-xl sm:text-2xl font-bold mt-0.5 flex items-center gap-2" style={{ fontFamily: 'Syne', color: 'var(--text-primary)' }}><NotebookPen size={20} style={{ color: 'var(--accent-light)' }} /> Credibook</h2>
          </div>
          {activeBook && <span className="text-[11px] font-bold px-2.5 py-1 rounded-lg" style={{ background: 'rgba(139,92,246,0.12)', color: 'var(--accent-light)', fontFamily: 'Syne' }}>Book: {activeBook.name || activeBook.brand_name}</span>}
        </div>

        {/* Filter waktu */}
        <div className="flex gap-1.5 mb-4 overflow-x-auto pb-1" style={{ scrollbarWidth: 'none' }}>
          {RANGES.map(r => (
            <button key={r.id} onClick={() => setRangeId(r.id)} className="flex-shrink-0 px-3 py-2 rounded-xl text-xs font-semibold whitespace-nowrap"
              style={{ background: rangeId === r.id ? 'linear-gradient(135deg, var(--accent), #6366f1)' : 'var(--bg-card)', color: rangeId === r.id ? '#fff' : 'var(--text-secondary)', border: `1px solid ${rangeId === r.id ? 'transparent' : 'var(--border)'}`, fontFamily: 'Syne' }}>{r.label}</button>
          ))}
        </div>

        {/* Dashboard 6 card — semua mengikuti Book aktif */}
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 mb-5">
          <MiniCard icon={Receipt} label="Omset Book" value={omsetBook} color="#3b82f6" sub="Invoice kasir + Credibook (Omset)" />
          <MiniCard icon={TrendingUp} label="Pemasukkan Non Omset" value={nonOmset} color="#10d98a" sub="Refund / modal / lainnya" />
          <MiniCard icon={Wallet} label="Total Pemasukkan" value={totalPemasukan} color="#22c55e" sub="Omset + Non Omset" />
          <MiniCard icon={TrendingDown} label="Total Pengeluaran" value={expTotal} color="#ef4444" sub="Dari Accounting (semua book)" />
          <MiniCard icon={Calendar} label="Piutang Book" value={piutangBook} color="#f59e0b" sub="Piutang aktif (saldo berjalan)" />
          <MiniCard icon={Scale} label="Saldo Book" value={saldoBook} color="#06b6d4" sub="Total Pemasukkan − Pengeluaran" highlight />
        </div>

        {/* Tombol Pemasukkan / Pengeluaran */}
        <div className="grid grid-cols-2 gap-3 mb-4">
          <div className="rounded-xl px-3 py-2.5 flex items-center gap-2" style={{ background: 'rgba(16,217,138,0.08)', border: '1px solid rgba(16,217,138,0.25)' }}>
            <Plus size={15} style={{ color: '#10d98a' }} /><span className="text-xs font-bold" style={{ color: '#10d98a', fontFamily: 'Syne' }}>Pemasukkan Manual</span>
          </div>
          <button onClick={() => (onPengeluaran ? onPengeluaran() : setActivePage?.('accounting'))} className="rounded-xl px-3 py-2.5 flex items-center justify-between gap-2 btn-press" style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)' }}>
            <span className="flex items-center gap-2"><Receipt size={15} style={{ color: '#ef4444' }} /><span className="text-xs font-bold" style={{ color: '#ef4444', fontFamily: 'Syne' }}>Pengeluaran</span></span>
            <ArrowRight size={14} style={{ color: '#ef4444' }} />
          </button>
        </div>

        {/* Form Pemasukkan Manual */}
        <div className="rounded-2xl p-5 sm:p-6 w-full mb-4" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', maxWidth: 760 }}>
          <div className="mb-4"><h3 className="font-bold text-sm" style={{ fontFamily: 'Syne', color: 'var(--text-primary)' }}>Catat Pemasukkan Baru</h3><p className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>Semua jenis menambah Uang Masuk & Saldo. Hanya jenis <b style={{ color: '#10d98a' }}>Omset</b> yang menambah Omset. Tidak membuat invoice/order/piutang.</p></div>
          <div className="space-y-4">
            <Field icon={Scale} label="Jenis Pemasukkan" required>
              <select value={form.incomeType} onChange={e => setForm(p => ({ ...p, incomeType: e.target.value }))} className={FIELD} style={inp}>
                {INCOME_TYPES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
              </select>
              <p className="mt-1 text-[11px]" style={{ color: form.incomeType === 'omzet' ? '#10d98a' : 'var(--text-muted)' }}>
                {INCOME_TYPES.find(t => t.id === form.incomeType)?.hint}
              </p>
            </Field>
            <Field icon={NotebookPen} label="Nama Pemasukkan" required error={err.name}>
              <input value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} placeholder="Contoh: Penjualan offline / Marketplace / Jasa" className={FIELD} style={inpErr(err.name)} />
            </Field>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field icon={Calendar} label="Tanggal" required error={err.date}>
                <input type="date" value={form.date} onChange={e => setForm(p => ({ ...p, date: e.target.value }))} className={FIELD} style={{ ...inpErr(err.date), colorScheme: 'dark' }} />
              </Field>
              <Field icon={Wallet} label="Nominal" required error={err.amount}>
                <MoneyInput value={form.amount} onChange={v => setForm(p => ({ ...p, amount: v }))} className={FIELD} style={inpErr(err.amount)} />
              </Field>
            </div>
            <Field icon={Wallet} label="Metode Pembayaran" required error={err.method}>
              <select value={form.method} onChange={e => setForm(p => ({ ...p, method: e.target.value }))} className={FIELD} style={inpErr(err.method)}>{METHODS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}</select>
            </Field>
            <Field icon={Pencil} label="Keterangan">
              <input value={form.note} onChange={e => setForm(p => ({ ...p, note: e.target.value }))} placeholder="Opsional" className={FIELD} style={inp} />
            </Field>
            <button onClick={submit} disabled={saving} className="w-full py-2.5 rounded-xl text-sm font-bold btn-press inline-flex items-center justify-center gap-1.5" style={{ background: 'linear-gradient(135deg, var(--accent), #6366f1)', color: '#fff', fontFamily: 'Syne' }}>{saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Catat Pemasukkan</button>
          </div>
        </div>

        {/* Riwayat */}
        <div className="text-xs font-bold uppercase tracking-wider mb-2" style={{ color: 'var(--text-muted)', fontFamily: 'Syne' }}>Riwayat Pemasukkan</div>
        {loading ? <div className="flex justify-center py-6"><Loader2 size={18} className="animate-spin" style={{ color: 'var(--accent-light)' }} /></div>
          : rows.length === 0 ? <p className="text-xs text-center py-6" style={{ color: 'var(--text-muted)' }}>Belum ada pemasukkan pada periode ini</p>
          : <div className="space-y-2">
              {rows.map(x => edit && edit.id === x.id ? (
                <div key={x.id} className="rounded-xl p-3" style={{ background: 'rgba(139,92,246,0.06)', border: '1px solid var(--border)' }}>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <select value={edit.incomeType} onChange={e => setEdit(s => ({ ...s, incomeType: e.target.value }))} className="px-2 py-1.5 rounded-lg text-xs" style={inp}>{INCOME_TYPES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}</select>
                    <input value={edit.name} onChange={e => setEdit(s => ({ ...s, name: e.target.value }))} placeholder="Nama" className="px-2 py-1.5 rounded-lg text-xs" style={inp} />
                    <input type="date" value={edit.date} onChange={e => setEdit(s => ({ ...s, date: e.target.value }))} className="px-2 py-1.5 rounded-lg text-xs" style={{ ...inp, colorScheme: 'dark' }} />
                    <MoneyInput value={edit.amount} onChange={v => setEdit(s => ({ ...s, amount: v }))} className="px-2 py-1.5 rounded-lg text-xs" style={inp} />
                    <select value={edit.method} onChange={e => setEdit(s => ({ ...s, method: e.target.value }))} className="px-2 py-1.5 rounded-lg text-xs" style={inp}>{METHODS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}</select>
                    <input value={edit.note} onChange={e => setEdit(s => ({ ...s, note: e.target.value }))} placeholder="Keterangan" className="px-2 py-1.5 rounded-lg text-xs sm:col-span-2" style={inp} />
                  </div>
                  <div className="flex justify-end gap-1.5 mt-2">
                    <button onClick={saveEdit} className="px-3 py-1.5 rounded-lg text-xs font-semibold inline-flex items-center gap-1" style={{ background: 'rgba(16,217,138,0.12)', color: '#10d98a' }}><Check size={12} /> Simpan</button>
                    <button onClick={() => setEdit(null)} className="px-3 py-1.5 rounded-lg text-xs" style={{ background: 'rgba(255,255,255,0.05)', color: 'var(--text-secondary)' }}><X size={12} /></button>
                  </div>
                </div>
              ) : (
                <div key={x.id} className="flex items-center gap-3 p-3 rounded-xl min-w-0" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{x.name}{x.note ? <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}> · {x.note}</span> : null}</div>
                    <div className="text-[11px] mt-0.5 flex items-center gap-1.5 flex-wrap" style={{ color: 'var(--text-muted)' }}><span>{formatDateTimeWIB(x.transaction_date, x.created_at)}</span>{(() => { const it = x.income_type || 'omzet'; const c = ITYPE_COLOR[it] || '#64748b'; return <span className="px-1.5 py-0.5 rounded font-bold" style={{ background: `${c}22`, color: c, fontSize: 9, textTransform: 'uppercase' }}>{ITYPE_LABEL[it] || it}</span> })()}<span className="px-1.5 py-0.5 rounded" style={{ background: 'rgba(148,163,184,0.12)', color: 'var(--text-secondary)', fontSize: 9, textTransform: 'uppercase' }}>{x.payment_method}</span>{x.created_by_name && <span>· oleh {x.created_by_name}</span>}</div>
                  </div>
                  <div className="text-sm font-bold whitespace-nowrap" style={{ color: '#10d98a', fontVariantNumeric: 'tabular-nums', fontSize: 'clamp(12px,3.4vw,15px)' }}>{fmt(x.amount)}</div>
                  <button onClick={() => setEdit({ id: x.id, incomeType: x.income_type || 'omzet', name: x.name, date: (x.transaction_date || '').slice(0, 10), amount: String(Math.round(x.amount || 0)), method: x.payment_method || 'transfer', note: x.note || '' })} className="w-8 h-8 rounded-lg inline-flex items-center justify-center flex-shrink-0" style={{ background: 'rgba(139,92,246,0.1)', color: 'var(--accent-light)' }}><Pencil size={12} /></button>
                  <button onClick={() => del(x)} className="w-8 h-8 rounded-lg inline-flex items-center justify-center flex-shrink-0" style={{ background: 'rgba(255,77,106,0.08)', color: 'var(--red)' }}><Trash2 size={12} /></button>
                </div>
              ))}
            </div>}
      </div>
    </div>
  )
}
