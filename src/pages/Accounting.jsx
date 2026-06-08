import React, { useEffect, useMemo, useState } from 'react'
import {
  Loader2, TrendingUp, TrendingDown, Wallet, Landmark, Scale, Receipt,
  ShoppingCart, BookOpen, Plus, Trash2, AlertTriangle, RefreshCw, Truck,
  FileSpreadsheet, Users as UsersIcon, Building2, Pencil, Check, X, ChevronDown, Search, Home,
} from 'lucide-react'
import { formatRupiah, formatCurrency, parseCurrency, calculateAssetBookValue, assetDepreciationSchedule, assetAgeYears, rentAmortization, rentSchedule, rentDurationMonths, rentBebanBulanIni } from '../utils/helpers'
import { Button } from '../components/ui'
import Modal from '../components/Modal'
import { useToast } from '../components/Toast'
import { useConfirm } from '../components/Confirm'
import { useAccounting } from '../hooks/useAccounting'

const TABS = [
  { id: 'ringkasan', label: 'Ringkasan', icon: Scale },
  { id: 'jurnal', label: 'Jurnal', icon: BookOpen },
  { id: 'pengeluaran', label: 'Pengeluaran', icon: Receipt },
  { id: 'pembelian', label: 'Pembelian', icon: ShoppingCart },
  { id: 'supplier', label: 'Supplier', icon: UsersIcon },
  { id: 'hsupplier', label: 'Hutang Supplier', icon: Truck },
  { id: 'hbank', label: 'Hutang Bank', icon: Building2 },
  { id: 'aset', label: 'Aset', icon: Landmark },
  { id: 'sewa', label: 'Sewa Toko', icon: Home },
]
const DEP_METHODS = [{ id: 'percentage', label: 'Persentase per Tahun' }, { id: 'straight', label: 'Garis Lurus' }, { id: 'none', label: 'Tanpa Penyusutan' }]
const DEFAULT_ASSET_CATEGORIES = ['Mesin Produksi', 'Komputer & Elektronik', 'Kendaraan', 'Peralatan Toko', 'Furniture', 'Renovasi', 'Software', 'Lainnya']
const ASSET_STATUS = { active: { label: 'Aktif', color: '#10d98a' }, depleted: { label: 'Habis Nilai', color: '#94a3b8' }, sold: { label: 'Dijual', color: '#3b82f6' }, broken: { label: 'Rusak', color: '#ef4444' }, deleted: { label: 'Dihapus', color: '#64748b' } }
// Kompres gambar → dataURL kecil (maks 700px, webp/jpeg) untuk foto aset.
function fileToCompressedDataURL(file, max = 700) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height))
      const w = Math.round(img.width * scale), h = Math.round(img.height * scale)
      const c = document.createElement('canvas'); c.width = w; c.height = h
      c.getContext('2d').drawImage(img, 0, 0, w, h)
      URL.revokeObjectURL(url)
      try { resolve(c.toDataURL('image/webp', 0.7)) } catch { resolve(c.toDataURL('image/jpeg', 0.7)) }
    }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Gagal memuat gambar')) }
    img.src = url
  })
}
const METHODS = [{ id: 'cash', label: 'Cash' }, { id: 'transfer', label: 'Transfer' }, { id: 'qris', label: 'QRIS' }]
// Kategori bawaan sistem (selalu tersedia walau tabel DB belum dimigrasi).
const DEFAULT_EXP_CATEGORIES = [
  'Pembelian Bahan', 'Gaji Karyawan', 'Operasional', 'Transportasi', 'Listrik', 'Air',
  'Internet', 'Sewa', 'Cicilan Bank', 'Pembayaran Hutang Supplier', 'Peralatan',
  'Maintenance', 'Marketing', 'Iklan', 'Konsumsi', 'Pajak', 'Pengeluaran Lainnya',
]
const fmt = (n) => formatRupiah(Math.round(Number(n) || 0))
const dt = (d) => (d ? new Date(d).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' }) : '—')
// Input uang: hanya angka + titik ribuan.
// Kosong → tampil KOSONG (placeholder "0" yang redup), BUKAN value 0 tersimpan.
// Mengetik "5" → "5" (tanpa leading zero). Hapus semua → kembali kosong.
function MoneyInput({ value, onChange, placeholder = '0', className, style }) {
  const display = (value === '' || value === null || value === undefined) ? '' : formatCurrency(value)
  return <input inputMode="numeric" value={display} placeholder={placeholder}
    onChange={(e) => { const d = (e.target.value || '').replace(/[^\d]/g, ''); onChange(d === '' ? '' : String(parseInt(d, 10))) }}
    className={className} style={style} />
}

// ── Form vertikal 1 kolom — komponen reusable ──
// fieldCls: input full-width seragam, nyaman di iPhone (text-base hindari zoom iOS)
const FIELD_CLS = 'w-full px-3.5 py-3 rounded-xl text-sm'
function Field({ icon: Icon, label, required, error, hint, children }) {
  return (
    <div>
      <label className="flex items-center gap-1.5 mb-1.5 text-xs font-semibold" style={{ color: 'var(--text-secondary)', fontFamily: 'Syne' }}>
        {Icon && <Icon size={12} style={{ color: 'var(--accent-light)' }} />}
        <span>{label}</span>{required && <span style={{ color: '#ef4444' }}>*</span>}
      </label>
      {children}
      {error
        ? <p className="mt-1 text-[11px] flex items-center gap-1" style={{ color: '#ef4444' }}><AlertTriangle size={10} /> {error}</p>
        : hint ? <p className="mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>{hint}</p> : null}
    </div>
  )
}
function FormCard({ icon: Icon, title, subtitle, children }) {
  return (
    <div className="rounded-2xl p-5 sm:p-6 w-full" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', maxWidth: 760 }}>
      <div className="flex items-start gap-3 mb-5">
        {Icon && <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: 'rgba(139,92,246,0.12)', border: '1px solid rgba(139,92,246,0.3)' }}><Icon size={16} style={{ color: 'var(--accent-light)' }} /></div>}
        <div className="min-w-0">
          <h3 className="font-bold text-sm" style={{ fontFamily: 'Syne', color: 'var(--text-primary)' }}>{title}</h3>
          <p className="text-[11px] mt-0.5 leading-relaxed" style={{ color: 'var(--text-muted)' }}>{subtitle}</p>
        </div>
      </div>
      <div className="space-y-4">{children}</div>
    </div>
  )
}

// Combobox searchable yang andal (dark mode, item clickable, z-index tinggi).
// - klik field / panah → tampilkan SEMUA opsi (buka penuh)
// - mengetik → memfilter; klik item / Enter → memilih
// - onMouseDown+preventDefault → pilihan terdaftar SEBELUM input blur
// - allowCreate: tampilkan "+ Tambah baru: <text>" bila tidak ada yang cocok
function Combo({ value, onChange, options, error, baseStyle, errStyle, placeholder = 'Pilih / cari', allowCreate = false, onCreate, rightButton }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState(null) // null = belum mengetik → tampilkan value
  const text = query == null ? (value || '') : query
  const ql = (query || '').toLowerCase()
  const filtered = (query == null || query === '') ? options : options.filter(o => o.name.toLowerCase().includes(ql))
  const exact = options.some(o => o.name.toLowerCase() === ql)
  const showCreate = allowCreate && query && query.trim() && !exact
  const choose = (name) => { onChange(name); setQuery(null); setOpen(false) }
  const create = async () => { const n = query.trim(); if (onCreate) await onCreate(n); choose(n) }
  return (
    <div className="relative">
      <div className="flex gap-2">
        <div className="relative flex-1">
          <input
            value={text}
            onChange={e => { setQuery(e.target.value); onChange(e.target.value); setOpen(true) }}
            onFocus={() => { setQuery(''); setOpen(true) }}
            onBlur={() => setTimeout(() => { setOpen(false); setQuery(null) }, 160)}
            onKeyDown={e => {
              if (e.key === 'Enter') { e.preventDefault(); if (filtered[0]) choose(filtered[0].name); else if (showCreate) create() }
              else if (e.key === 'Escape') setOpen(false)
            }}
            placeholder={placeholder}
            className={FIELD_CLS}
            style={{ ...(error ? errStyle : baseStyle), paddingRight: 34 }}
          />
          <button type="button" tabIndex={-1} onMouseDown={e => { e.preventDefault(); setOpen(o => !o); setQuery(o => o == null ? '' : o) }}
            style={{ position: 'absolute', right: 8, top: 0, bottom: 0, display: 'flex', alignItems: 'center', color: 'var(--text-muted)' }}>
            <ChevronDown size={16} style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }} />
          </button>
        </div>
        {rightButton}
      </div>
      {open && (
        <div className="absolute left-0 right-0 mt-1 rounded-xl py-1"
          style={{ zIndex: 9999, maxHeight: 240, overflowY: 'auto', background: 'var(--bg-elevated)', border: '1px solid var(--border-strong)', boxShadow: '0 14px 36px rgba(0,0,0,0.55)' }}>
          {filtered.length === 0 && !showCreate && <div className="px-3 py-2.5 text-xs" style={{ color: 'var(--text-muted)' }}>Tidak ada hasil</div>}
          {filtered.map(o => (
            <button type="button" key={o.id}
              onMouseDown={e => { e.preventDefault(); choose(o.name) }}
              className="w-full text-left px-3 py-2 text-sm"
              style={{ color: 'var(--text-primary)', background: o.name === value ? 'rgba(139,92,246,0.14)' : 'transparent', cursor: 'pointer' }}>
              {o.name}
            </button>
          ))}
          {showCreate && (
            <button type="button" onMouseDown={e => { e.preventDefault(); create() }}
              className="w-full text-left px-3 py-2 text-sm font-semibold"
              style={{ color: 'var(--accent-light)', background: 'rgba(139,92,246,0.08)', cursor: 'pointer' }}>
              + Tambah baru: “{query.trim()}”
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function Card({ icon: Icon, label, value, color = '#38BDF8', sub, onClick }) {
  return (
    <div onClick={onClick}
      className={`rounded-2xl p-4 min-w-0 overflow-hidden ${onClick ? 'acc-card cursor-pointer' : ''}`}
      style={{ background: 'var(--bg-card)', border: `1px solid ${color}33`, '--card-glow': `${color}3a` }}>
      <div className="flex items-center gap-2 mb-2">
        <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: `${color}1f`, border: `1px solid ${color}44` }}><Icon size={15} style={{ color }} /></div>
        <span className="text-xs font-semibold truncate" style={{ color: 'var(--text-secondary)' }}>{label}</span>
      </div>
      <div className="font-bold" style={{ fontFamily: 'Syne', color, fontVariantNumeric: 'tabular-nums', fontSize: 'clamp(15px,4.2vw,20px)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%' }}>{value}</div>
      {sub && <div className="text-[11px] mt-0.5 truncate" style={{ color: 'var(--text-muted)' }}>{sub}</div>}
    </div>
  )
}

export default function Accounting({ admins = [], currentUser, setActivePage } = {}) {
  const toast = useToast()
  const confirm = useConfirm()
  const acc = useAccounting()
  const isOwner = currentUser?.role === 'owner'
  const [tab, setTab] = useState('ringkasan')
  const [detail, setDetail] = useState(null) // { kind, title, color, rows, total, loading }
  const [from, setFrom] = useState(acc.monthStartISO())
  const [to, setTo] = useState(acc.todayISO())
  const [loading, setLoading] = useState(false)
  const [setupNeeded, setSetupNeeded] = useState(false)
  const [d, setD] = useState(null)
  const [syncing, setSyncing] = useState(false)
  const [saving, setSaving] = useState(false)
  const adminName = (id) => admins.find(a => a.id === id)?.name || admins.find(a => a.id === id)?.username || '—'

  // data per tab
  const [entries, setEntries] = useState([]); const [entPage, setEntPage] = useState(0); const [entCount, setEntCount] = useState(0)
  const [expenses, setExpenses] = useState([]); const [purchases, setPurchases] = useState([])
  const [suppliers, setSuppliers] = useState([]); const [supSearch, setSupSearch] = useState('')
  const [supDebts, setSupDebts] = useState([]); const [bankLoans, setBankLoans] = useState([])
  const [recap, setRecap] = useState([])

  // forms (default metode TRANSFER)
  const [expForm, setExpForm] = useState({ date: acc.todayISO(), category: 'Pembelian Bahan', amount: '', method: 'transfer', note: '' })
  const [purForm, setPurForm] = useState({ date: acc.todayISO(), supplier: '', item: '', qty: '', harga: '', paid: '', method: 'transfer', dueDate: '', dpMethod: 'transfer', note: '' })
  const [supForm, setSupForm] = useState({ id: null, name: '', phone: '', address: '', note: '' })
  const [sdForm, setSdForm] = useState({ supplier: '', item: '', total: '', dueDate: '' })
  const [payId, setPayId] = useState(null); const [payVal, setPayVal] = useState(''); const [payMethod, setPayMethod] = useState('transfer'); const [payNote, setPayNote] = useState('')
  const [loanForm, setLoanForm] = useState({ namaBank: '', jenis: 'KPR', nomor: '', mulai: '', jatuhTempo: '', plafon: '', sisaPokok: '', bunga: '', cicilan: '', keterangan: '' })
  // error inline per form (field → pesan)
  const [expErr, setExpErr] = useState({}); const [purErr, setPurErr] = useState({})
  // Master kategori pengeluaran (dari DB)
  const [expCats, setExpCats] = useState([]); const [catMgr, setCatMgr] = useState(false)
  const [catNew, setCatNew] = useState(''); const [catEdit, setCatEdit] = useState(null); const [catSearch, setCatSearch] = useState('')
  const canManageCat = currentUser?.role === 'owner' || currentUser?.role === 'admin'
  // Gabungan kategori bawaan sistem + kategori DB (dedup, urut). Selalu ada isi
  // walau tabel expense_categories belum dimigrasi → dropdown tetap berfungsi.
  const catOptions = useMemo(() => {
    const map = new Map()
    DEFAULT_EXP_CATEGORIES.forEach(n => map.set(n.toLowerCase(), { id: 'sys:' + n, name: n, system: true }))
    ;(expCats || []).forEach(c => map.set(c.name.toLowerCase(), { id: c.id, name: c.name, system: false }))
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name))
  }, [expCats])
  const [supErr, setSupErr] = useState({}); const [sdErr, setSdErr] = useState({}); const [loanErr, setLoanErr] = useState({})
  const [bpay, setBpay] = useState(null) // {loanId, amount, pokok, bunga, method}
  const [expandLoan, setExpandLoan] = useState(null) // loan id yang di-expand
  const [expRows, setExpRows] = useState([]); const [expLoading, setExpLoading] = useState(false)
  const [hbEdit, setHbEdit] = useState(null) // pembayaran bank yang diedit inline
  // ── ASET ──
  const blankAsset = { name: '', categoryName: '', purchaseDate: acc.todayISO(), purchasePrice: '', residualValue: '', method: 'percentage', rate: '', life: '', notes: '', photoUrl: '' }
  const [assets, setAssets] = useState([]); const [assetCats, setAssetCats] = useState([])
  const [assetForm, setAssetForm] = useState(blankAsset); const [assetErr, setAssetErr] = useState({})
  const [editAsset, setEditAsset] = useState(null); const [detailAsset, setDetailAsset] = useState(null)
  const [sellState, setSellState] = useState(null); const [photoBusy, setPhotoBusy] = useState(false)
  const [assetFilter, setAssetFilter] = useState({ cat: 'all', status: 'all', method: 'all' })
  const assetCatOptions = useMemo(() => {
    const map = new Map()
    DEFAULT_ASSET_CATEGORIES.forEach(n => map.set(n.toLowerCase(), { id: 'sys:' + n, name: n }))
    ;(assetCats || []).forEach(c => map.set(c.name.toLowerCase(), { id: c.id, name: c.name }))
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name))
  }, [assetCats])
  // ── SEWA TOKO ──
  const blankRent = { name: '', location: '', landlord: '', paymentDate: acc.todayISO(), startDate: acc.todayISO(), endDate: '', totalAmount: '', method: 'transfer', notes: '', proofUrl: '' }
  const [rents, setRents] = useState([]); const [rentForm, setRentForm] = useState(blankRent); const [rentErr, setRentErr] = useState({})
  const [editRent, setEditRent] = useState(null); const [detailRent, setDetailRent] = useState(null)
  // Agregat sewa (realtime): sisa dibayar dimuka, beban bulan ini, kas keluar & beban dalam periode.
  const rentAgg = useMemo(() => {
    const now = new Date()
    const inRange = (ds) => { if (!ds) return false; const t = new Date(ds).getTime(); if (from && t < new Date(from + 'T00:00:00').getTime()) return false; if (to && t > new Date(to + 'T23:59:59').getTime()) return false; return true }
    let dibayarDimuka = 0, bebanBulanIni = 0, cashOutPeriod = 0, bebanPeriod = 0
    ;(rents || []).filter(r => r.status !== 'cancelled').forEach(r => {
      const a = rentAmortization(r, now)
      dibayarDimuka += a.prepaid
      bebanBulanIni += rentBebanBulanIni(r, now)
      if (inRange(r.payment_date)) cashOutPeriod += a.total
      rentSchedule(r, now).forEach(s => { if (s.status !== 'pending' && inRange(s.periodMonth)) bebanPeriod += s.amount })
    })
    return { dibayarDimuka, bebanBulanIni, cashOutPeriod, bebanPeriod }
  }, [rents, from, to])
  // edit hutang supplier + riwayat
  const [editDebt, setEditDebt] = useState(null) // supplier_debt being edited
  const [editExp, setEditExp] = useState(null) // expense being edited
  const [editPur, setEditPur] = useState(null) // purchase being edited
  const [history, setHistory] = useState(null) // { kind:'supplier'|'bank', title, rows }
  const [hLoading, setHLoading] = useState(false)
  const [hEdit, setHEdit] = useState(null) // payment being edited

  const loadDashboard = async () => {
    const res = await acc.getDashboard(from, to)
    if (!res.ok) { if (/function|relation|does not exist|schema cache|acc_dashboard/i.test(res.error || '')) setSetupNeeded(true); else toast.error(res.error || 'Gagal') }
    else {
      setD(res.data); setSetupNeeded(false)
      const chk = await acc.getPiutangAktif()
      if (chk.ok && Math.abs((chk.value || 0) - Math.round(res.data.piutang_aktif || 0)) > 1)
        console.warn('[Accounting] Piutang tidak sinkron — RPC:', res.data.piutang_aktif, 'debts:', chk.value)
    }
  }
  const loadEntries = async (page = 0) => { const r = await acc.listEntries({ page, from, to }); if (r.ok) { setEntries(r.data); setEntCount(r.count); setEntPage(page) } else if (/relation|does not exist/i.test(r.error || '')) setSetupNeeded(true) }
  const loadExpenses = async () => { const r = await acc.listExpenses({}); if (r.ok) setExpenses(r.data) }
  const loadExpCats = async () => { const r = await acc.listExpenseCategories(); if (r.ok) setExpCats(r.data) }
  const loadPurchases = async () => { const r = await acc.listPurchases({}); if (r.ok) setPurchases(r.data) }
  const loadSuppliers = async () => { const r = await acc.listSuppliers(supSearch); if (r.ok) setSuppliers(r.data) }
  const loadSupDebts = async () => { const r = await acc.listSupplierDebts(); if (r.ok) setSupDebts(r.data) }
  const loadBankLoans = async () => { const r = await acc.listBankLoans(); if (r.ok) setBankLoans(r.data) }
  const loadAssets = async () => { const r = await acc.listAssets(); if (r.ok) setAssets(r.data) }
  const loadAssetCats = async () => { const r = await acc.listAssetCategories(); if (r.ok) setAssetCats(r.data) }
  const loadRents = async () => { const r = await acc.listRents(); if (r.ok) setRents(r.data) }
  const loadRecap = async () => { const r = await acc.getRecapAdmin(from, to); if (r.ok) setRecap(r.data) }

  useEffect(() => {
    setLoading(true)
    const run = async () => {
      if (tab === 'ringkasan') { await loadDashboard(); await loadRecap(); await loadAssets(); await loadRents() }
      else if (tab === 'jurnal') await loadEntries(0)
      else if (tab === 'pengeluaran') { await loadExpenses(); await loadExpCats() }
      else if (tab === 'pembelian') { await loadPurchases(); await loadSuppliers() }
      else if (tab === 'supplier') await loadSuppliers()
      else if (tab === 'hsupplier') { await loadSupDebts(); await loadSuppliers() }
      else if (tab === 'hbank') await loadBankLoans()
      else if (tab === 'aset') { await loadAssets(); await loadAssetCats() }
      else if (tab === 'sewa') await loadRents()
      setLoading(false)
    }
    run()
    /* eslint-disable-next-line */
  }, [tab, from, to])

  // OPTIMASI EGRESS: dashboard accounting TIDAK realtime. Auto-refresh ringan
  // tiap 45 detik (hanya saat tab Ringkasan & tab browser aktif) + refresh
  // manual lewat tombol Sinkronkan/ubah tanggal. Tidak ada subscription.
  useEffect(() => {
    if (tab !== 'ringkasan') return
    let t = null
    const start = () => { if (!t) t = setInterval(loadDashboard, 45000) }
    const stop = () => { if (t) { clearInterval(t); t = null } }
    const onVis = () => { if (document.visibilityState === 'visible') { loadDashboard(); start() } else stop() }
    if (document.visibilityState === 'visible') start()
    document.addEventListener('visibilitychange', onVis)
    return () => { stop(); document.removeEventListener('visibilitychange', onVis) }
    /* eslint-disable-next-line */
  }, [tab, from, to])

  // Laba Bersih = Omzet/Penjualan − Total Pengeluaran (uang keluar valid):
  // pengeluaran manual + pembelian bahan + bayar hutang supplier + cicilan/bayar
  // hutang bank + gaji + operasional + biaya lain. pengeluaran_total sudah mencakup
  // semuanya (lihat acc_dashboard). Jadi bayar hutang bank 50jt → laba turun 50jt.
  // Laba = Omzet − Total Pengeluaran − Beban Sewa berjalan (akrual, bukan kas penuh)
  const laba = useMemo(() => d ? Math.round((d.penjualan || 0) - (d.pengeluaran_total || 0) - (rentAgg.bebanPeriod || 0)) : 0, [d, rentAgg])
  const totalAset = useMemo(() => d ? Math.round((d.saldo_kas || 0) + (d.saldo_rekening || 0) + (d.piutang_aktif || 0) + (d.persediaan || 0)) : 0, [d])
  const totalHutang = useMemo(() => d ? Math.round((d.hutang_supplier || 0) + (d.hutang_bank || 0)) : 0, [d])

  const doSync = async () => {
    if (syncing) return; setSyncing(true)
    const r = await acc.resync()
    if (r.ok) { await loadDashboard(); toast.success('Accounting disinkronkan') } else toast.error(r.error || 'Gagal sinkron')
    setSyncing(false)
  }
  const [exporting, setExporting] = useState(false)
  const exportExcel = async () => {
    if (exporting) return; setExporting(true)
    try {
      const [mod, res] = await Promise.all([import('xlsx'), acc.fetchEntriesForExport(from, to)])
      const XLSX = mod.default || mod
      const wb = XLSX.utils.book_new()
      if (d) {
        // Sembunyikan pos sensitif (laba, modal, aset, kekayaan) dari export non-owner
        const SENSITIVE = ['modal_barang']
        let rows = Object.entries(d).map(([k, v]) => ({ Pos: k, Nilai: Math.round(Number(v) || 0) }))
        if (isOwner) {
          rows = rows.concat([
            { Pos: 'laba_bersih', Nilai: laba },
            { Pos: 'aset_tetap', Nilai: asetTetap },
            { Pos: 'total_aset', Nilai: Math.round((d.saldo_kas || 0) + (d.saldo_rekening || 0) + (d.piutang_aktif || 0) + (d.persediaan || 0) + asetTetap) },
            { Pos: 'kekayaan_bersih', Nilai: Math.round((d.saldo_kas || 0) + (d.saldo_rekening || 0) + (d.piutang_aktif || 0) + (d.persediaan || 0) + asetTetap - (d.hutang_supplier || 0) - (d.hutang_bank || 0)) },
          ])
        } else {
          rows = rows.filter(r => !SENSITIVE.includes(r.Pos))
        }
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Ringkasan')
      }
      if (res.ok) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet((res.data || []).map(e => ({ Tanggal: e.entry_date, Sumber: e.source_type, Invoice: e.invoice_no || '', Akun: e.account_code, Debit: Math.round(e.debit || 0), Kredit: Math.round(e.credit || 0), Keterangan: e.description }))), 'Jurnal')
      XLSX.writeFile(wb, `accounting-${from}_${to}.xlsx`)
    } catch (e) { toast.error('Export gagal: ' + (e?.message || e)) } finally { setExporting(false) }
  }

  const inp = { background: 'var(--bg-elevated)', border: '1px solid var(--border)', color: 'var(--text-primary)' }
  const inpErr = (has) => has ? { ...inp, border: '1px solid #ef4444' } : inp
  const lastPage = Math.max(0, Math.ceil(entCount / acc.PAGE_SIZE) - 1)

  // ── submit handlers ──
  const submitExpense = async () => {
    const e = {}
    if (!expForm.date) e.date = 'Tanggal wajib diisi'
    if (!expForm.category || !expForm.category.trim()) e.category = 'Pilih kategori pengeluaran'
    if (!expForm.method) e.method = 'Metode pembayaran wajib dipilih'
    if (!(parseCurrency(expForm.amount) > 0)) e.amount = 'Nominal harus lebih dari 0'
    setExpErr(e); if (Object.keys(e).length) return
    setSaving(true); const r = await acc.addExpense({ ...expForm, amount: parseCurrency(expForm.amount), cashierId: currentUser?.id }); setSaving(false)
    if (r.ok) { toast.success('Pengeluaran dicatat'); setExpForm({ date: acc.todayISO(), category: 'Pembelian Bahan', amount: '', method: 'transfer', note: '' }); setExpErr({}); loadExpenses() } else toast.error(r.error || 'Gagal')
  }
  const resetPur = () => { setPurForm({ date: acc.todayISO(), supplier: '', item: '', qty: '', harga: '', paid: '', method: 'transfer', dueDate: '', dpMethod: 'transfer', note: '' }); setPurErr({}) }
  const submitPurchase = async () => {
    const qty = parseCurrency(purForm.qty)
    const harga = parseCurrency(purForm.harga)
    const total = qty > 0 ? qty * harga : harga
    const e = {}
    if (!purForm.date) e.date = 'Tanggal wajib diisi'
    if (!purForm.supplier) e.supplier = 'Supplier wajib dipilih'
    if (!purForm.item.trim()) e.item = 'Nama bahan wajib diisi'
    if (!purForm.method) e.method = 'Metode pembayaran wajib dipilih'
    if (total <= 0) e.harga = 'Total / harga harus lebih dari 0'
    if (purForm.method === 'hutang' && !purForm.dueDate) e.dueDate = 'Isi tanggal jatuh tempo untuk pembelian tempo'
    setPurErr(e); if (Object.keys(e).length) return
    setSaving(true)
    try {
      if (purForm.method === 'hutang') {
        // TEMPO → wajib jatuh tempo; sisa masuk Hutang Supplier, DP jadi uang keluar.
        if (!purForm.dueDate) { setSaving(false); return toast.error('Isi tanggal jatuh tempo untuk pembelian tempo') }
        const dp = Math.min(parseCurrency(purForm.paid), total)
        const r = await acc.addSupplierDebt({ supplier: purForm.supplier, item: purForm.item, total, dueDate: purForm.dueDate, method: purForm.dpMethod, note: purForm.note })
        if (!r.ok) { toast.error(r.error); setSaving(false); return }
        if (dp > 0 && r.id) { const rp = await acc.paySupplierDebt(r.id, dp, purForm.dpMethod, currentUser?.id, 'DP pembelian'); if (!rp.ok) toast.error(rp.error) }
        toast.success('Pembelian tempo → Hutang Supplier')
      } else {
        // CASH/TRANSFER/QRIS → lunas, langsung uang keluar
        const r = await acc.addPurchase({ date: purForm.date, supplier: purForm.supplier, item: purForm.item, qty, amount: total, method: purForm.method, isCredit: false, note: purForm.note })
        if (!r.ok) { toast.error(r.error); setSaving(false); return }
        toast.success('Pembelian dicatat')
      }
      resetPur(); loadPurchases()
    } finally { setSaving(false) }
  }
  // Riwayat pembayaran (supplier/bank)
  const openHistory = async (kind, ctx) => {
    setHistory({ kind, title: ctx.title, ctx }); setHEdit(null); setHLoading(true)
    const r = kind === 'supplier' ? await acc.listSupplierPayments(ctx.id) : await acc.listBankPayments(ctx.id)
    setHistory(h => h ? { ...h, rows: r.ok ? r.data : [] } : h); setHLoading(false)
  }
  const reloadHistory = async () => {
    if (!history) return
    const r = history.kind === 'supplier' ? await acc.listSupplierPayments(history.ctx.id) : await acc.listBankPayments(history.ctx.id)
    setHistory(h => h ? { ...h, rows: r.ok ? r.data : [] } : h)
    if (history.kind === 'supplier') loadSupDebts(); else loadBankLoans()
    loadDashboard()
  }
  // ── Detail sumber angka (audit, klik card) ──
  const openDetail = async (kind, title, color) => {
    setDetail({ kind, title, color, rows: [], total: 0, loading: true })
    const r = await acc.getCardDetail(kind, from, to)
    setDetail(d => d && d.kind === kind ? { ...d, rows: r.ok ? r.rows : [], total: r.ok ? r.total : 0, loading: false } : d)
  }
  const reloadDetail = async () => {
    if (!detail) return
    const r = await acc.getCardDetail(detail.kind, from, to)
    setDetail(d => d ? { ...d, rows: r.ok ? r.rows : [], total: r.ok ? r.total : 0 } : d)
    loadDashboard()
  }
  // Hapus baris detail sesuai sumber (soft delete) + konfirmasi
  const deleteDetailRow = async (row) => {
    if (!(await confirm())) return
    let r
    if (row.kind === 'expense') r = await acc.deleteExpense(row.id)
    else if (row.kind === 'purchase') r = await acc.deletePurchase(row.id)
    else if (row.kind === 'supplier_payment') r = await acc.deleteSupplierPayment(row.id)
    else if (row.kind === 'bank_payment') r = await acc.deleteBankPayment(row.id)
    else if (row.kind === 'supplier_debt') r = await acc.deleteSupplierDebt(row.id)
    else if (row.kind === 'bank_loan') r = await acc.deleteBankLoan(row.id)
    else { toast.info('Hapus item ini dari menu sumbernya'); return }
    if (r?.ok) { toast.success('Dihapus'); reloadDetail() } else toast.error(r?.error || 'Gagal')
  }
  // Edit baris detail → buka modal edit yang sesuai (expense/purchase)
  const editDetailRow = (row) => {
    if (row.kind === 'expense') setEditExp({ id: row.id, date: row.date, category: row.party || 'Pembelian Bahan', amount: String(row.amount), method: row.method || 'transfer', note: row.note || '' })
    else if (row.kind === 'purchase') setEditPur({ id: row.id, date: row.date, supplier: row.party || '', item: row.ref || '', amount: String(row.amount), method: row.method || 'transfer', note: row.note || '' })
    else if (row.kind === 'supplier_debt') setEditDebt({ id: row.id, supplier: row.party || '', item: row.ref || '', total: String(row.amount), dueDate: '', note: row.note || '', method: 'transfer' })
    else toast.info('Edit item ini dari menu sumbernya')
  }

  // ── Hutang Bank: expand inline detail + history per pinjaman ──
  const toggleLoan = async (loanId) => {
    if (expandLoan === loanId) { setExpandLoan(null); setHbEdit(null); return }
    setExpandLoan(loanId); setHbEdit(null); setExpLoading(true); setExpRows([])
    const r = await acc.listBankPayments(loanId)
    setExpRows(r.ok ? r.data : []); setExpLoading(false)
  }
  const reloadExp = async () => {
    if (!expandLoan) return
    const r = await acc.listBankPayments(expandLoan)
    setExpRows(r.ok ? r.data : [])
    loadBankLoans(); loadDashboard()
  }

  const saveSupplier = async () => {
    const e = {}; if (!supForm.name.trim()) e.name = 'Nama supplier wajib diisi'
    setSupErr(e); if (Object.keys(e).length) return
    setSaving(true)
    const r = supForm.id ? await acc.updateSupplier(supForm.id, supForm) : await acc.addSupplier(supForm)
    setSaving(false)
    if (r.ok) { toast.success('Supplier disimpan'); setSupForm({ id: null, name: '', phone: '', address: '', note: '' }); setSupErr({}); loadSuppliers() } else toast.error(r.error || 'Gagal')
  }
  const submitLoan = async () => {
    const e = {}
    if (!loanForm.namaBank.trim()) e.namaBank = 'Nama bank wajib diisi'
    if (!(parseCurrency(loanForm.plafon) > 0)) e.plafon = 'Plafon harus lebih dari 0'
    setLoanErr(e); if (Object.keys(e).length) return
    setSaving(true); const r = await acc.addBankLoan(loanForm); setSaving(false)
    if (r.ok) { toast.success('Hutang bank dicatat'); setLoanForm({ namaBank: '', jenis: 'KPR', nomor: '', mulai: '', jatuhTempo: '', plafon: '', sisaPokok: '', bunga: '', cicilan: '', keterangan: '' }); setLoanErr({}); loadBankLoans() } else toast.error(r.error || 'Gagal')
  }

  // ── ASET: validasi + submit ──
  const validateAsset = (f) => {
    const e = {}
    if (!f.name.trim()) e.name = 'Nama aset wajib diisi'
    if (!f.categoryName.trim()) e.categoryName = 'Kategori wajib dipilih'
    if (!f.purchaseDate) e.purchaseDate = 'Tanggal beli wajib diisi'
    if (!(parseCurrency(f.purchasePrice) > 0)) e.purchasePrice = 'Harga beli harus lebih dari 0'
    if (!f.method) e.method = 'Metode penyusutan wajib dipilih'
    if (f.method === 'percentage') { const r = Number(f.rate) || 0; if (!(r > 0 && r <= 100)) e.rate = 'Persentase harus 0–100%' }
    if (f.method === 'straight') { if (!(Number(f.life) > 0)) e.life = 'Umur manfaat harus lebih dari 0' }
    return e
  }
  const catIdByName = (name) => assetCats.find(c => c.name.toLowerCase() === (name || '').toLowerCase())?.id || null
  const submitAsset = async () => {
    const e = validateAsset(assetForm); setAssetErr(e); if (Object.keys(e).length) return
    setSaving(true)
    const r = await acc.addAsset({ ...assetForm, categoryId: catIdByName(assetForm.categoryName), purchasePrice: parseCurrency(assetForm.purchasePrice), residualValue: parseCurrency(assetForm.residualValue), createdBy: currentUser?.id })
    setSaving(false)
    if (r.ok) { toast.success('Aset ditambahkan'); setAssetForm(blankAsset); setAssetErr({}); loadAssets() } else toast.error(r.error)
  }
  const saveEditAsset = async () => {
    const e = validateAsset(editAsset); if (Object.keys(e).length) return toast.error(Object.values(e)[0])
    const r = await acc.updateAsset(editAsset.id, { ...editAsset, categoryId: catIdByName(editAsset.categoryName), purchasePrice: parseCurrency(editAsset.purchasePrice), residualValue: parseCurrency(editAsset.residualValue) })
    if (r.ok) { toast.success('Aset diperbarui'); setEditAsset(null); loadAssets() } else toast.error(r.error)
  }
  const onPhotoPick = async (file, setter) => {
    if (!file) return
    setPhotoBusy(true)
    try { const url = await fileToCompressedDataURL(file); setter(url) } catch { toast.error('Gagal memuat foto') } finally { setPhotoBusy(false) }
  }
  const exportAssets = async () => {
    try {
      const mod = await import('xlsx'); const XLSX = mod.default || mod
      const rows = assets.filter(a => a.status !== 'sold' && a.status !== 'deleted').map(a => {
        const bv = calculateAssetBookValue(a)
        return { 'Nama Aset': a.name, Kategori: a.category_name || '', 'Tanggal Beli': a.purchase_date, 'Harga Beli': Math.round(a.purchase_price || 0), 'Metode': a.depreciation_method, 'Penyusutan/Tahun': bv.perYear, 'Total Penyusutan': bv.totalDep, 'Nilai Buku': bv.bookValue, Status: a.status, Catatan: a.notes || '' }
      })
      const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Aset')
      XLSX.writeFile(wb, `aset-${acc.todayISO()}.xlsx`)
    } catch (e) { toast.error('Export gagal: ' + (e?.message || e)) }
  }
  // Total nilai buku aset aktif (untuk dashboard/neraca) — realtime dari data mentah.
  const asetTetap = useMemo(() => (assets || []).filter(a => a.status === 'active' || a.status === 'depleted' || a.status === 'broken').reduce((s, a) => s + calculateAssetBookValue(a).bookValue, 0), [assets])

  // ── SEWA: validasi + submit ──
  const validateRent = (f) => {
    const e = {}
    if (!f.name.trim()) e.name = 'Nama sewa wajib diisi'
    if (!f.paymentDate) e.paymentDate = 'Tanggal bayar wajib diisi'
    if (!f.startDate) e.startDate = 'Tanggal mulai wajib diisi'
    if (!f.endDate) e.endDate = 'Tanggal akhir wajib diisi'
    if (f.startDate && f.endDate && rentDurationMonths(f.startDate, f.endDate) <= 0) e.endDate = 'Tanggal akhir harus setelah mulai'
    if (!(parseCurrency(f.totalAmount) > 0)) e.totalAmount = 'Total bayar harus lebih dari 0'
    return e
  }
  const submitRent = async () => {
    const e = validateRent(rentForm); setRentErr(e); if (Object.keys(e).length) return
    setSaving(true)
    const r = await acc.addRent({ ...rentForm, totalAmount: parseCurrency(rentForm.totalAmount), durationMonths: rentDurationMonths(rentForm.startDate, rentForm.endDate), createdBy: currentUser?.id })
    setSaving(false)
    if (r.ok) { toast.success('Sewa dicatat'); setRentForm(blankRent); setRentErr({}); loadRents() } else toast.error(r.error)
  }
  const saveEditRent = async () => {
    const e = validateRent(editRent); if (Object.keys(e).length) return toast.error(Object.values(e)[0])
    const r = await acc.updateRent(editRent.id, { ...editRent, totalAmount: parseCurrency(editRent.totalAmount), durationMonths: rentDurationMonths(editRent.startDate, editRent.endDate) })
    if (r.ok) { toast.success('Sewa diperbarui'); setEditRent(null); loadRents() } else toast.error(r.error)
  }

  if (setupNeeded) {
    return (
      <Page from={from} to={to} setFrom={setFrom} setTo={setTo} right={null}>
        <div className="rounded-2xl p-5" style={{ background: 'rgba(245,158,11,0.06)', border: '1px solid rgba(245,158,11,0.3)' }}>
          <div className="flex items-center gap-2 mb-2" style={{ color: '#f59e0b' }}><AlertTriangle size={16} /> <span className="font-bold text-sm" style={{ fontFamily: 'Syne' }}>Modul Accounting belum aktif</span></div>
          <p className="text-xs leading-relaxed" style={{ color: 'var(--text-secondary)' }}>Jalankan migrasi accounting di Supabase → SQL Editor (urut): module → suppliers → rls_fix → dashboard_rpc → sync_fix → supplier_bank.</p>
          <Button variant="secondary" className="mt-3" onClick={() => { setSetupNeeded(false); loadDashboard() }}><RefreshCw size={13} /> Coba lagi</Button>
        </div>
      </Page>
    )
  }

  const right = (
    <div className="flex items-center gap-2 flex-wrap">
      <input type="date" value={from} onChange={e => setFrom(e.target.value)} className="px-2 py-1.5 rounded-lg text-xs" style={{ ...inp, colorScheme: 'dark' }} />
      <span style={{ color: 'var(--text-muted)' }}>—</span>
      <input type="date" value={to} onChange={e => setTo(e.target.value)} className="px-2 py-1.5 rounded-lg text-xs" style={{ ...inp, colorScheme: 'dark' }} />
      <button onClick={doSync} disabled={syncing} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold btn-press" style={{ background: 'rgba(139,92,246,0.12)', color: 'var(--accent-light)', border: '1px solid rgba(139,92,246,0.3)', fontFamily: 'Syne' }}>{syncing ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} Sinkronkan</button>
      <button onClick={exportExcel} disabled={exporting} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold btn-press" style={{ background: 'rgba(16,217,138,0.12)', color: '#10d98a', border: '1px solid rgba(16,217,138,0.3)', fontFamily: 'Syne' }}>{exporting ? <Loader2 size={12} className="animate-spin" /> : <FileSpreadsheet size={12} />} Excel</button>
    </div>
  )

  return (
    <Page from={from} to={to} setFrom={setFrom} setTo={setTo} right={right}>
      <div className="flex gap-1.5 mb-4 overflow-x-auto pb-1 acc-tabscroll" style={{ WebkitOverflowScrolling: 'touch', scrollbarWidth: 'none' }}>
        {TABS.map(t => { const Icon = t.icon; const a = tab === t.id; return (
          <button key={t.id} onClick={() => setTab(t.id)} className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold transition-all flex-shrink-0 whitespace-nowrap"
            style={{ background: a ? 'linear-gradient(135deg, var(--accent), #6366f1)' : 'var(--bg-card)', color: a ? '#fff' : 'var(--text-secondary)', border: `1px solid ${a ? 'transparent' : 'var(--border)'}`, fontFamily: 'Syne' }}><Icon size={12} /> {t.label}</button>
        )})}
      </div>

      {loading && <div className="flex items-center justify-center py-8"><Loader2 size={20} className="animate-spin" style={{ color: 'var(--accent-light)' }} /></div>}

      {/* ── RINGKASAN ── */}
      {tab === 'ringkasan' && !loading && d && (
        <div className="space-y-4">
          {/* BARIS 1: LABA BERSIH — KPI utama, full width, OWNER ONLY */}
          {isOwner && (
            <div onClick={() => openDetail('uang_keluar', 'Pengeluaran (pengurang Laba Bersih)', '#ef4444')}
              className="rounded-2xl p-5 sm:p-6 cursor-pointer hover:brightness-110 transition"
              style={{
                background: laba >= 0 ? 'linear-gradient(135deg, rgba(16,217,138,0.12), rgba(16,217,138,0.04))' : 'linear-gradient(135deg, rgba(239,68,68,0.12), rgba(239,68,68,0.04))',
                border: `1px solid ${laba >= 0 ? 'rgba(16,217,138,0.45)' : 'rgba(239,68,68,0.45)'}`,
                boxShadow: laba >= 0 ? '0 0 28px rgba(16,217,138,0.18)' : '0 0 28px rgba(239,68,68,0.18)',
              }}>
              <div className="flex items-center gap-2 mb-1.5">
                <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: laba >= 0 ? 'rgba(16,217,138,0.15)' : 'rgba(239,68,68,0.15)', border: `1px solid ${laba >= 0 ? 'rgba(16,217,138,0.4)' : 'rgba(239,68,68,0.4)'}` }}>{laba >= 0 ? <TrendingUp size={18} style={{ color: '#10d98a' }} /> : <TrendingDown size={18} style={{ color: '#ef4444' }} />}</div>
                <span className="text-xs font-bold uppercase tracking-wider" style={{ color: 'var(--text-secondary)', fontFamily: "'Inter', sans-serif" }}>Laba Bersih Periode</span>
                <span className="px-1.5 py-0.5 rounded" style={{ background: 'rgba(245,158,11,0.15)', color: '#f59e0b', fontSize: 9, fontFamily: "'Inter', sans-serif" }}>OWNER</span>
              </div>
              <div style={{ fontFamily: "'Inter', 'DM Sans', system-ui, sans-serif", fontWeight: 800, letterSpacing: '-0.02em', color: laba >= 0 ? '#10d98a' : '#ef4444', fontSize: 'clamp(30px,9vw,46px)', lineHeight: 1.05, fontVariantNumeric: 'tabular-nums' }}>{fmt(laba)}</div>
              <div className="text-[11px] mt-1.5" style={{ color: 'var(--text-muted)', fontFamily: "'Inter', sans-serif" }}>Penjualan {fmt(d.penjualan)} − Pengeluaran {fmt(d.pengeluaran_total)}{rentAgg.bebanPeriod > 0 ? ` − Beban Sewa ${fmt(rentAgg.bebanPeriod)}` : ''}</div>
            </div>
          )}

          {/* BARIS 1 — Aktivitas Kas: Penjualan(biru) · Arus Kas(tosca) · Sudah Bayar(hijau muda) · Uang Masuk(hijau) */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <Card icon={Wallet} label="Penjualan / Omzet" value={fmt(d.penjualan)} color="#3b82f6" sub="Total invoice valid" onClick={() => openDetail('penjualan', 'Penjualan / Omzet', '#3b82f6')} />
            <Card icon={Scale} label="Arus Kas Bersih" value={fmt((d.uang_masuk_total || 0) - (d.pengeluaran_total || 0) - rentAgg.cashOutPeriod)} color="#14b8a6" sub="Uang Masuk − Uang Keluar" onClick={() => openDetail('arus_kas', 'Arus Kas Bersih', '#14b8a6')} />
            <Card icon={TrendingUp} label="Sudah Bayar (Piutang)" value={fmt(d.sudah_bayar)} color="#4ade80" sub="DP + cicilan diterima" onClick={() => openDetail('sudah_bayar', 'Sudah Bayar (Piutang)', '#4ade80')} />
            <Card icon={TrendingUp} label="Uang Masuk" value={fmt(d.uang_masuk_total)} color="#10d98a" sub="Yang benar-benar diterima" onClick={() => openDetail('uang_masuk', 'Uang Masuk', '#10d98a')} />
          </div>

          {/* BARIS 2 — Kewajiban & Biaya: Uang Keluar(merah) · Beban(kuning tua) · Hutang Supplier(orange) · Persediaan(ungu) */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <Card icon={TrendingDown} label="Uang Keluar" value={fmt((d.pengeluaran_total || 0) + rentAgg.cashOutPeriod)} color="#ef4444" sub="Termasuk pembayaran sewa" onClick={() => openDetail('uang_keluar', 'Uang Keluar', '#ef4444')} />
            <Card icon={Receipt} label="Beban (Op+Gaji+Bunga)" value={fmt((d.operasional || 0) + (d.gaji || 0) + (d.beban_bunga || 0))} color="#d97706" onClick={() => openDetail('beban', 'Beban (Operasional+Gaji+Bunga)', '#d97706')} />
            <Card icon={Truck} label="Hutang Supplier" value={fmt(d.hutang_supplier)} color="#f97316" onClick={() => openDetail('hutang_supplier', 'Hutang Supplier', '#f97316')} />
            <Card icon={ShoppingCart} label="Persediaan" value={fmt(d.persediaan)} color="#a78bfa" onClick={() => openDetail('persediaan', 'Persediaan', '#a78bfa')} />
            <Card icon={Home} label="Beban Sewa Bulan Ini" value={fmt(rentAgg.bebanBulanIni)} color="#d97706" sub="Akrual sewa berjalan" onClick={() => setTab('sewa')} />
          </div>

          {/* BARIS 3 — Aset & Kewajiban: Piutang Usaha(emas) · Hutang Bank(merah tua, terakhir) */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <Card icon={TrendingUp} label="Piutang Usaha" value={fmt(d.piutang_aktif)} color="#f59e0b" onClick={() => openDetail('piutang', 'Piutang Usaha (Aktif)', '#f59e0b')} />
            <Card icon={Building2} label="Hutang Bank" value={fmt(d.hutang_bank)} color="#b91c1c" sub={`${d.pinjaman_aktif || 0} pinjaman aktif · cicilan ${fmt(d.cicilan_bank)}`} onClick={() => openDetail('hutang_bank', 'Hutang Bank', '#b91c1c')} />
          </div>

          {/* BARIS 4 — Aset & Kekayaan Bersih — OWNER ONLY (sensitif) */}
          {isOwner && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <Card icon={Landmark} label="Aset Tetap (Nilai Buku)" value={fmt(asetTetap)} color="#a78bfa" sub="Klik → kelola aset" onClick={() => setTab('aset')} />
            <Card icon={Home} label="Sewa Dibayar Dimuka" value={fmt(rentAgg.dibayarDimuka)} color="#a78bfa" sub="Sisa sewa belum jadi beban" onClick={() => setTab('sewa')} />
            <Card icon={Wallet} label="Total Aset" value={fmt((d.saldo_kas || 0) + (d.saldo_rekening || 0) + (d.piutang_aktif || 0) + (d.persediaan || 0) + asetTetap + rentAgg.dibayarDimuka)} color="#3b82f6" sub="Kas+Bank+Piutang+Persediaan+Aset+Sewa" />
            <Card icon={Scale} label="Kekayaan Bersih" value={fmt((d.saldo_kas || 0) + (d.saldo_rekening || 0) + (d.piutang_aktif || 0) + (d.persediaan || 0) + asetTetap + rentAgg.dibayarDimuka - (d.hutang_supplier || 0) - (d.hutang_bank || 0))} color="#10d98a" sub="Total Aset − Total Hutang" />
          </div>
          )}

          {/* Neraca sederhana — OWNER ONLY (data ekuitas sensitif) */}
          {isOwner && (
          <div className="rounded-2xl p-4" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
            <div className="text-xs font-bold uppercase tracking-wider mb-3" style={{ color: 'var(--accent-light)', fontFamily: 'Syne' }}>Neraca Sederhana (s/d {dt(to)})</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
              <div>
                <div className="font-bold mb-1" style={{ color: 'var(--text-secondary)' }}>Aset</div>
                {[['Kas', d.saldo_kas], ['Bank', d.saldo_rekening], ['Piutang Usaha', d.piutang_aktif], ['Persediaan', d.persediaan], ['Aset Tetap', asetTetap], ['Sewa Dibayar Dimuka', rentAgg.dibayarDimuka]].map(([k, v]) => <div key={k} className="flex justify-between py-0.5" style={{ color: 'var(--text-muted)' }}><span>{k}</span><span style={{ color: 'var(--text-primary)' }}>{fmt(v)}</span></div>)}
                <div className="flex justify-between py-1 mt-1 font-bold" style={{ borderTop: '1px solid var(--border)', color: 'var(--text-primary)' }}><span>Total Aset</span><span>{fmt(totalAset + asetTetap + rentAgg.dibayarDimuka)}</span></div>
              </div>
              <div>
                <div className="font-bold mb-1" style={{ color: 'var(--text-secondary)' }}>Kewajiban & Ekuitas</div>
                <div className="flex justify-between py-0.5" style={{ color: 'var(--text-muted)' }}><span>Hutang Supplier</span><span style={{ color: 'var(--text-primary)' }}>{fmt(d.hutang_supplier)}</span></div>
                <div className="flex justify-between py-0.5" style={{ color: 'var(--text-muted)' }}><span>Hutang Bank</span><span style={{ color: 'var(--text-primary)' }}>{fmt(d.hutang_bank)}</span></div>
                <div className="flex justify-between py-0.5 font-semibold" style={{ color: 'var(--text-muted)' }}><span>Total Hutang</span><span style={{ color: '#ef4444' }}>{fmt(totalHutang)}</span></div>
                <div className="flex justify-between py-1 mt-1 font-bold" style={{ borderTop: '1px solid var(--border)', color: 'var(--text-primary)' }}><span>Kekayaan Bersih</span><span style={{ color: '#10d98a' }}>{fmt(totalAset + asetTetap + rentAgg.dibayarDimuka - totalHutang)}</span></div>
              </div>
            </div>
          </div>
          )}

          {recap.length > 0 && (
            <div className="rounded-2xl p-4" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
              <div className="text-xs font-bold uppercase tracking-wider mb-2" style={{ color: 'var(--accent-light)', fontFamily: 'Syne' }}>Rekap per Admin</div>
              <table className="w-full text-xs"><thead><tr style={{ borderBottom: '1px solid var(--border)' }}>{['Admin', 'Penjualan', 'Penerimaan'].map((h, i) => <th key={i} className={`px-2 py-1.5 ${i === 0 ? 'text-left' : 'text-right'}`} style={{ color: 'var(--text-muted)', fontFamily: 'Syne', fontSize: 10 }}>{h}</th>)}</tr></thead>
                <tbody>{recap.map((r, i) => <tr key={i} style={{ borderBottom: '1px solid var(--border)' }}><td className="px-2 py-2" style={{ color: 'var(--text-primary)' }}>{adminName(r.cashier_id)}</td><td className="px-2 py-2 text-right">{fmt(r.revenue)}</td><td className="px-2 py-2 text-right" style={{ color: '#10d98a' }}>{fmt(r.cash_in)}</td></tr>)}</tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── JURNAL ── */}
      {tab === 'jurnal' && !loading && (
        <div>
          <div className="overflow-x-auto -mx-1">
            <table className="w-full text-xs" style={{ borderCollapse: 'collapse', minWidth: 560 }}>
              <thead><tr style={{ borderBottom: '1px solid var(--border)' }}>{['Tanggal', 'Sumber', 'Invoice', 'Akun', 'Debit', 'Kredit', 'Keterangan'].map((h, i) => <th key={i} className={`px-2 py-2 ${i >= 4 && i <= 5 ? 'text-right' : 'text-left'}`} style={{ color: 'var(--text-muted)', fontFamily: 'Syne', fontSize: 10 }}>{h}</th>)}</tr></thead>
              <tbody>{entries.length === 0 && <tr><td colSpan={7} className="px-2 py-6 text-center" style={{ color: 'var(--text-muted)' }}>Belum ada jurnal</td></tr>}
                {entries.map(e => <tr key={e.id} style={{ borderBottom: '1px solid var(--border)' }}><td className="px-2 py-2" style={{ color: 'var(--text-secondary)' }}>{dt(e.entry_date)}</td><td className="px-2 py-2" style={{ color: 'var(--text-muted)' }}>{e.source_type}</td><td className="px-2 py-2" style={{ color: 'var(--text-muted)' }}>{e.invoice_no || '—'}</td><td className="px-2 py-2 font-semibold" style={{ color: 'var(--text-primary)' }}>{e.account_code}</td><td className="px-2 py-2 text-right" style={{ color: '#10d98a' }}>{e.debit > 0 ? fmt(e.debit) : '—'}</td><td className="px-2 py-2 text-right" style={{ color: '#ef4444' }}>{e.credit > 0 ? fmt(e.credit) : '—'}</td><td className="px-2 py-2 truncate" style={{ color: 'var(--text-muted)', maxWidth: 200 }}>{e.description}</td></tr>)}
              </tbody>
            </table>
          </div>
          {entCount > acc.PAGE_SIZE && <div className="flex items-center justify-center gap-3 mt-3"><Button variant="secondary" size="sm" disabled={entPage <= 0} onClick={() => loadEntries(entPage - 1)}>Prev</Button><span className="text-xs" style={{ color: 'var(--text-muted)' }}>Hal {entPage + 1}/{lastPage + 1} · {entCount}</span><Button variant="secondary" size="sm" disabled={entPage >= lastPage} onClick={() => loadEntries(entPage + 1)}>Next</Button></div>}
        </div>
      )}

      {/* ── PENGELUARAN ── */}
      {tab === 'pengeluaran' && !loading && (
        <div className="space-y-4">
          <FormCard icon={Receipt} title="Catat Pengeluaran Baru" subtitle="Isi data transaksi dengan lengkap agar laporan accounting akurat.">
            <Field icon={Receipt} label="Tanggal" required error={expErr.date}>
              <input type="date" value={expForm.date} onChange={e => setExpForm(p => ({ ...p, date: e.target.value }))} className={FIELD_CLS} style={{ ...inpErr(expErr.date), colorScheme: 'dark' }} />
            </Field>
            <Field icon={BookOpen} label="Kategori" required error={expErr.category} hint="Klik untuk pilih, ketik untuk mencari">
              <Combo value={expForm.category} onChange={v => setExpForm(p => ({ ...p, category: v }))} options={catOptions} error={expErr.category}
                placeholder="Pilih / cari kategori" baseStyle={inp} errStyle={inpErr(true)}
                rightButton={canManageCat ? <button type="button" onMouseDown={e => e.preventDefault()} onClick={() => { setCatMgr(true); setCatNew(''); setCatEdit(null); setCatSearch('') }} className="px-3 rounded-xl text-xs font-semibold flex-shrink-0 whitespace-nowrap" style={{ background: 'rgba(139,92,246,0.1)', color: 'var(--accent-light)', border: '1px solid rgba(139,92,246,0.2)' }}>+ Kategori</button> : null} />
            </Field>
            <Field icon={Wallet} label="Metode Pembayaran" required error={expErr.method}>
              <select value={expForm.method} onChange={e => setExpForm(p => ({ ...p, method: e.target.value }))} className={FIELD_CLS} style={inpErr(expErr.method)}>{METHODS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}</select>
            </Field>
            <Field icon={TrendingDown} label="Nominal" required error={expErr.amount}>
              <MoneyInput value={expForm.amount} onChange={v => setExpForm(p => ({ ...p, amount: v }))} placeholder="0" className={FIELD_CLS} style={inpErr(expErr.amount)} />
            </Field>
            <Field icon={Pencil} label="Keterangan">
              <input value={expForm.note} onChange={e => setExpForm(p => ({ ...p, note: e.target.value }))} placeholder="Opsional — detail pengeluaran" className={FIELD_CLS} style={inp} />
            </Field>
            <Button variant="primary" className="w-full" onClick={submitExpense} disabled={saving}>{saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Catat Pengeluaran</Button>
          </FormCard>
          <div className="space-y-2">
            <div className="text-xs font-bold uppercase tracking-wider mb-1" style={{ color: 'var(--text-muted)', fontFamily: 'Syne' }}>Riwayat Pengeluaran</div>
            {expenses.length === 0 && <p className="text-xs text-center py-6" style={{ color: 'var(--text-muted)' }}>Belum ada pengeluaran tercatat</p>}
            {expenses.map(x => (
              <div key={x.id} className="flex items-center gap-3 p-3 rounded-xl" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{x.category}{x.note ? <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}> · {x.note}</span> : null}</div>
                  <div className="text-[11px] mt-0.5 flex items-center gap-1.5 flex-wrap" style={{ color: 'var(--text-muted)' }}><span>{dt(x.expense_date)}</span><span className="px-1.5 py-0.5 rounded" style={{ background: 'rgba(139,92,246,0.1)', color: 'var(--accent-light)', textTransform: 'uppercase', fontSize: 9 }}>{x.method}</span></div>
                </div>
                <div className="text-sm font-bold whitespace-nowrap" style={{ color: '#ef4444', fontVariantNumeric: 'tabular-nums', fontSize: 'clamp(12px,3.4vw,15px)' }}>{fmt(x.amount)}</div>
                <button onClick={() => setEditExp({ id: x.id, date: x.expense_date, category: x.category || 'Pembelian Bahan', amount: String(Math.round(x.amount || 0)), method: x.method || 'transfer', note: x.note || '' })} className="w-8 h-8 rounded-lg inline-flex items-center justify-center flex-shrink-0" style={{ background: 'rgba(139,92,246,0.1)', color: 'var(--accent-light)' }} title="Edit"><Pencil size={12} /></button>
                <button onClick={async () => { if (!(await confirm())) return; const r = await acc.deleteExpense(x.id); if (r.ok) { toast.success('Dihapus'); loadExpenses(); loadDashboard() } else toast.error(r.error) }} className="w-8 h-8 rounded-lg inline-flex items-center justify-center flex-shrink-0" style={{ background: 'rgba(255,77,106,0.08)', color: 'var(--red)' }} title="Hapus"><Trash2 size={12} /></button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── PEMBELIAN ── */}
      {tab === 'pembelian' && !loading && (
        <div className="space-y-4">
          {(() => { const qn = parseCurrency(purForm.qty), hn = parseCurrency(purForm.harga); const totalP = qn > 0 ? qn * hn : hn; return (
          <FormCard icon={ShoppingCart} title="Catat Pembelian Baru" subtitle="Isi data transaksi dengan lengkap agar laporan accounting akurat.">
            <Field icon={Receipt} label="Tanggal" required error={purErr.date}>
              <input type="date" value={purForm.date} onChange={e => setPurForm(p => ({ ...p, date: e.target.value }))} className={FIELD_CLS} style={{ ...inpErr(purErr.date), colorScheme: 'dark' }} />
            </Field>
            <Field icon={Truck} label="Supplier" required error={purErr.supplier} hint="Belum ada? Tambah di tab Supplier.">
              <div className="flex gap-2">
                <select value={purForm.supplier} onChange={e => setPurForm(p => ({ ...p, supplier: e.target.value }))} className={FIELD_CLS} style={inpErr(purErr.supplier)}>
                  <option value="">— Pilih Supplier —</option>
                  {suppliers.map(s => <option key={s.id} value={s.name}>{s.name}</option>)}
                </select>
                <button onClick={() => setTab('supplier')} className="px-3 rounded-xl text-xs font-semibold flex-shrink-0 whitespace-nowrap" style={{ background: 'rgba(139,92,246,0.1)', color: 'var(--accent-light)', border: '1px solid rgba(139,92,246,0.2)' }}>+ Baru</button>
              </div>
            </Field>
            <Field icon={ShoppingCart} label="Nama Bahan" required error={purErr.item}>
              <input value={purForm.item} onChange={e => setPurForm(p => ({ ...p, item: e.target.value }))} placeholder="Contoh: Kain Cotton Combed 30s" className={FIELD_CLS} style={inpErr(purErr.item)} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field icon={Plus} label="Jumlah">
                <MoneyInput value={purForm.qty} onChange={v => setPurForm(p => ({ ...p, qty: v }))} placeholder="0" className={FIELD_CLS} style={inp} />
              </Field>
              <Field icon={Wallet} label="Harga Satuan" required error={purErr.harga}>
                <MoneyInput value={purForm.harga} onChange={v => setPurForm(p => ({ ...p, harga: v }))} placeholder="0" className={FIELD_CLS} style={inpErr(purErr.harga)} />
              </Field>
            </div>
            <Field icon={Wallet} label="Metode Pembayaran" required error={purErr.method}>
              <select value={purForm.method} onChange={e => setPurForm(p => ({ ...p, method: e.target.value }))} className={FIELD_CLS} style={inpErr(purErr.method)}>{METHODS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}<option value="hutang">Tempo (Hutang Supplier)</option></select>
            </Field>
            {purForm.method === 'hutang' && (
              <div className="rounded-xl p-3.5 space-y-4" style={{ background: 'rgba(251,146,60,0.06)', border: '1px solid rgba(251,146,60,0.25)' }}>
                <Field icon={Receipt} label="Tanggal Jatuh Tempo" required error={purErr.dueDate}>
                  <input type="date" value={purForm.dueDate} onChange={e => setPurForm(p => ({ ...p, dueDate: e.target.value }))} className={FIELD_CLS} style={{ ...inpErr(purErr.dueDate), colorScheme: 'dark' }} />
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field icon={TrendingDown} label="DP (Uang Muka)" hint="Boleh 0">
                    <MoneyInput value={purForm.paid} onChange={v => setPurForm(p => ({ ...p, paid: v }))} placeholder="0" className={FIELD_CLS} style={inp} />
                  </Field>
                  <Field icon={Wallet} label="DP via">
                    <select value={purForm.dpMethod} onChange={e => setPurForm(p => ({ ...p, dpMethod: e.target.value }))} className={FIELD_CLS} style={inp}>{METHODS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}</select>
                  </Field>
                </div>
                <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>Sisa (total − DP) otomatis masuk Hutang Supplier; hanya DP yang jadi uang keluar.</p>
              </div>
            )}
            <Field icon={Pencil} label="Catatan">
              <input value={purForm.note} onChange={e => setPurForm(p => ({ ...p, note: e.target.value }))} placeholder="Opsional" className={FIELD_CLS} style={inp} />
            </Field>
            {totalP > 0 && <div className="flex items-center justify-between px-3.5 py-2.5 rounded-xl" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}><span className="text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>Total Pembelian</span><span className="text-sm font-bold" style={{ color: '#f59e0b', fontVariantNumeric: 'tabular-nums' }}>{fmt(totalP)}</span></div>}
            <Button variant="primary" className="w-full" onClick={submitPurchase} disabled={saving}>{saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Catat Pembelian</Button>
          </FormCard>
          )})()}
          <div className="space-y-2">
            <div className="text-xs font-bold uppercase tracking-wider mb-1" style={{ color: 'var(--text-muted)', fontFamily: 'Syne' }}>Riwayat Pembelian</div>
            {purchases.length === 0 && <p className="text-xs text-center py-6" style={{ color: 'var(--text-muted)' }}>Belum ada pembelian tercatat</p>}
            {purchases.map(x => (
              <div key={x.id} className="flex items-center gap-3 p-3 rounded-xl" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{x.item || '—'}{x.supplier ? <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}> · {x.supplier}</span> : null}</div>
                  <div className="text-[11px] mt-0.5 flex items-center gap-1.5 flex-wrap" style={{ color: 'var(--text-muted)' }}><span>{dt(x.purchase_date)}</span><span className="px-1.5 py-0.5 rounded" style={{ background: x.is_credit ? 'rgba(251,146,60,0.12)' : 'rgba(139,92,246,0.1)', color: x.is_credit ? '#fb923c' : 'var(--accent-light)', textTransform: 'uppercase', fontSize: 9 }}>{x.is_credit ? 'Kredit' : x.method}</span></div>
                </div>
                <div className="text-sm font-bold whitespace-nowrap" style={{ color: '#f59e0b', fontVariantNumeric: 'tabular-nums', fontSize: 'clamp(12px,3.4vw,15px)' }}>{fmt(x.amount)}</div>
                {!x.is_credit && <button onClick={() => setEditPur({ id: x.id, date: x.purchase_date, supplier: x.supplier || '', item: x.item || '', amount: String(Math.round(x.amount || 0)), method: x.method || 'transfer', note: x.note || '' })} className="w-8 h-8 rounded-lg inline-flex items-center justify-center flex-shrink-0" style={{ background: 'rgba(139,92,246,0.1)', color: 'var(--accent-light)' }} title="Edit"><Pencil size={12} /></button>}
                <button onClick={async () => { if (!(await confirm())) return; const r = await acc.deletePurchase(x.id); if (r.ok) { toast.success('Dihapus'); loadPurchases(); loadDashboard() } else toast.error(r.error) }} className="w-8 h-8 rounded-lg inline-flex items-center justify-center flex-shrink-0" style={{ background: 'rgba(255,77,106,0.08)', color: 'var(--red)' }} title="Hapus"><Trash2 size={12} /></button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── SUPPLIER MASTER ── */}
      {tab === 'supplier' && !loading && (
        <div className="space-y-4">
          <FormCard icon={UsersIcon} title={supForm.id ? 'Edit Supplier' : 'Tambah Supplier Baru'} subtitle="Simpan data supplier agar mudah dipilih saat mencatat pembelian.">
            <Field icon={UsersIcon} label="Nama Supplier" required error={supErr.name}>
              <input value={supForm.name} onChange={e => setSupForm(p => ({ ...p, name: e.target.value }))} placeholder="Contoh: Toko Kain Jaya" className={FIELD_CLS} style={inpErr(supErr.name)} />
            </Field>
            <Field icon={Receipt} label="No. HP">
              <input inputMode="tel" value={supForm.phone} onChange={e => setSupForm(p => ({ ...p, phone: e.target.value }))} placeholder="08xxxxxxxxxx" className={FIELD_CLS} style={inp} />
            </Field>
            <Field icon={Landmark} label="Alamat">
              <input value={supForm.address} onChange={e => setSupForm(p => ({ ...p, address: e.target.value }))} placeholder="Alamat supplier" className={FIELD_CLS} style={inp} />
            </Field>
            <Field icon={Pencil} label="Catatan">
              <input value={supForm.note} onChange={e => setSupForm(p => ({ ...p, note: e.target.value }))} placeholder="Opsional" className={FIELD_CLS} style={inp} />
            </Field>
            <div className="flex gap-2">
              <Button variant="primary" className="flex-1" onClick={saveSupplier} disabled={saving}>{saving ? <Loader2 size={14} className="animate-spin" /> : (supForm.id ? <Check size={14} /> : <Plus size={14} />)} {supForm.id ? 'Simpan Perubahan' : 'Tambah Supplier'}</Button>
              {supForm.id && <Button variant="secondary" onClick={() => { setSupForm({ id: null, name: '', phone: '', address: '', note: '' }); setSupErr({}) }}>Batal</Button>}
            </div>
          </FormCard>
          <div className="relative" style={{ maxWidth: 760 }}>
            <input value={supSearch} onChange={e => setSupSearch(e.target.value)} onKeyDown={e => e.key === 'Enter' && loadSuppliers()} placeholder="Cari supplier... (Enter)" className="w-full px-3.5 py-3 rounded-xl text-sm" style={inp} />
          </div>
          <div className="space-y-2">{suppliers.length === 0 && <p className="text-xs text-center py-6" style={{ color: 'var(--text-muted)' }}>Belum ada supplier</p>}
            {suppliers.map(s => <div key={s.id} className="flex items-center gap-3 p-2.5 rounded-xl" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}><div className="flex-1 min-w-0"><div className="text-xs font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{s.name}</div><div className="text-[11px] truncate" style={{ color: 'var(--text-muted)' }}>{s.phone} · {s.address}</div></div>
              <button onClick={() => setSupForm({ id: s.id, name: s.name, phone: s.phone || '', address: s.address || '', note: s.note || '' })} className="w-7 h-7 rounded-lg inline-flex items-center justify-center" style={{ background: 'rgba(139,92,246,0.1)', color: 'var(--accent-light)' }}><Pencil size={11} /></button>
              <button onClick={async () => { if (!(await confirm())) return; const r = await acc.deleteSupplier(s.id); if (r.ok) { toast.success('Supplier dihapus'); loadSuppliers() } else toast.error(r.error) }} className="w-7 h-7 rounded-lg inline-flex items-center justify-center" style={{ background: 'rgba(255,77,106,0.08)', color: 'var(--red)' }}><Trash2 size={11} /></button>
            </div>)}
          </div>
        </div>
      )}

      {/* ── HUTANG SUPPLIER ── */}
      {tab === 'hsupplier' && !loading && (
        <div className="space-y-4">
          <FormCard icon={Truck} title="Catat Hutang Supplier Baru" subtitle="Isi data transaksi dengan lengkap agar laporan accounting akurat.">
            <Field icon={UsersIcon} label="Supplier" required error={sdErr.supplier} hint="Pilih supplier lama atau ketik nama baru">
              <Combo value={sdForm.supplier} onChange={v => setSdForm(p => ({ ...p, supplier: v }))} options={(suppliers || []).map(s => ({ id: s.id, name: s.name }))} error={sdErr.supplier}
                placeholder="Pilih / cari supplier" baseStyle={inp} errStyle={inpErr(true)}
                allowCreate onCreate={async (name) => { const r = await acc.addSupplier({ name }); if (r.ok) { toast.success('Supplier baru ditambahkan'); loadSuppliers() } }} />
            </Field>
            <Field icon={ShoppingCart} label="Barang" required error={sdErr.item}>
              <input value={sdForm.item} onChange={e => setSdForm(p => ({ ...p, item: e.target.value }))} placeholder="Nama barang / bahan" className={FIELD_CLS} style={inpErr(sdErr.item)} />
            </Field>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field icon={TrendingDown} label="Total Hutang" required error={sdErr.total}>
                <MoneyInput value={sdForm.total} onChange={v => setSdForm(p => ({ ...p, total: v }))} placeholder="0" className={FIELD_CLS} style={inpErr(sdErr.total)} />
              </Field>
              <Field icon={Receipt} label="Jatuh Tempo" required error={sdErr.dueDate}>
                <input type="date" value={sdForm.dueDate} onChange={e => setSdForm(p => ({ ...p, dueDate: e.target.value }))} className={FIELD_CLS} style={{ ...inpErr(sdErr.dueDate), colorScheme: 'dark' }} />
              </Field>
            </div>
            <Button variant="primary" className="w-full" disabled={saving} onClick={async () => {
              const e = {}; if (!sdForm.supplier.trim()) e.supplier = 'Supplier wajib diisi'; if (!sdForm.item.trim()) e.item = 'Barang wajib diisi'; if (!(parseCurrency(sdForm.total) > 0)) e.total = 'Total harus lebih dari 0'; if (!sdForm.dueDate) e.dueDate = 'Jatuh tempo wajib diisi'
              setSdErr(e); if (Object.keys(e).length) return
              setSaving(true); const r = await acc.addSupplierDebt({ ...sdForm, total: parseCurrency(sdForm.total) }); setSaving(false)
              if (r.ok) { toast.success('Hutang supplier dicatat'); setSdForm({ supplier: '', item: '', total: '', dueDate: '' }); setSdErr({}); loadSupDebts(); loadDashboard() } else toast.error(r.error)
            }}>{saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Catat Hutang Supplier</Button>
          </FormCard>
          {/* Ringkasan */}
          {supDebts.length > 0 && (() => {
            const tot = supDebts.reduce((s, x) => s + Math.round(x.total || 0), 0)
            const byr = supDebts.reduce((s, x) => s + Math.round(x.paid || 0), 0)
            const sisa = Math.max(0, tot - byr)
            return (
              <div className="grid grid-cols-3 gap-3">
                <div className="rounded-xl p-3" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}><div className="text-[10px] uppercase" style={{ color: 'var(--text-muted)' }}>Total Hutang</div><div className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>{fmt(tot)}</div></div>
                <div className="rounded-xl p-3" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}><div className="text-[10px] uppercase" style={{ color: 'var(--text-muted)' }}>Sudah Bayar</div><div className="text-sm font-bold" style={{ color: '#10d98a' }}>{fmt(byr)}</div></div>
                <div className="rounded-xl p-3" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}><div className="text-[10px] uppercase" style={{ color: 'var(--text-muted)' }}>Sisa Hutang</div><div className="text-sm font-bold" style={{ color: '#ef4444' }}>{fmt(sisa)}</div></div>
              </div>
            )
          })()}
          <div className="space-y-2">{supDebts.length === 0 && <p className="text-xs text-center py-4" style={{ color: 'var(--text-muted)' }}>Belum ada</p>}
            {supDebts.map(x => {
              const rem = Math.max(0, Math.round(x.total || 0) - Math.round(x.paid || 0))
              const overdue = x.due_date && new Date(x.due_date) < new Date() && rem > 0
              const status = rem <= 0 ? 'Lunas' : overdue ? 'Lewat Tempo' : 'Aktif'
              const stColor = rem <= 0 ? '#10d98a' : overdue ? '#fb923c' : '#f59e0b'
              return (
                <div key={x.id} className="rounded-xl p-3" style={{ background: 'var(--bg-card)', border: `1px solid ${overdue ? 'rgba(251,146,60,0.4)' : 'var(--border)'}` }}>
                  <div className="flex items-center gap-3 flex-wrap">
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{x.supplier || '—'} <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>· {x.item}</span>
                        <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded font-bold" style={{ background: `${stColor}22`, color: stColor }}>{status}</span></div>
                      <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>Total <span style={{ color: 'var(--text-primary)' }}>{fmt(x.total)}</span> · Bayar <span style={{ color: '#10d98a' }}>{fmt(x.paid)}</span>{x.due_date ? ` · Tempo ${dt(x.due_date)}` : ''}</div>
                    </div>
                    <div className="text-right"><div className="text-[10px] uppercase" style={{ color: 'var(--text-muted)' }}>Sisa</div><div className="text-sm font-bold" style={{ color: rem > 0 ? '#ef4444' : '#10d98a' }}>{fmt(rem)}</div></div>
                    {rem > 0 && <button onClick={() => { setPayId(payId === x.id ? null : x.id); setPayVal(String(rem)); setPayMethod('transfer'); setPayNote('') }} className="px-2.5 h-8 rounded-lg text-xs font-semibold" style={{ background: 'linear-gradient(135deg,#10d98a,#059669)', color: '#fff', fontFamily: 'Syne' }}>Bayar</button>}
                    <button onClick={() => setEditDebt({ id: x.id, supplier: x.supplier || '', item: x.item || '', total: String(Math.round(x.total || 0)), dueDate: x.due_date || '', note: x.note || '', method: x.payment_method || 'transfer' })} className="w-8 h-8 rounded-lg inline-flex items-center justify-center" style={{ background: 'rgba(139,92,246,0.1)', color: 'var(--accent-light)' }} title="Edit"><Pencil size={11} /></button>
                    <button onClick={() => openHistory('supplier', { id: x.id, title: `${x.supplier} · ${x.item}` })} className="w-8 h-8 rounded-lg inline-flex items-center justify-center" style={{ background: 'rgba(56,189,248,0.1)', color: '#38BDF8' }} title="Riwayat"><BookOpen size={11} /></button>
                    <button onClick={async () => { if (!(await confirm())) return; const r = await acc.deleteSupplierDebt(x.id); if (r.ok) { toast.success('Dihapus'); loadSupDebts(); loadDashboard() } else toast.error(r.error) }} className="w-8 h-8 rounded-lg inline-flex items-center justify-center" style={{ background: 'rgba(255,77,106,0.08)', color: 'var(--red)' }} title="Hapus"><Trash2 size={11} /></button>
                  </div>
                  {payId === x.id && <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-2 pt-2" style={{ borderTop: '1px dashed var(--border)' }}>
                    <MoneyInput value={payVal} onChange={setPayVal} placeholder="Nominal" className="px-2 py-1.5 rounded-lg text-xs" style={inp} />
                    <select value={payMethod} onChange={e => setPayMethod(e.target.value)} className="px-2 py-1.5 rounded-lg text-xs" style={inp}>{METHODS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}</select>
                    <input value={payNote} onChange={e => setPayNote(e.target.value)} placeholder="Catatan" className="px-2 py-1.5 rounded-lg text-xs" style={inp} />
                    <Button variant="success" size="sm" onClick={async () => { const amt = parseCurrency(payVal); if (!(amt > 0)) return toast.error('Nominal > 0'); const r = await acc.paySupplierDebt(x.id, Math.min(amt, rem), payMethod, currentUser?.id, payNote); if (r.ok) { toast.success('Dibayar'); setPayId(null); loadSupDebts(); loadDashboard() } else toast.error(r.error) }}>Konfirmasi</Button>
                  </div>}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* ── HUTANG BANK ── */}
      {tab === 'hbank' && !loading && (
        <div className="space-y-4">
          <FormCard icon={Building2} title="Catat Hutang Bank Baru" subtitle="Isi data pinjaman dengan lengkap agar laporan accounting akurat.">
            <Field icon={Building2} label="Nama Bank" required error={loanErr.namaBank}>
              <input value={loanForm.namaBank} onChange={e => setLoanForm(p => ({ ...p, namaBank: e.target.value }))} placeholder="Contoh: BCA" className={FIELD_CLS} style={inpErr(loanErr.namaBank)} />
            </Field>
            <Field icon={BookOpen} label="Jenis Pinjaman" required>
              <select value={loanForm.jenis} onChange={e => setLoanForm(p => ({ ...p, jenis: e.target.value }))} className={FIELD_CLS} style={inp}>{['KPR', 'Kredit Modal Kerja (KMK)', 'Pinjaman Investasi', 'Leasing Kendaraan', 'Leasing Mesin', 'Pinjaman Usaha Lainnya'].map(j => <option key={j} value={j}>{j}</option>)}</select>
            </Field>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field icon={Landmark} label="Plafon Pinjaman" required error={loanErr.plafon}>
                <MoneyInput value={loanForm.plafon} onChange={v => setLoanForm(p => ({ ...p, plafon: v }))} placeholder="0" className={FIELD_CLS} style={inpErr(loanErr.plafon)} />
              </Field>
              <Field icon={TrendingDown} label="Sisa Pokok" hint="Kosongkan → otomatis = Plafon saat disimpan">
                <MoneyInput value={loanForm.sisaPokok} onChange={v => setLoanForm(p => ({ ...p, sisaPokok: v }))} placeholder="0" className={FIELD_CLS} style={inp} />
              </Field>
            </div>
            <Field icon={Wallet} label="Cicilan / Bulan">
              <MoneyInput value={loanForm.cicilan} onChange={v => setLoanForm(p => ({ ...p, cicilan: v }))} placeholder="0" className={FIELD_CLS} style={inp} />
            </Field>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field icon={Receipt} label="Tanggal Mulai">
                <input type="date" value={loanForm.mulai} onChange={e => setLoanForm(p => ({ ...p, mulai: e.target.value }))} className={FIELD_CLS} style={{ ...inp, colorScheme: 'dark' }} />
              </Field>
              <Field icon={Receipt} label="Jatuh Tempo">
                <input type="date" value={loanForm.jatuhTempo} onChange={e => setLoanForm(p => ({ ...p, jatuhTempo: e.target.value }))} className={FIELD_CLS} style={{ ...inp, colorScheme: 'dark' }} />
              </Field>
            </div>
            <Button variant="primary" className="w-full" onClick={submitLoan} disabled={saving}>{saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Tambah Pinjaman</Button>
          </FormCard>
          <div className="space-y-2">{bankLoans.length === 0 && <p className="text-xs text-center py-4" style={{ color: 'var(--text-muted)' }}>Belum ada hutang bank</p>}
            {bankLoans.map(x => {
              const overdue7 = x.tanggal_jatuh_tempo && (new Date(x.tanggal_jatuh_tempo) - new Date()) / 86400000 <= 7 && (new Date(x.tanggal_jatuh_tempo) - new Date()) >= 0 && x.status === 'aktif'
              return (
                <div key={x.id} className="rounded-xl p-3" style={{ background: 'var(--bg-card)', border: `1px solid ${overdue7 ? 'rgba(245,158,11,0.5)' : 'var(--border)'}` }}>
                  <div className="flex items-center gap-3">
                    <div onClick={() => toggleLoan(x.id)} className="flex-1 min-w-0 cursor-pointer">
                      <div className="text-xs font-semibold truncate flex items-center gap-1" style={{ color: 'var(--text-primary)' }}>
                        <ChevronDown size={13} style={{ color: 'var(--accent-light)', transform: expandLoan === x.id ? 'rotate(180deg)' : 'none', transition: 'transform .2s' }} />
                        {x.nama_bank} <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>· {x.jenis_pinjaman}</span>
                      </div>
                      <div className="text-[11px] ml-4" style={{ color: 'var(--text-muted)' }}>Plafon {fmt(x.plafon_pinjaman)} · Cicilan {fmt(x.cicilan_bulanan)}/bln {x.tanggal_jatuh_tempo ? `· Tempo ${dt(x.tanggal_jatuh_tempo)}` : ''}</div>
                      {overdue7 && <div className="text-[11px] font-bold mt-0.5 ml-4" style={{ color: '#f59e0b' }}>⏰ Cicilan {x.nama_bank} jatuh tempo dalam 7 hari</div>}
                    </div>
                    <div className="text-right"><div className="text-[10px] uppercase" style={{ color: 'var(--text-muted)' }}>Sisa Pokok</div><div className="text-sm font-bold" style={{ color: x.sisa_pokok > 0 ? '#ef4444' : '#10d98a' }}>{fmt(x.sisa_pokok)}</div></div>
                    {x.sisa_pokok > 0 && <button onClick={async () => {
                      if (bpay?.loanId === x.id) { setBpay(null); return }
                      const h = await acc.listBankPayments(x.id)
                      const n = (h.ok ? h.data.length : 0) + 1
                      setBpay({ loanId: x.id, amount: String(Math.round(x.cicilan_bulanan || 0)), method: 'transfer', note: '', paymentNumber: n, sisa: Math.round(x.sisa_pokok || 0) })
                    }} className="px-2.5 h-8 rounded-lg text-xs font-semibold" style={{ background: 'linear-gradient(135deg,#10d98a,#059669)', color: '#fff', fontFamily: 'Syne' }}>Bayar</button>}
                    <button onClick={() => toggleLoan(x.id)} className="w-8 h-8 rounded-lg inline-flex items-center justify-center" style={{ background: 'rgba(56,189,248,0.1)', color: '#38BDF8' }} title="Riwayat Pembayaran"><BookOpen size={11} /></button>
                    <button onClick={async () => { if (!(await confirm())) return; const r = await acc.deleteBankLoan(x.id); if (r.ok) { toast.success('Dihapus'); loadBankLoans(); loadDashboard() } else toast.error(r.error) }} className="w-8 h-8 rounded-lg inline-flex items-center justify-center" style={{ background: 'rgba(255,77,106,0.08)', color: 'var(--red)' }}><Trash2 size={11} /></button>
                  </div>

                  {/* Expand inline: detail pinjaman + history pembayaran */}
                  {expandLoan === x.id && (
                    <div className="mt-3 pt-3 space-y-3" style={{ borderTop: '1px solid var(--border)' }}>
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                        {[['Plafon Awal', fmt(x.plafon_pinjaman)], ['Cicilan/bln', fmt(x.cicilan_bulanan)], ['Sisa Pokok', fmt(x.sisa_pokok)], ['Status', x.status === 'lunas' ? 'Lunas' : 'Aktif'], ['Mulai', dt(x.tanggal_mulai)], ['Tempo', dt(x.tanggal_jatuh_tempo)]].map(([k, v]) => (
                          <div key={k} className="rounded-lg p-2" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}><div className="text-[9px] uppercase" style={{ color: 'var(--text-muted)' }}>{k}</div><div className="text-xs font-bold" style={{ color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>{v}</div></div>
                        ))}
                      </div>
                      <div className="text-[10px] font-bold uppercase tracking-wider" style={{ color: 'var(--text-muted)', fontFamily: 'Syne' }}>History Pembayaran</div>
                      {expLoading ? <div className="flex justify-center py-4"><Loader2 size={16} className="animate-spin" style={{ color: 'var(--accent-light)' }} /></div>
                        : expRows.length === 0 ? <p className="text-xs text-center py-4" style={{ color: 'var(--text-muted)' }}>Belum ada pembayaran untuk pinjaman ini.</p>
                        : (() => {
                          const numMap = {}; [...expRows].sort((a, b) => new Date(a.paid_at) - new Date(b.paid_at)).forEach((p, i) => { numMap[p.id] = i + 1 })
                          return (
                          <div className="overflow-x-auto -mx-1">
                            <table className="w-full text-xs" style={{ borderCollapse: 'collapse', minWidth: 520 }}>
                              <thead><tr style={{ borderBottom: '1px solid var(--border)' }}>{['Ke-', 'Tanggal', 'Nominal', 'Metode', 'Keterangan', 'Admin', ''].map((h, i) => <th key={i} className={`px-2 py-1.5 ${h === 'Nominal' ? 'text-right' : 'text-left'}`} style={{ color: 'var(--text-muted)', fontFamily: 'Syne', fontSize: 10 }}>{h}</th>)}</tr></thead>
                              <tbody>
                                {expRows.map(p => hbEdit?.id === p.id ? (
                                  <tr key={p.id} style={{ background: 'rgba(139,92,246,0.05)', borderBottom: '1px solid var(--border)' }}>
                                    <td className="px-2 py-2 font-bold" style={{ color: 'var(--accent-light)' }}>#{numMap[p.id]}</td>
                                    <td className="px-2 py-2"><input type="date" value={hbEdit.date} onChange={e => setHbEdit(s => ({ ...s, date: e.target.value }))} className="px-2 py-1 rounded text-xs" style={{ ...inp, colorScheme: 'dark' }} /></td>
                                    <td className="px-2 py-2"><MoneyInput value={hbEdit.amount} onChange={v => setHbEdit(s => ({ ...s, amount: v }))} placeholder="Nominal" className="px-2 py-1 rounded text-xs w-28" style={inp} /></td>
                                    <td className="px-2 py-2"><select value={hbEdit.method} onChange={e => setHbEdit(s => ({ ...s, method: e.target.value }))} className="px-2 py-1 rounded text-xs" style={inp}>{METHODS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}</select></td>
                                    <td className="px-2 py-2" colSpan={2}><input value={hbEdit.note} onChange={e => setHbEdit(s => ({ ...s, note: e.target.value }))} placeholder="Catatan" className="px-2 py-1 rounded text-xs w-full" style={inp} /></td>
                                    <td className="px-2 py-2 text-right whitespace-nowrap">
                                      <button onClick={async () => {
                                        const amt = parseCurrency(hbEdit.amount); if (!(amt > 0)) return toast.error('Nominal > 0')
                                        const r = await acc.editBankPayment(p.id, { amount: amt, method: hbEdit.method, note: hbEdit.note, paidAt: hbEdit.date })
                                        if (r.ok) { toast.success('Diperbarui'); setHbEdit(null); reloadExp() } else toast.error(r.error)
                                      }} className="w-6 h-6 rounded inline-flex items-center justify-center mr-1" style={{ background: 'rgba(16,217,138,0.12)', color: '#10d98a' }}><Check size={11} /></button>
                                      <button onClick={() => setHbEdit(null)} className="w-6 h-6 rounded inline-flex items-center justify-center" style={{ background: 'rgba(255,255,255,0.05)', color: 'var(--text-secondary)' }}><X size={11} /></button>
                                    </td>
                                  </tr>
                                ) : (
                                  <tr key={p.id} style={{ borderBottom: '1px solid var(--border)' }}>
                                    <td className="px-2 py-2 font-bold" style={{ color: 'var(--accent-light)' }}>#{numMap[p.id]}</td>
                                    <td className="px-2 py-2" style={{ color: 'var(--text-secondary)' }}>{dt(p.paid_at)}</td>
                                    <td className="px-2 py-2 text-right font-bold" style={{ color: '#ef4444', fontVariantNumeric: 'tabular-nums' }}>{fmt(p.amount)}</td>
                                    <td className="px-2 py-2" style={{ color: 'var(--text-muted)', textTransform: 'uppercase', fontSize: 10 }}>{p.method}</td>
                                    <td className="px-2 py-2 truncate" style={{ color: 'var(--text-muted)', maxWidth: 140 }}>{p.note}</td>
                                    <td className="px-2 py-2" style={{ color: 'var(--text-muted)' }}>{adminName(p.cashier_id)}</td>
                                    <td className="px-2 py-2 text-right whitespace-nowrap">
                                      <button onClick={() => setHbEdit({ id: p.id, amount: String(Math.round(p.amount || 0)), method: p.method || 'transfer', note: p.note || '', date: (p.paid_at || '').slice(0, 10) })} className="w-6 h-6 rounded inline-flex items-center justify-center mr-1" style={{ background: 'rgba(139,92,246,0.1)', color: 'var(--accent-light)' }}><Pencil size={11} /></button>
                                      <button onClick={async () => { if (!(await confirm())) return; const r = await acc.deleteBankPayment(p.id); if (r.ok) { toast.success('Dihapus · sisa pokok diperbarui'); reloadExp() } else toast.error(r.error) }} className="w-6 h-6 rounded inline-flex items-center justify-center" style={{ background: 'rgba(255,77,106,0.08)', color: 'var(--red)' }}><Trash2 size={11} /></button>
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                          )
                        })()}
                    </div>
                  )}
                  {bpay?.loanId === x.id && (() => {
                    const amt = parseCurrency(bpay.amount)
                    const over = amt > (bpay.sisa || 0)
                    return (
                    <div className="mt-3 pt-3 space-y-3" style={{ borderTop: '1px dashed var(--border)' }}>
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold px-2.5 py-1 rounded-lg" style={{ background: 'rgba(139,92,246,0.12)', color: 'var(--accent-light)', fontFamily: 'Syne' }}>Pembayaran ke-{bpay.paymentNumber}</span>
                        <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>Sisa pokok: <b style={{ color: '#ef4444' }}>{fmt(bpay.sisa)}</b></span>
                      </div>
                      <Field icon={Wallet} label="Total Bayar" required error={over ? 'Nominal pembayaran melebihi sisa pokok' : ''} hint="Otomatis dari cicilan/bln, bisa diubah">
                        <MoneyInput value={bpay.amount} onChange={v => setBpay(p => ({ ...p, amount: v }))} placeholder="0" className={FIELD_CLS} style={inpErr(over)} />
                      </Field>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <Field icon={Wallet} label="Metode Pembayaran" required>
                          <select value={bpay.method} onChange={e => setBpay(p => ({ ...p, method: e.target.value }))} className={FIELD_CLS} style={inp}>{METHODS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}</select>
                        </Field>
                        <Field icon={Pencil} label="Catatan">
                          <input value={bpay.note} onChange={e => setBpay(p => ({ ...p, note: e.target.value }))} placeholder="Opsional" className={FIELD_CLS} style={inp} />
                        </Field>
                      </div>
                      <Button variant="success" className="w-full" onClick={async () => {
                        const amount = parseCurrency(bpay.amount)
                        if (!(amount > 0)) return toast.error('Nominal harus > 0')
                        if (amount > (bpay.sisa || 0)) return toast.error('Nominal pembayaran melebihi sisa pokok')
                        const r = await acc.payBankLoan(x.id, { amount, method: bpay.method, note: bpay.note, cashierId: currentUser?.id, paymentNumber: bpay.paymentNumber })
                        if (r.ok) { toast.success('Pembayaran ke-' + bpay.paymentNumber + ' tersimpan'); setBpay(null); loadBankLoans(); loadDashboard() } else toast.error(r.error)
                      }}><Check size={14} /> Konfirmasi Pembayaran</Button>
                      <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>Seluruh nominal mengurangi sisa pokok. Sisa pokok 0 → status LUNAS.</p>
                    </div>
                    )
                  })()}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* ── ASET TETAP + PENYUSUTAN ── */}
      {tab === 'aset' && !loading && (
        <div className="space-y-4">
          <FormCard icon={Landmark} title="Tambah Aset Baru" subtitle="Catat aset usaha; nilai buku & penyusutan dihitung otomatis tiap tahun.">
            <Field icon={Landmark} label="Nama Aset" required error={assetErr.name}>
              <input value={assetForm.name} onChange={e => setAssetForm(p => ({ ...p, name: e.target.value }))} placeholder="Contoh: Mesin DTF A3" className={FIELD_CLS} style={inpErr(assetErr.name)} />
            </Field>
            <Field icon={BookOpen} label="Kategori Aset" required error={assetErr.categoryName}>
              <Combo value={assetForm.categoryName} onChange={v => setAssetForm(p => ({ ...p, categoryName: v }))} options={assetCatOptions} error={assetErr.categoryName} placeholder="Pilih / cari kategori" baseStyle={inp} errStyle={inpErr(true)} allowCreate onCreate={async (name) => { const r = await acc.addAssetCategory(name); if (r.ok) { toast.success('Kategori aset ditambah'); loadAssetCats() } }} />
            </Field>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field icon={Receipt} label="Tanggal Beli" required error={assetErr.purchaseDate}>
                <input type="date" value={assetForm.purchaseDate} onChange={e => setAssetForm(p => ({ ...p, purchaseDate: e.target.value }))} className={FIELD_CLS} style={{ ...inpErr(assetErr.purchaseDate), colorScheme: 'dark' }} />
              </Field>
              <Field icon={Wallet} label="Harga Beli" required error={assetErr.purchasePrice}>
                <MoneyInput value={assetForm.purchasePrice} onChange={v => setAssetForm(p => ({ ...p, purchasePrice: v }))} className={FIELD_CLS} style={inpErr(assetErr.purchasePrice)} />
              </Field>
            </div>
            <Field icon={BookOpen} label="Metode Penyusutan" required error={assetErr.method}>
              <select value={assetForm.method} onChange={e => setAssetForm(p => ({ ...p, method: e.target.value }))} className={FIELD_CLS} style={inpErr(assetErr.method)}>{DEP_METHODS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}</select>
            </Field>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field icon={TrendingDown} label="Nilai Residu / Sisa">
                <MoneyInput value={assetForm.residualValue} onChange={v => setAssetForm(p => ({ ...p, residualValue: v }))} className={FIELD_CLS} style={inp} />
              </Field>
              {assetForm.method === 'percentage' && (
                <Field icon={TrendingDown} label="Penyusutan / Tahun (%)" required error={assetErr.rate}>
                  <input inputMode="decimal" value={assetForm.rate} onChange={e => setAssetForm(p => ({ ...p, rate: e.target.value.replace(/[^\d.]/g, '') }))} placeholder="contoh: 10" className={FIELD_CLS} style={inpErr(assetErr.rate)} />
                </Field>
              )}
              {assetForm.method === 'straight' && (
                <Field icon={Receipt} label="Umur Manfaat (tahun)" required error={assetErr.life}>
                  <input inputMode="numeric" value={assetForm.life} onChange={e => setAssetForm(p => ({ ...p, life: e.target.value.replace(/[^\d]/g, '') }))} placeholder="contoh: 5" className={FIELD_CLS} style={inpErr(assetErr.life)} />
                </Field>
              )}
            </div>
            <Field icon={Pencil} label="Catatan">
              <input value={assetForm.notes} onChange={e => setAssetForm(p => ({ ...p, notes: e.target.value }))} placeholder="Opsional" className={FIELD_CLS} style={inp} />
            </Field>
            <Field icon={Landmark} label="Foto Aset">
              <div className="flex items-center gap-3">
                {assetForm.photoUrl ? <img src={assetForm.photoUrl} alt="" style={{ width: 48, height: 48, borderRadius: 8, objectFit: 'cover' }} /> : <div style={{ width: 48, height: 48, borderRadius: 8, background: 'var(--bg-elevated)', border: '1px solid var(--border)' }} className="flex items-center justify-center"><Landmark size={18} style={{ color: 'var(--text-muted)' }} /></div>}
                <label className="px-3 py-2 rounded-xl text-xs font-semibold cursor-pointer" style={{ background: 'rgba(139,92,246,0.1)', color: 'var(--accent-light)', border: '1px solid rgba(139,92,246,0.2)' }}>{photoBusy ? 'Memproses…' : 'Pilih Foto'}<input type="file" accept="image/*" className="hidden" onChange={e => onPhotoPick(e.target.files?.[0], url => setAssetForm(p => ({ ...p, photoUrl: url })))} /></label>
                {assetForm.photoUrl && <button type="button" onClick={() => setAssetForm(p => ({ ...p, photoUrl: '' }))} className="text-xs" style={{ color: 'var(--red)' }}>Hapus</button>}
              </div>
            </Field>
            <Button variant="primary" className="w-full" onClick={submitAsset} disabled={saving}>{saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Tambah Aset</Button>
          </FormCard>

          {/* Filter + Export + Ringkasan */}
          <div className="flex items-center gap-2 flex-wrap">
            <select value={assetFilter.cat} onChange={e => setAssetFilter(p => ({ ...p, cat: e.target.value }))} className="px-2.5 py-1.5 rounded-lg text-xs" style={inp}><option value="all">Semua Kategori</option>{assetCatOptions.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}</select>
            <select value={assetFilter.status} onChange={e => setAssetFilter(p => ({ ...p, status: e.target.value }))} className="px-2.5 py-1.5 rounded-lg text-xs" style={inp}><option value="all">Semua Status</option>{Object.entries(ASSET_STATUS).filter(([k]) => k !== 'deleted').map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select>
            <select value={assetFilter.method} onChange={e => setAssetFilter(p => ({ ...p, method: e.target.value }))} className="px-2.5 py-1.5 rounded-lg text-xs" style={inp}><option value="all">Semua Metode</option>{DEP_METHODS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}</select>
            <button onClick={exportAssets} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold btn-press" style={{ background: 'rgba(16,217,138,0.12)', color: '#10d98a', border: '1px solid rgba(16,217,138,0.3)', fontFamily: 'Syne' }}><FileSpreadsheet size={12} /> Export</button>
            <div className="ml-auto rounded-lg px-3 py-1.5" style={{ background: 'rgba(167,139,250,0.1)', border: '1px solid rgba(167,139,250,0.3)' }}><span className="text-[10px] uppercase" style={{ color: 'var(--text-muted)' }}>Aset Tetap </span><span className="text-xs font-bold" style={{ color: '#a78bfa' }}>{fmt(asetTetap)}</span></div>
          </div>

          {/* List aset */}
          {(() => {
            const list = (assets || []).filter(a => (assetFilter.cat === 'all' || a.category_name === assetFilter.cat) && (assetFilter.status === 'all' || a.status === assetFilter.status) && (assetFilter.method === 'all' || a.depreciation_method === assetFilter.method))
            if (list.length === 0) return <p className="text-xs text-center py-6" style={{ color: 'var(--text-muted)' }}>Belum ada aset tercatat</p>
            return (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                {list.map(a => {
                  const bv = calculateAssetBookValue(a)
                  const st = ASSET_STATUS[a.status] || ASSET_STATUS.active
                  return (
                    <div key={a.id} className="rounded-xl p-3 min-w-0" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
                      <div className="flex items-start gap-3 min-w-0">
                        {a.photo_url ? <img src={a.photo_url} alt="" style={{ width: 52, height: 52, borderRadius: 10, objectFit: 'cover', flexShrink: 0 }} /> : <div style={{ width: 52, height: 52, borderRadius: 10, background: 'var(--bg-elevated)', border: '1px solid var(--border)', flexShrink: 0 }} className="flex items-center justify-center"><Landmark size={20} style={{ color: 'var(--text-muted)' }} /></div>}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-xs font-bold truncate" style={{ color: 'var(--text-primary)' }}>{a.name}</span>
                            <span className="text-[9px] px-1.5 py-0.5 rounded font-bold" style={{ background: `${st.color}22`, color: st.color }}>{st.label}</span>
                          </div>
                          <div className="text-[11px] truncate" style={{ color: 'var(--text-muted)' }}>{a.category_name || '—'} · beli {dt(a.purchase_date)} · umur {bv.age} th</div>
                          <div className="grid grid-cols-3 gap-1.5 mt-2">
                            <div className="min-w-0"><div className="text-[9px] uppercase" style={{ color: 'var(--text-muted)' }}>Harga Beli</div><div className="text-[11px] font-bold truncate" style={{ color: 'var(--text-primary)' }}>{fmt(a.purchase_price)}</div></div>
                            <div className="min-w-0"><div className="text-[9px] uppercase" style={{ color: 'var(--text-muted)' }}>Peny./Thn</div><div className="text-[11px] font-bold truncate" style={{ color: '#f59e0b' }}>{fmt(bv.perYear)}</div></div>
                            <div className="min-w-0"><div className="text-[9px] uppercase" style={{ color: 'var(--text-muted)' }}>Nilai Buku</div><div className="text-[11px] font-bold truncate" style={{ color: '#10d98a' }}>{fmt(bv.bookValue)}</div></div>
                          </div>
                        </div>
                      </div>
                      <div className="flex gap-1.5 mt-2.5 pt-2.5" style={{ borderTop: '1px solid var(--border)' }}>
                        <button onClick={() => setDetailAsset(a)} className="flex-1 py-1.5 rounded-lg text-[11px] font-semibold" style={{ background: 'rgba(56,189,248,0.1)', color: '#38BDF8', fontFamily: 'Syne' }}>Detail</button>
                        {a.status !== 'sold' && <button onClick={() => setEditAsset({ id: a.id, name: a.name, categoryName: a.category_name || '', purchaseDate: a.purchase_date, purchasePrice: String(Math.round(a.purchase_price || 0)), residualValue: String(Math.round(a.residual_value || 0)), method: a.depreciation_method || 'percentage', rate: String(a.depreciation_rate || ''), life: String(a.useful_life_years || ''), notes: a.notes || '', photoUrl: a.photo_url || '' })} className="flex-1 py-1.5 rounded-lg text-[11px] font-semibold" style={{ background: 'rgba(139,92,246,0.1)', color: 'var(--accent-light)', fontFamily: 'Syne' }}>Edit</button>}
                        {a.status !== 'sold' && <button onClick={() => setSellState({ id: a.id, name: a.name, book: bv.bookValue, soldDate: acc.todayISO(), soldPrice: '', method: 'transfer', note: '' })} className="flex-1 py-1.5 rounded-lg text-[11px] font-semibold" style={{ background: 'rgba(16,217,138,0.1)', color: '#10d98a', fontFamily: 'Syne' }}>Jual</button>}
                        <button onClick={async () => { if (!(await confirm({ title: 'Yakin ingin menghapus aset ini?' }))) return; const r = await acc.deleteAsset(a.id); if (r.ok) { toast.success('Aset dihapus'); loadAssets() } else toast.error(r.error) }} className="px-3 py-1.5 rounded-lg" style={{ background: 'rgba(255,77,106,0.08)', color: 'var(--red)' }}><Trash2 size={12} /></button>
                      </div>
                    </div>
                  )
                })}
              </div>
            )
          })()}
        </div>
      )}

      {/* ── SEWA TOKO DIBAYAR DIMUKA ── */}
      {tab === 'sewa' && !loading && (
        <div className="space-y-4">
          {(() => { const dur = rentDurationMonths(rentForm.startDate, rentForm.endDate); const monthly = dur ? Math.round(parseCurrency(rentForm.totalAmount) / dur) : 0; return (
          <FormCard icon={Home} title="Tambah Sewa Toko" subtitle="Sewa dibayar di muka; otomatis dibebankan per bulan ke laba/rugi.">
            <Field icon={Home} label="Nama Sewa" required error={rentErr.name}>
              <input value={rentForm.name} onChange={e => setRentForm(p => ({ ...p, name: e.target.value }))} placeholder="Contoh: Sewa Toko Tanah Abang" className={FIELD_CLS} style={inpErr(rentErr.name)} />
            </Field>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field icon={Landmark} label="Lokasi / Alamat"><input value={rentForm.location} onChange={e => setRentForm(p => ({ ...p, location: e.target.value }))} placeholder="Opsional" className={FIELD_CLS} style={inp} /></Field>
              <Field icon={UsersIcon} label="Pemilik / Penerima Sewa"><input value={rentForm.landlord} onChange={e => setRentForm(p => ({ ...p, landlord: e.target.value }))} placeholder="Opsional" className={FIELD_CLS} style={inp} /></Field>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <Field icon={Receipt} label="Tanggal Bayar" required error={rentErr.paymentDate}><input type="date" value={rentForm.paymentDate} onChange={e => setRentForm(p => ({ ...p, paymentDate: e.target.value }))} className={FIELD_CLS} style={{ ...inpErr(rentErr.paymentDate), colorScheme: 'dark' }} /></Field>
              <Field icon={Receipt} label="Mulai Sewa" required error={rentErr.startDate}><input type="date" value={rentForm.startDate} onChange={e => setRentForm(p => ({ ...p, startDate: e.target.value }))} className={FIELD_CLS} style={{ ...inpErr(rentErr.startDate), colorScheme: 'dark' }} /></Field>
              <Field icon={Receipt} label="Akhir Sewa" required error={rentErr.endDate}><input type="date" value={rentForm.endDate} onChange={e => setRentForm(p => ({ ...p, endDate: e.target.value }))} className={FIELD_CLS} style={{ ...inpErr(rentErr.endDate), colorScheme: 'dark' }} /></Field>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field icon={Wallet} label="Total Bayar" required error={rentErr.totalAmount}><MoneyInput value={rentForm.totalAmount} onChange={v => setRentForm(p => ({ ...p, totalAmount: v }))} className={FIELD_CLS} style={inpErr(rentErr.totalAmount)} /></Field>
              <Field icon={Wallet} label="Metode Pembayaran" required><select value={rentForm.method} onChange={e => setRentForm(p => ({ ...p, method: e.target.value }))} className={FIELD_CLS} style={inp}>{METHODS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}</select></Field>
            </div>
            {dur > 0 && <div className="rounded-xl px-3.5 py-2.5 flex items-center justify-between flex-wrap gap-2" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}><span className="text-xs" style={{ color: 'var(--text-secondary)' }}>Durasi <b>{dur} bulan</b></span><span className="text-xs" style={{ color: 'var(--text-secondary)' }}>Beban / bulan <b style={{ color: '#f59e0b' }}>{fmt(monthly)}</b></span></div>}
            <Field icon={Pencil} label="Nomor Bukti / Catatan"><input value={rentForm.notes} onChange={e => setRentForm(p => ({ ...p, notes: e.target.value }))} placeholder="Opsional" className={FIELD_CLS} style={inp} /></Field>
            <Field icon={Home} label="Upload Bukti Pembayaran">
              <div className="flex items-center gap-3">
                {rentForm.proofUrl ? <img src={rentForm.proofUrl} alt="" style={{ width: 48, height: 48, borderRadius: 8, objectFit: 'cover' }} /> : <div style={{ width: 48, height: 48, borderRadius: 8, background: 'var(--bg-elevated)', border: '1px solid var(--border)' }} className="flex items-center justify-center"><Receipt size={18} style={{ color: 'var(--text-muted)' }} /></div>}
                <label className="px-3 py-2 rounded-xl text-xs font-semibold cursor-pointer" style={{ background: 'rgba(139,92,246,0.1)', color: 'var(--accent-light)', border: '1px solid rgba(139,92,246,0.2)' }}>{photoBusy ? 'Memproses…' : 'Pilih Bukti'}<input type="file" accept="image/*" className="hidden" onChange={e => onPhotoPick(e.target.files?.[0], url => setRentForm(p => ({ ...p, proofUrl: url })))} /></label>
                {rentForm.proofUrl && <button type="button" onClick={() => setRentForm(p => ({ ...p, proofUrl: '' }))} className="text-xs" style={{ color: 'var(--red)' }}>Hapus</button>}
              </div>
            </Field>
            <Button variant="primary" className="w-full" onClick={submitRent} disabled={saving}>{saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Catat Sewa</Button>
          </FormCard>
          )})()}

          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-xl p-3" style={{ background: 'rgba(167,139,250,0.1)', border: '1px solid rgba(167,139,250,0.3)' }}><div className="text-[10px] uppercase" style={{ color: 'var(--text-muted)' }}>Sewa Dibayar Dimuka</div><div className="text-sm font-bold" style={{ color: '#a78bfa' }}>{fmt(rentAgg.dibayarDimuka)}</div></div>
            <div className="rounded-xl p-3" style={{ background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.3)' }}><div className="text-[10px] uppercase" style={{ color: 'var(--text-muted)' }}>Beban Sewa Bulan Ini</div><div className="text-sm font-bold" style={{ color: '#f59e0b' }}>{fmt(rentAgg.bebanBulanIni)}</div></div>
          </div>

          <div className="space-y-2">
            {rents.length === 0 && <p className="text-xs text-center py-6" style={{ color: 'var(--text-muted)' }}>Belum ada sewa tercatat</p>}
            {rents.map(r => {
              const a = rentAmortization(r)
              return (
                <div key={r.id} className="rounded-xl p-3 min-w-0" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
                  <div className="flex items-start gap-3 min-w-0">
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-bold truncate" style={{ color: 'var(--text-primary)' }}>{r.name}</div>
                      <div className="text-[11px] truncate" style={{ color: 'var(--text-muted)' }}>{r.location || '—'} · {dt(r.start_date)}–{dt(r.end_date)} · {a.dur} bln</div>
                      <div className="grid grid-cols-3 gap-1.5 mt-2">
                        <div className="min-w-0"><div className="text-[9px] uppercase" style={{ color: 'var(--text-muted)' }}>Total</div><div className="text-[11px] font-bold truncate" style={{ color: 'var(--text-primary)' }}>{fmt(a.total)}</div></div>
                        <div className="min-w-0"><div className="text-[9px] uppercase" style={{ color: 'var(--text-muted)' }}>Beban/bln</div><div className="text-[11px] font-bold truncate" style={{ color: '#f59e0b' }}>{fmt(a.monthly)}</div></div>
                        <div className="min-w-0"><div className="text-[9px] uppercase" style={{ color: 'var(--text-muted)' }}>Dibayar Dimuka</div><div className="text-[11px] font-bold truncate" style={{ color: '#a78bfa' }}>{fmt(a.prepaid)}</div></div>
                      </div>
                    </div>
                  </div>
                  <div className="flex gap-1.5 mt-2.5 pt-2.5" style={{ borderTop: '1px solid var(--border)' }}>
                    <button onClick={() => setDetailRent(r)} className="flex-1 py-1.5 rounded-lg text-[11px] font-semibold" style={{ background: 'rgba(56,189,248,0.1)', color: '#38BDF8', fontFamily: 'Syne' }}>Detail & Jadwal</button>
                    <button onClick={() => setEditRent({ id: r.id, name: r.name, location: r.location || '', landlord: r.landlord_name || '', paymentDate: r.payment_date, startDate: r.start_date, endDate: r.end_date, totalAmount: String(Math.round(r.total_amount || 0)), method: r.payment_method || 'transfer', notes: r.notes || '' })} className="flex-1 py-1.5 rounded-lg text-[11px] font-semibold" style={{ background: 'rgba(139,92,246,0.1)', color: 'var(--accent-light)', fontFamily: 'Syne' }}>Edit</button>
                    <button onClick={async () => { if (!(await confirm({ title: 'Yakin ingin menghapus data sewa ini? Semua jadwal beban sewa juga akan dihapus.' }))) return; const res = await acc.deleteRent(r.id); if (res.ok) { toast.success('Sewa dihapus'); loadRents(); loadDashboard() } else toast.error(res.error) }} className="px-3 py-1.5 rounded-lg" style={{ background: 'rgba(255,77,106,0.08)', color: 'var(--red)' }}><Trash2 size={12} /></button>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* ── DETAIL SEWA (jadwal amortisasi) ── */}
      <Modal open={!!detailRent} onClose={() => setDetailRent(null)} title={detailRent ? `Sewa — ${detailRent.name}` : ''} size="lg">
        {detailRent && (() => {
          const a = rentAmortization(detailRent); const sched = rentSchedule(detailRent)
          const STAT = { pending: { label: 'Belum berjalan', color: 'var(--text-muted)' }, accrued: { label: 'Sudah dibebankan', color: '#10d98a' }, done: { label: 'Selesai', color: '#38BDF8' } }
          const info = [['Lokasi', detailRent.location || '—'], ['Pemilik', detailRent.landlord_name || '—'], ['Tanggal Bayar', dt(detailRent.payment_date)], ['Periode', `${dt(detailRent.start_date)} – ${dt(detailRent.end_date)}`], ['Durasi', `${a.dur} bulan`], ['Total Bayar', fmt(a.total)], ['Beban / Bulan', fmt(a.monthly)], ['Sudah Berjalan', `${a.elapsed} bln · ${fmt(a.accrued)}`], ['Dibayar Dimuka', fmt(a.prepaid)], ['Metode', (detailRent.payment_method || '').toUpperCase()]]
          return (
            <div className="space-y-3">
              {detailRent.proof_url && <img src={detailRent.proof_url} alt="" style={{ width: '100%', maxHeight: 160, borderRadius: 12, objectFit: 'cover' }} />}
              <div className="grid grid-cols-2 gap-2">
                {info.map(([k, v]) => <div key={k} className="rounded-lg p-2 min-w-0" style={{ background: 'var(--bg-elevated)' }}><div className="text-[9px] uppercase" style={{ color: 'var(--text-muted)' }}>{k}</div><div className="text-xs font-bold truncate" style={{ color: 'var(--text-primary)' }}>{v}</div></div>)}
              </div>
              {detailRent.notes && <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Catatan: {detailRent.notes}</p>}
              <div className="text-[10px] font-bold uppercase tracking-wider" style={{ color: 'var(--text-muted)', fontFamily: 'Syne' }}>Jadwal Amortisasi</div>
              <div className="overflow-x-auto -mx-1">
                <table className="w-full text-xs" style={{ borderCollapse: 'collapse', minWidth: 360 }}>
                  <thead><tr style={{ borderBottom: '1px solid var(--border)' }}>{['Bln', 'Periode', 'Beban', 'Status'].map((h, i) => <th key={i} className={`px-2 py-1.5 ${h === 'Beban' ? 'text-right' : 'text-left'}`} style={{ color: 'var(--text-muted)', fontFamily: 'Syne', fontSize: 10 }}>{h}</th>)}</tr></thead>
                  <tbody>{sched.map(s => { const st = STAT[s.status]; return (
                    <tr key={s.idx} style={{ borderBottom: '1px solid var(--border)' }}>
                      <td className="px-2 py-1.5" style={{ color: 'var(--text-secondary)' }}>{s.idx}</td>
                      <td className="px-2 py-1.5" style={{ color: 'var(--text-muted)' }}>{s.periodMonth.toLocaleDateString('id-ID', { month: 'short', year: 'numeric' })}</td>
                      <td className="px-2 py-1.5 text-right font-bold" style={{ color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>{fmt(s.amount)}</td>
                      <td className="px-2 py-1.5"><span style={{ color: st.color, fontSize: 10 }}>{st.label}</span></td>
                    </tr>
                  )})}</tbody>
                </table>
              </div>
            </div>
          )
        })()}
      </Modal>

      {/* ── EDIT SEWA ── */}
      <Modal open={!!editRent} onClose={() => setEditRent(null)} title="Edit Sewa Toko" size="sm">
        {editRent && (
          <div className="space-y-3">
            <Field icon={Home} label="Nama Sewa" required><input value={editRent.name} onChange={e => setEditRent(p => ({ ...p, name: e.target.value }))} className={FIELD_CLS} style={inp} /></Field>
            <Field icon={Landmark} label="Lokasi"><input value={editRent.location} onChange={e => setEditRent(p => ({ ...p, location: e.target.value }))} className={FIELD_CLS} style={inp} /></Field>
            <div className="grid grid-cols-2 gap-2">
              <Field icon={Receipt} label="Mulai" required><input type="date" value={editRent.startDate} onChange={e => setEditRent(p => ({ ...p, startDate: e.target.value }))} className={FIELD_CLS} style={{ ...inp, colorScheme: 'dark' }} /></Field>
              <Field icon={Receipt} label="Akhir" required><input type="date" value={editRent.endDate} onChange={e => setEditRent(p => ({ ...p, endDate: e.target.value }))} className={FIELD_CLS} style={{ ...inp, colorScheme: 'dark' }} /></Field>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Field icon={Receipt} label="Tgl Bayar" required><input type="date" value={editRent.paymentDate} onChange={e => setEditRent(p => ({ ...p, paymentDate: e.target.value }))} className={FIELD_CLS} style={{ ...inp, colorScheme: 'dark' }} /></Field>
              <Field icon={Wallet} label="Total Bayar" required><MoneyInput value={editRent.totalAmount} onChange={v => setEditRent(p => ({ ...p, totalAmount: v }))} className={FIELD_CLS} style={inp} /></Field>
            </div>
            <Field icon={Pencil} label="Catatan"><input value={editRent.notes} onChange={e => setEditRent(p => ({ ...p, notes: e.target.value }))} className={FIELD_CLS} style={inp} /></Field>
            <Button variant="primary" className="w-full" onClick={saveEditRent}><Check size={14} /> Simpan (jadwal dihitung ulang)</Button>
          </div>
        )}
      </Modal>

      {/* ── DETAIL ASET (+ simulasi penyusutan) ── */}
      <Modal open={!!detailAsset} onClose={() => setDetailAsset(null)} title={detailAsset ? `Aset — ${detailAsset.name}` : ''} size="lg">
        {detailAsset && (() => {
          const bv = calculateAssetBookValue(detailAsset)
          const sched = assetDepreciationSchedule(detailAsset)
          const methodLabel = DEP_METHODS.find(m => m.id === detailAsset.depreciation_method)?.label || detailAsset.depreciation_method
          const rows = [['Kategori', detailAsset.category_name || '—'], ['Tanggal Beli', dt(detailAsset.purchase_date)], ['Harga Beli', fmt(detailAsset.purchase_price)], ['Nilai Residu', fmt(detailAsset.residual_value)], ['Metode', methodLabel], ['Persentase', detailAsset.depreciation_method === 'percentage' ? `${detailAsset.depreciation_rate || 0}%` : '—'], ['Umur Manfaat', detailAsset.useful_life_years ? `${detailAsset.useful_life_years} th` : '—'], ['Umur Aset', `${bv.age} th`], ['Penyusutan/Tahun', fmt(bv.perYear)], ['Total Penyusutan', fmt(bv.totalDep)], ['Nilai Buku', fmt(bv.bookValue)]]
          return (
            <div className="space-y-3">
              {detailAsset.photo_url && <img src={detailAsset.photo_url} alt="" style={{ width: '100%', maxHeight: 180, borderRadius: 12, objectFit: 'cover' }} />}
              <div className="grid grid-cols-2 gap-2">
                {rows.map(([k, v]) => <div key={k} className="rounded-lg p-2" style={{ background: 'var(--bg-elevated)' }}><div className="text-[9px] uppercase" style={{ color: 'var(--text-muted)' }}>{k}</div><div className="text-xs font-bold" style={{ color: 'var(--text-primary)' }}>{v}</div></div>)}
              </div>
              {detailAsset.notes && <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Catatan: {detailAsset.notes}</p>}
              {sched.length > 1 && (
                <div>
                  <div className="text-[10px] font-bold uppercase tracking-wider mb-1" style={{ color: 'var(--text-muted)', fontFamily: 'Syne' }}>Simulasi Penyusutan</div>
                  <div className="overflow-x-auto -mx-1">
                    <table className="w-full text-xs" style={{ borderCollapse: 'collapse', minWidth: 280 }}>
                      <thead><tr style={{ borderBottom: '1px solid var(--border)' }}><th className="px-2 py-1.5 text-left" style={{ color: 'var(--text-muted)', fontSize: 10 }}>Tahun ke-</th><th className="px-2 py-1.5 text-right" style={{ color: 'var(--text-muted)', fontSize: 10 }}>Nilai Buku</th></tr></thead>
                      <tbody>{sched.map(r => <tr key={r.year} style={{ borderBottom: '1px solid var(--border)' }}><td className="px-2 py-1.5" style={{ color: 'var(--text-secondary)' }}>Tahun {r.year}{r.year === bv.age ? ' (sekarang)' : ''}</td><td className="px-2 py-1.5 text-right font-bold" style={{ color: r.year === bv.age ? '#10d98a' : 'var(--text-primary)' }}>{fmt(r.book)}</td></tr>)}</tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )
        })()}
      </Modal>

      {/* ── EDIT ASET ── */}
      <Modal open={!!editAsset} onClose={() => setEditAsset(null)} title="Edit Aset" size="sm">
        {editAsset && (
          <div className="space-y-3">
            <Field icon={Landmark} label="Nama Aset" required><input value={editAsset.name} onChange={e => setEditAsset(p => ({ ...p, name: e.target.value }))} className={FIELD_CLS} style={inp} /></Field>
            <Field icon={BookOpen} label="Kategori" required><Combo value={editAsset.categoryName} onChange={v => setEditAsset(p => ({ ...p, categoryName: v }))} options={assetCatOptions} placeholder="Pilih / cari kategori" baseStyle={inp} errStyle={inpErr(true)} allowCreate onCreate={async (name) => { const r = await acc.addAssetCategory(name); if (r.ok) loadAssetCats() }} /></Field>
            <div className="grid grid-cols-2 gap-2">
              <Field icon={Receipt} label="Tanggal Beli" required><input type="date" value={editAsset.purchaseDate} onChange={e => setEditAsset(p => ({ ...p, purchaseDate: e.target.value }))} className={FIELD_CLS} style={{ ...inp, colorScheme: 'dark' }} /></Field>
              <Field icon={Wallet} label="Harga Beli" required><MoneyInput value={editAsset.purchasePrice} onChange={v => setEditAsset(p => ({ ...p, purchasePrice: v }))} className={FIELD_CLS} style={inp} /></Field>
            </div>
            <Field icon={BookOpen} label="Metode Penyusutan" required><select value={editAsset.method} onChange={e => setEditAsset(p => ({ ...p, method: e.target.value }))} className={FIELD_CLS} style={inp}>{DEP_METHODS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}</select></Field>
            <div className="grid grid-cols-2 gap-2">
              <Field icon={TrendingDown} label="Nilai Residu"><MoneyInput value={editAsset.residualValue} onChange={v => setEditAsset(p => ({ ...p, residualValue: v }))} className={FIELD_CLS} style={inp} /></Field>
              {editAsset.method === 'percentage' && <Field icon={TrendingDown} label="Peny./Tahun (%)"><input inputMode="decimal" value={editAsset.rate} onChange={e => setEditAsset(p => ({ ...p, rate: e.target.value.replace(/[^\d.]/g, '') }))} className={FIELD_CLS} style={inp} /></Field>}
              {editAsset.method === 'straight' && <Field icon={Receipt} label="Umur Manfaat (th)"><input inputMode="numeric" value={editAsset.life} onChange={e => setEditAsset(p => ({ ...p, life: e.target.value.replace(/[^\d]/g, '') }))} className={FIELD_CLS} style={inp} /></Field>}
            </div>
            <Field icon={Pencil} label="Catatan"><input value={editAsset.notes} onChange={e => setEditAsset(p => ({ ...p, notes: e.target.value }))} className={FIELD_CLS} style={inp} /></Field>
            <Button variant="primary" className="w-full" onClick={saveEditAsset}><Check size={14} /> Simpan</Button>
          </div>
        )}
      </Modal>

      {/* ── JUAL ASET ── */}
      <Modal open={!!sellState} onClose={() => setSellState(null)} title="Jual Aset" size="sm">
        {sellState && (() => {
          const hj = parseCurrency(sellState.soldPrice); const gl = hj - sellState.book
          return (
            <div className="space-y-3">
              <div className="rounded-lg p-2.5 text-xs" style={{ background: 'var(--bg-elevated)', color: 'var(--text-secondary)' }}>Aset: <b style={{ color: 'var(--text-primary)' }}>{sellState.name}</b> · Nilai buku: <b style={{ color: '#10d98a' }}>{fmt(sellState.book)}</b></div>
              <Field icon={Receipt} label="Tanggal Jual" required><input type="date" value={sellState.soldDate} onChange={e => setSellState(p => ({ ...p, soldDate: e.target.value }))} className={FIELD_CLS} style={{ ...inp, colorScheme: 'dark' }} /></Field>
              <Field icon={Wallet} label="Harga Jual" required><MoneyInput value={sellState.soldPrice} onChange={v => setSellState(p => ({ ...p, soldPrice: v }))} className={FIELD_CLS} style={inp} /></Field>
              <Field icon={Wallet} label="Metode Pembayaran" required><select value={sellState.method} onChange={e => setSellState(p => ({ ...p, method: e.target.value }))} className={FIELD_CLS} style={inp}>{METHODS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}</select></Field>
              <Field icon={Pencil} label="Catatan"><input value={sellState.note} onChange={e => setSellState(p => ({ ...p, note: e.target.value }))} className={FIELD_CLS} style={inp} /></Field>
              {hj > 0 && <div className="text-xs font-semibold" style={{ color: gl >= 0 ? '#10d98a' : '#ef4444' }}>{gl >= 0 ? 'Keuntungan' : 'Kerugian'} penjualan: {fmt(Math.abs(gl))}</div>}
              <Button variant="primary" className="w-full" onClick={async () => {
                if (!(parseCurrency(sellState.soldPrice) > 0)) return toast.error('Harga jual harus > 0')
                const r = await acc.sellAsset(sellState.id, { soldDate: sellState.soldDate, soldPrice: parseCurrency(sellState.soldPrice), method: sellState.method, note: sellState.note })
                if (r.ok) { toast.success(`Aset terjual · ${gl >= 0 ? 'untung' : 'rugi'} ${fmt(Math.abs(gl))}`); setSellState(null); loadAssets() } else toast.error(r.error)
              }}><Check size={14} /> Konfirmasi Jual</Button>
            </div>
          )
        })()}
      </Modal>

      {/* ── RIWAYAT PEMBAYARAN (supplier / bank) ── */}
      <Modal open={!!history} onClose={() => { setHistory(null); setHEdit(null) }} title={history ? `Riwayat Pembayaran — ${history.title}` : ''} size="lg">
        {history && (
          hLoading ? <div className="flex justify-center py-8"><Loader2 size={18} className="animate-spin" style={{ color: 'var(--accent-light)' }} /></div>
          : (history.rows || []).length === 0 ? <p className="text-xs text-center py-6" style={{ color: 'var(--text-muted)' }}>Belum ada pembayaran</p>
          : (() => {
            const isBank = history.kind === 'bank'
            // payment_number dihitung ulang berurutan dari pembayaran aktif (paid_at asc)
            const numMap = {}
            if (isBank) [...(history.rows || [])].sort((a, b) => new Date(a.paid_at) - new Date(b.paid_at)).forEach((p, i) => { numMap[p.id] = i + 1 })
            const headers = [...(isBank ? ['Ke-'] : []), 'Tanggal', 'Nominal', 'Metode', 'Keterangan', 'Admin', '']
            const editCols = isBank ? 4 : 4
            return (
            <div className="overflow-x-auto -mx-1">
              <table className="w-full text-xs" style={{ borderCollapse: 'collapse', minWidth: 540 }}>
                <thead><tr style={{ borderBottom: '1px solid var(--border)' }}>{headers.map((h, i) => <th key={i} className={`px-2 py-2 ${h === 'Nominal' ? 'text-right' : 'text-left'}`} style={{ color: 'var(--text-muted)', fontFamily: 'Syne', fontSize: 10 }}>{h}</th>)}</tr></thead>
                <tbody>
                  {(history.rows || []).map(p => hEdit?.id === p.id ? (
                    <tr key={p.id} style={{ background: 'rgba(139,92,246,0.05)', borderBottom: '1px solid var(--border)' }}>
                      {isBank && <td className="px-2 py-2 font-bold" style={{ color: 'var(--accent-light)' }}>#{numMap[p.id]}</td>}
                      <td className="px-2 py-2" style={{ color: 'var(--text-muted)' }}>{dt(p.paid_at)}</td>
                      <td className="px-2 py-2" colSpan={editCols}>
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                          <MoneyInput value={hEdit.amount} onChange={v => setHEdit(s => ({ ...s, amount: v }))} placeholder="Nominal" className="px-2 py-1 rounded text-xs" style={inp} />
                          <select value={hEdit.method} onChange={e => setHEdit(s => ({ ...s, method: e.target.value }))} className="px-2 py-1 rounded text-xs" style={inp}>{METHODS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}</select>
                          <input value={hEdit.note} onChange={e => setHEdit(s => ({ ...s, note: e.target.value }))} placeholder="Keterangan" className="px-2 py-1 rounded text-xs" style={inp} />
                        </div>
                      </td>
                      <td className="px-2 py-2 text-right whitespace-nowrap">
                        <button onClick={async () => {
                          const r = isBank
                            ? await acc.editBankPayment(p.id, { amount: parseCurrency(hEdit.amount), method: hEdit.method, note: hEdit.note })
                            : await acc.editSupplierPayment(p.id, { amount: parseCurrency(hEdit.amount), method: hEdit.method, note: hEdit.note })
                          if (r.ok) { toast.success('Diperbarui'); setHEdit(null); reloadHistory() } else toast.error(r.error)
                        }} className="w-6 h-6 rounded inline-flex items-center justify-center mr-1" style={{ background: 'rgba(16,217,138,0.12)', color: '#10d98a' }}><Check size={11} /></button>
                        <button onClick={() => setHEdit(null)} className="w-6 h-6 rounded inline-flex items-center justify-center" style={{ background: 'rgba(255,255,255,0.05)', color: 'var(--text-secondary)' }}><X size={11} /></button>
                      </td>
                    </tr>
                  ) : (
                    <tr key={p.id} style={{ borderBottom: '1px solid var(--border)' }}>
                      {isBank && <td className="px-2 py-2 font-bold" style={{ color: 'var(--accent-light)' }}>#{numMap[p.id]}</td>}
                      <td className="px-2 py-2" style={{ color: 'var(--text-secondary)' }}>{dt(p.paid_at)}</td>
                      <td className="px-2 py-2 text-right font-bold" style={{ color: '#ef4444', fontVariantNumeric: 'tabular-nums' }}>{fmt(p.amount)}</td>
                      <td className="px-2 py-2" style={{ color: 'var(--text-muted)', textTransform: 'uppercase', fontSize: 10 }}>{p.method}</td>
                      <td className="px-2 py-2 truncate" style={{ color: 'var(--text-muted)', maxWidth: 160 }}>{p.note}</td>
                      <td className="px-2 py-2" style={{ color: 'var(--text-muted)' }}>{adminName(p.cashier_id)}</td>
                      <td className="px-2 py-2 text-right whitespace-nowrap">
                        <button onClick={() => setHEdit({ id: p.id, amount: String(Math.round(p.amount || 0)), method: p.method || 'transfer', note: p.note || '' })} className="w-6 h-6 rounded inline-flex items-center justify-center mr-1" style={{ background: 'rgba(139,92,246,0.1)', color: 'var(--accent-light)' }}><Pencil size={11} /></button>
                        <button onClick={async () => { if (!(await confirm())) return; const r = isBank ? await acc.deleteBankPayment(p.id) : await acc.deleteSupplierPayment(p.id); if (r.ok) { toast.success('Dihapus'); reloadHistory() } else toast.error(r.error) }} className="w-6 h-6 rounded inline-flex items-center justify-center" style={{ background: 'rgba(255,77,106,0.08)', color: 'var(--red)' }}><Trash2 size={11} /></button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            )
          })()
        )}
      </Modal>

      {/* ── EDIT HUTANG SUPPLIER ── */}
      <Modal open={!!editDebt} onClose={() => setEditDebt(null)} title="Edit Hutang Supplier" size="sm">
        {editDebt && (
          <div className="space-y-3">
            <input value={editDebt.supplier} onChange={e => setEditDebt(p => ({ ...p, supplier: e.target.value }))} placeholder="Supplier" className="w-full px-3 py-2 rounded-xl text-sm" style={inp} />
            <input value={editDebt.item} onChange={e => setEditDebt(p => ({ ...p, item: e.target.value }))} placeholder="Barang" className="w-full px-3 py-2 rounded-xl text-sm" style={inp} />
            <MoneyInput value={editDebt.total} onChange={v => setEditDebt(p => ({ ...p, total: v }))} placeholder="Total hutang" className="w-full px-3 py-2 rounded-xl text-sm" style={inp} />
            <input type="date" value={editDebt.dueDate || ''} onChange={e => setEditDebt(p => ({ ...p, dueDate: e.target.value }))} className="w-full px-3 py-2 rounded-xl text-sm" style={{ ...inp, colorScheme: 'dark' }} />
            <input value={editDebt.note} onChange={e => setEditDebt(p => ({ ...p, note: e.target.value }))} placeholder="Catatan" className="w-full px-3 py-2 rounded-xl text-sm" style={inp} />
            <Button variant="primary" className="w-full" onClick={async () => {
              const r = await acc.editSupplierDebt(editDebt.id, { supplier: editDebt.supplier, item: editDebt.item, total: parseCurrency(editDebt.total), dueDate: editDebt.dueDate || null, note: editDebt.note, method: editDebt.method })
              if (r.ok) { toast.success('Hutang diperbarui'); setEditDebt(null); loadSupDebts(); loadDashboard(); reloadDetail() } else toast.error(r.error)
            }}><Check size={14} /> Simpan</Button>
          </div>
        )}
      </Modal>

      {/* ── EDIT PENGELUARAN ── */}
      <Modal open={!!editExp} onClose={() => setEditExp(null)} title="Edit Pengeluaran" size="sm">
        {editExp && (
          <div className="space-y-3">
            <Field icon={Receipt} label="Tanggal" required><input type="date" value={editExp.date} onChange={e => setEditExp(p => ({ ...p, date: e.target.value }))} className={FIELD_CLS} style={{ ...inp, colorScheme: 'dark' }} /></Field>
            <Field icon={BookOpen} label="Kategori" required><Combo value={editExp.category} onChange={v => setEditExp(p => ({ ...p, category: v }))} options={catOptions} placeholder="Pilih / cari kategori" baseStyle={inp} errStyle={inpErr(true)} /></Field>
            <Field icon={Wallet} label="Metode Pembayaran" required><select value={editExp.method} onChange={e => setEditExp(p => ({ ...p, method: e.target.value }))} className={FIELD_CLS} style={inp}>{METHODS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}</select></Field>
            <Field icon={TrendingDown} label="Nominal" required><MoneyInput value={editExp.amount} onChange={v => setEditExp(p => ({ ...p, amount: v }))} placeholder="0" className={FIELD_CLS} style={inp} /></Field>
            <Field icon={Pencil} label="Keterangan"><input value={editExp.note} onChange={e => setEditExp(p => ({ ...p, note: e.target.value }))} placeholder="Opsional" className={FIELD_CLS} style={inp} /></Field>
            <Button variant="primary" className="w-full" onClick={async () => {
              if (!(parseCurrency(editExp.amount) > 0)) return toast.error('Nominal harus > 0')
              const r = await acc.updateExpense(editExp.id, { date: editExp.date, category: editExp.category, amount: parseCurrency(editExp.amount), method: editExp.method, note: editExp.note })
              if (r.ok) { toast.success('Pengeluaran diperbarui'); setEditExp(null); loadExpenses(); loadDashboard(); reloadDetail() } else toast.error(r.error)
            }}><Check size={14} /> Simpan</Button>
          </div>
        )}
      </Modal>

      {/* ── EDIT PEMBELIAN ── */}
      <Modal open={!!editPur} onClose={() => setEditPur(null)} title="Edit Pembelian" size="sm">
        {editPur && (
          <div className="space-y-3">
            <Field icon={Receipt} label="Tanggal" required><input type="date" value={editPur.date} onChange={e => setEditPur(p => ({ ...p, date: e.target.value }))} className={FIELD_CLS} style={{ ...inp, colorScheme: 'dark' }} /></Field>
            <Field icon={Truck} label="Supplier"><input value={editPur.supplier} onChange={e => setEditPur(p => ({ ...p, supplier: e.target.value }))} placeholder="Supplier" className={FIELD_CLS} style={inp} /></Field>
            <Field icon={ShoppingCart} label="Nama Bahan" required><input value={editPur.item} onChange={e => setEditPur(p => ({ ...p, item: e.target.value }))} placeholder="Nama bahan" className={FIELD_CLS} style={inp} /></Field>
            <Field icon={Wallet} label="Metode Pembayaran" required><select value={editPur.method} onChange={e => setEditPur(p => ({ ...p, method: e.target.value }))} className={FIELD_CLS} style={inp}>{METHODS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}</select></Field>
            <Field icon={TrendingDown} label="Total" required><MoneyInput value={editPur.amount} onChange={v => setEditPur(p => ({ ...p, amount: v }))} placeholder="0" className={FIELD_CLS} style={inp} /></Field>
            <Field icon={Pencil} label="Catatan"><input value={editPur.note} onChange={e => setEditPur(p => ({ ...p, note: e.target.value }))} placeholder="Opsional" className={FIELD_CLS} style={inp} /></Field>
            <Button variant="primary" className="w-full" onClick={async () => {
              if (!(parseCurrency(editPur.amount) > 0)) return toast.error('Total harus > 0')
              const r = await acc.updatePurchase(editPur.id, { date: editPur.date, supplier: editPur.supplier, item: editPur.item, amount: parseCurrency(editPur.amount), method: editPur.method, note: editPur.note })
              if (r.ok) { toast.success('Pembelian diperbarui'); setEditPur(null); loadPurchases(); loadDashboard(); reloadDetail() } else toast.error(r.error)
            }}><Check size={14} /> Simpan</Button>
          </div>
        )}
      </Modal>

      {/* ── MASTER KATEGORI PENGELUARAN ── */}
      <Modal open={catMgr} onClose={() => { setCatMgr(false); setCatEdit(null) }} title="Kelola Kategori Pengeluaran" size="sm">
        <div className="space-y-3">
          {canManageCat && (
            <div className="flex gap-2">
              <input value={catNew} onChange={e => setCatNew(e.target.value)} placeholder="Nama kategori baru" className={FIELD_CLS} style={inp} onKeyDown={async e => { if (e.key === 'Enter' && catNew.trim()) { const r = await acc.addExpenseCategory(catNew); if (r.ok) { toast.success('Kategori ditambah'); setCatNew(''); loadExpCats() } else toast.error(r.error) } }} />
              <Button variant="primary" onClick={async () => { if (!catNew.trim()) return; const r = await acc.addExpenseCategory(catNew); if (r.ok) { toast.success('Kategori ditambah'); setCatNew(''); loadExpCats() } else toast.error(r.error) }}><Plus size={14} /></Button>
            </div>
          )}
          <div className="relative">
            <Search size={13} style={{ position: 'absolute', left: 10, top: 11, color: 'var(--text-muted)' }} />
            <input value={catSearch} onChange={e => setCatSearch(e.target.value)} placeholder="Cari kategori..." className="w-full pl-8 pr-3 py-2.5 rounded-xl text-sm" style={inp} />
          </div>
          <div className="space-y-1.5 max-h-72 overflow-y-auto">
            {expCats.filter(c => c.name.toLowerCase().includes(catSearch.toLowerCase())).length === 0 && <p className="text-xs text-center py-4" style={{ color: 'var(--text-muted)' }}>Tidak ada kategori</p>}
            {expCats.filter(c => c.name.toLowerCase().includes(catSearch.toLowerCase())).map(c => (
              <div key={c.id} className="flex items-center gap-2 p-2 rounded-lg" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}>
                {catEdit?.id === c.id ? (
                  <>
                    <input value={catEdit.name} onChange={e => setCatEdit(s => ({ ...s, name: e.target.value }))} className="flex-1 px-2 py-1 rounded text-xs" style={inp} autoFocus />
                    <button onClick={async () => { if (!catEdit.name.trim()) return; const r = await acc.updateExpenseCategory(c.id, catEdit.name, catEdit.oldName); if (r.ok) { toast.success('Kategori diperbarui'); setCatEdit(null); loadExpCats(); loadExpenses() } else toast.error(r.error) }} className="w-7 h-7 rounded inline-flex items-center justify-center" style={{ background: 'rgba(16,217,138,0.12)', color: '#10d98a' }}><Check size={12} /></button>
                    <button onClick={() => setCatEdit(null)} className="w-7 h-7 rounded inline-flex items-center justify-center" style={{ background: 'rgba(255,255,255,0.05)', color: 'var(--text-secondary)' }}><X size={12} /></button>
                  </>
                ) : (
                  <>
                    <span className="flex-1 text-xs font-medium truncate" style={{ color: 'var(--text-primary)' }}>{c.name}</span>
                    {canManageCat && <button onClick={() => setCatEdit({ id: c.id, name: c.name, oldName: c.name })} className="w-7 h-7 rounded inline-flex items-center justify-center" style={{ background: 'rgba(139,92,246,0.1)', color: 'var(--accent-light)' }}><Pencil size={12} /></button>}
                    {isOwner && <button onClick={async () => {
                      const n = await acc.countExpensesByCategory(c.name)
                      const ok = await confirm({ title: 'Hapus kategori ini?', message: n > 0 ? `Kategori "${c.name}" dipakai ${n} transaksi. Transaksi lama akan dialihkan ke "Pengeluaran Lainnya". Lanjut hapus?` : `Hapus kategori "${c.name}"?`, confirmLabel: 'Ya, Hapus' })
                      if (!ok) return
                      const r = await acc.deleteExpenseCategory(c.id, c.name, 'Pengeluaran Lainnya')
                      if (r.ok) { toast.success('Kategori dihapus'); loadExpCats(); loadExpenses() } else toast.error(r.error)
                    }} className="w-7 h-7 rounded inline-flex items-center justify-center" style={{ background: 'rgba(255,77,106,0.08)', color: 'var(--red)' }}><Trash2 size={12} /></button>}
                  </>
                )}
              </div>
            ))}
          </div>
          {!canManageCat && <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>Hanya owner/admin yang dapat menambah/edit kategori.</p>}
        </div>
      </Modal>

      {/* ── DETAIL SUMBER ANGKA (klik card ringkasan) ── */}
      <Modal open={!!detail} onClose={() => setDetail(null)} title={detail ? `Detail — ${detail.title}` : ''} size="lg">
        {detail && (
          detail.loading ? <div className="flex justify-center py-8"><Loader2 size={18} className="animate-spin" style={{ color: 'var(--accent-light)' }} /></div>
          : (detail.rows || []).length === 0 ? <p className="text-xs text-center py-6" style={{ color: 'var(--text-muted)' }}>Tidak ada data (data yang dihapus tidak ditampilkan).</p>
          : <div>
              <div className="overflow-x-auto -mx-1">
                <table className="w-full text-xs" style={{ borderCollapse: 'collapse', minWidth: 620 }}>
                  <thead><tr style={{ borderBottom: '1px solid var(--border)' }}>{['Tanggal', 'Sumber', 'Ref', 'Pihak', 'Metode', 'Status', 'Nominal', ''].map((h, i) => <th key={i} className={`px-2 py-2 ${h === 'Nominal' ? 'text-right' : 'text-left'}`} style={{ color: 'var(--text-muted)', fontFamily: 'Syne', fontSize: 10 }}>{h}</th>)}</tr></thead>
                  <tbody>
                    {detail.rows.map((row, i) => {
                      const editable = ['expense', 'purchase', 'supplier_payment', 'bank_payment', 'supplier_debt', 'bank_loan'].includes(row.kind)
                      const canEdit = ['expense', 'purchase', 'supplier_debt'].includes(row.kind)
                      return (
                        <tr key={row.kind + row.id + i} style={{ borderBottom: '1px solid var(--border)' }}>
                          <td className="px-2 py-2 whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>{dt(row.date)}</td>
                          <td className="px-2 py-2" style={{ color: 'var(--text-primary)' }}>{row.source}</td>
                          <td className="px-2 py-2 truncate" style={{ color: 'var(--text-muted)', maxWidth: 120 }}>{row.ref || '—'}</td>
                          <td className="px-2 py-2 truncate" style={{ color: 'var(--text-muted)', maxWidth: 120 }}>{row.party || '—'}</td>
                          <td className="px-2 py-2" style={{ color: 'var(--text-muted)', textTransform: 'uppercase', fontSize: 10 }}>{row.method || '—'}</td>
                          <td className="px-2 py-2" style={{ color: 'var(--text-muted)' }}>{row.status || '—'}</td>
                          <td className="px-2 py-2 text-right font-bold whitespace-nowrap" style={{ color: detail.color, fontVariantNumeric: 'tabular-nums' }}>{fmt(row.amount)}</td>
                          <td className="px-2 py-2 text-right whitespace-nowrap">
                            {canEdit && <button onClick={() => editDetailRow(row)} className="w-6 h-6 rounded inline-flex items-center justify-center mr-1" style={{ background: 'rgba(139,92,246,0.1)', color: 'var(--accent-light)' }} title="Edit"><Pencil size={11} /></button>}
                            {editable && <button onClick={() => deleteDetailRow(row)} className="w-6 h-6 rounded inline-flex items-center justify-center" style={{ background: 'rgba(255,77,106,0.08)', color: 'var(--red)' }} title="Hapus"><Trash2 size={11} /></button>}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                  <tfoot><tr style={{ borderTop: '2px solid var(--border)' }}><td colSpan={6} className="px-2 py-2.5 font-bold" style={{ color: 'var(--text-primary)', fontFamily: 'Syne' }}>TOTAL ({detail.rows.length} baris)</td><td className="px-2 py-2.5 text-right font-extrabold whitespace-nowrap" style={{ color: detail.color, fontFamily: 'Syne', fontVariantNumeric: 'tabular-nums' }}>{fmt(detail.total)}</td><td /></tr></tfoot>
                </table>
              </div>
              <p className="text-[11px] mt-3" style={{ color: 'var(--text-muted)' }}>Total di atas sama dengan angka di card. Data yang sudah dihapus/cancel tidak dihitung. Edit/Hapus langsung memperbarui dashboard.</p>
            </div>
        )}
      </Modal>
    </Page>
  )
}

function Page({ children, right }) {
  return (
    <div className="flex-1 overflow-y-auto overflow-x-hidden mesh-bg"
      style={{ paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }}>
      <div className="p-4 sm:p-6 max-w-7xl mx-auto"
        style={{ paddingLeft: 'max(1rem, env(safe-area-inset-left))', paddingRight: 'max(1rem, env(safe-area-inset-right))', paddingBottom: 'calc(2rem + env(safe-area-inset-bottom))' }}>
        <div className="flex items-start justify-between gap-3 mb-4 flex-wrap">
          <div><div className="text-sm" style={{ color: 'var(--text-secondary)' }}>Keuangan & Laporan</div><h2 className="text-xl sm:text-2xl font-bold mt-0.5" style={{ fontFamily: 'Syne', color: 'var(--text-primary)' }}>Accounting</h2></div>
          {right}
        </div>
        {children}
      </div>
    </div>
  )
}
