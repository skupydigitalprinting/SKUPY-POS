import React, { useEffect, useMemo, useState } from 'react'
import {
  Loader2, TrendingUp, TrendingDown, Wallet, Landmark, Scale, Receipt,
  ShoppingCart, BookOpen, Plus, Trash2, AlertTriangle, RefreshCw, Truck,
  FileSpreadsheet, Users as UsersIcon, Building2, Pencil, Check, X, ChevronDown, Search, Home,
  HandCoins, CreditCard, MoreHorizontal, Settings, Database, Upload, Download,
} from 'lucide-react'
import { formatRupiah, formatCurrency, parseCurrency, formatDateTimeWIB, calculateAssetBookValue, assetDepreciationSchedule, assetAgeYears, rentAmortization, rentSchedule, rentDurationMonths, rentBebanBulanIni, netProfit, detectPreset, QUICK_PRESETS } from '../utils/helpers'
import { Button, RangeChips } from '../components/ui'
import Modal from '../components/Modal'
import ArusKasDetail from '../components/ArusKasDetail'
import SaldoDetail from '../components/SaldoDetail'
import { useToast } from '../components/Toast'
import { useConfirm } from '../components/Confirm'
import { useInvoicePreview } from '../components/InvoicePreview'
import { useAccounting } from '../hooks/useAccounting'

const TABS = [
  { id: 'ringkasan', label: 'Ringkasan', icon: Scale },
  { id: 'jurnal', label: 'Jurnal', icon: BookOpen },
  { id: 'pengeluaran', label: 'Pengeluaran', icon: Receipt },
  { id: 'supplier', label: 'Supplier', icon: UsersIcon },
  { id: 'hsupplier', label: 'Hutang Supplier', icon: Truck },
  { id: 'hbank', label: 'Hutang Bank', icon: Building2 },
  { id: 'kasbon', label: 'Kasbon Karyawan', icon: HandCoins },
  { id: 'aset', label: 'Aset', icon: Landmark },
  { id: 'sewa', label: 'Sewa Toko', icon: Home },
  { id: 'migrasi', label: 'Migrasi Data', icon: Database },
  { id: 'pengaturan', label: 'Pengaturan Accounting', icon: Settings },
]
const TAB_META = Object.fromEntries(TABS.map(t => [t.id, t]))
// ── Struktur navigasi ringkas (desktop muat 1 baris) ──
// Tab utama langsung + grup dropdown "Hutang" & "More".
const NAV_HUTANG = ['hsupplier', 'hbank', 'kasbon']
const NAV_MORE = ['supplier', 'sewa', 'migrasi', 'pengaturan']

// Tombol tab compact (padding/font kecil, icon tetap, aktif = ungu).
function TabButton({ id, tab, setTab }) {
  const m = TAB_META[id]; if (!m) return null
  const Icon = m.icon; const active = tab === id
  return (
    <button onClick={() => setTab(id)} className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold transition-all flex-shrink-0 whitespace-nowrap"
      style={{ background: active ? 'linear-gradient(135deg, var(--accent), #6366f1)' : 'var(--bg-card)', color: active ? '#fff' : 'var(--text-secondary)', border: `1px solid ${active ? 'transparent' : 'var(--border)'}`, fontFamily: 'Syne' }}>
      {Icon && <Icon size={12} />} {m.label}
    </button>
  )
}

// Dropdown grup tab (Hutang / More). Aktif jika salah satu anaknya terpilih.
function TabDropdown({ label, icon: Icon, items, tab, setTab }) {
  const [open, setOpen] = useState(false)
  const active = items.includes(tab)
  const shown = active ? (TAB_META[tab]?.label || label) : label
  return (
    <div className="relative flex-shrink-0">
      <button onClick={() => setOpen(o => !o)} className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold transition-all whitespace-nowrap"
        style={{ background: active ? 'linear-gradient(135deg, var(--accent), #6366f1)' : 'var(--bg-card)', color: active ? '#fff' : 'var(--text-secondary)', border: `1px solid ${active ? 'transparent' : 'var(--border)'}`, fontFamily: 'Syne' }}>
        {Icon && <Icon size={12} />} {shown} <ChevronDown size={12} style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0" style={{ zIndex: 40 }} onClick={() => setOpen(false)} />
          <div className="absolute left-0 mt-1 rounded-xl py-1" style={{ zIndex: 50, minWidth: 200, background: 'var(--bg-elevated)', border: '1px solid var(--border-strong)', boxShadow: '0 14px 36px rgba(0,0,0,0.55)' }}>
            {items.map(id => { const m = TAB_META[id]; if (!m) return null; const A = m.icon; const sel = tab === id; return (
              <button key={id} onClick={() => { setTab(id); setOpen(false) }} className="w-full text-left px-3 py-2 text-xs font-semibold flex items-center gap-2"
                style={{ color: sel ? 'var(--accent-light)' : 'var(--text-primary)', background: sel ? 'rgba(139,92,246,0.12)' : 'transparent' }}>
                {A && <A size={13} />} {m.label}
              </button>
            )})}
          </div>
        </>
      )}
    </div>
  )
}
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
// Rentang "semua waktu" untuk card All Time (tidak ikut filter tanggal).
const ALL_TIME_FROM = '2000-01-01'
const todayYMD = () => new Date().toLocaleDateString('en-CA') // YYYY-MM-DD (lokal)
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

export default function Accounting({ admins = [], currentUser, setActivePage, initialTab, initialTabSignal } = {}) {
  const toast = useToast()
  const confirm = useConfirm()
  const acc = useAccounting()
  const isOwner = currentUser?.role === 'owner'
  const [tab, setTab] = useState('ringkasan')
  // Deep-link: pindah tab saat diminta dari luar (mis. Credibook → Pengeluaran).
  useEffect(() => {
    if (initialTab && TABS.some(t => t.id === initialTab)) setTab(initialTab)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialTabSignal])
  const [detail, setDetail] = useState(null) // { kind, title, color, rows, total, loading, from, to, allTime }
  const [infoModal, setInfoModal] = useState(null) // { title, rows:[[label,val,neg?]], total:[label,val], note }
  const [arusKasOpen, setArusKasOpen] = useState(false)
  const [saldoDetailOpen, setSaldoDetailOpen] = useState(false)
  const invoicePreview = useInvoicePreview()
  const [detailSrc, setDetailSrc] = useState('all') // filter sumber pada modal detail
  const [allTime, setAllTime] = useState(null) // { omset, pengeluaran } — tidak ikut filter tanggal
  // Total pengeluaran (non-sewa) dari getOutflowTransactions — SAMA dengan total
  // di modal Rincian, supaya kartu Uang Keluar = jumlah baris rincian.
  const [pengOut, setPengOut] = useState(null)   // periode aktif
  const [pengOutAll, setPengOutAll] = useState(null) // semua waktu
  const [from, setFrom] = useState(acc.monthStartISO())
  const [to, setTo] = useState(acc.todayISO())
  const [loading, setLoading] = useState(false)
  const [setupNeeded, setSetupNeeded] = useState(false)
  const [setupError, setSetupError] = useState('')
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
  // ── KASBON KARYAWAN ──
  const blankKasbon = { employeeName: '', amount: '', date: acc.todayISO(), dueDate: '', method: 'cash', note: '' }
  const [advances, setAdvances] = useState([]); const [kasbonForm, setKasbonForm] = useState(blankKasbon); const [kasbonErr, setKasbonErr] = useState({})
  const [editAdv, setEditAdv] = useState(null)
  const [advPay, setAdvPay] = useState({ amount: '', method: 'cash', date: acc.todayISO(), note: '' })
  const [kasbonFilter, setKasbonFilter] = useState('all') // all | aktif | lunas | tempo
  // Master karyawan + modal tambah/edit karyawan + detail grup + bayar FIFO grup
  const [employees, setEmployees] = useState([])
  const blankEmp = { id: null, name: '', phone: '', position: '', notes: '' }
  const [empModal, setEmpModal] = useState(null) // { id?, name, phone, position, notes }
  const [detailEmp, setDetailEmp] = useState(null) // group object yang sedang dibuka
  const [detailPayRows, setDetailPayRows] = useState({}) // { [advanceId]: payments[] }
  const [groupPay, setGroupPay] = useState(null) // { key, name, sisa, amount, method, date, note }
  const [advPayInModal, setAdvPayInModal] = useState(null) // id kasbon yang sedang dibayar di detail
  const [editPay, setEditPay] = useState(null) // pembayaran kasbon yang sedang diedit { id, amount, method, date, note }
  // ── MIGRASI DATA AWAL (pemasukan/pengeluaran lama) ──
  const blankMigIn = { type: 'old_income', date: acc.todayISO(), name: '', customer: '', amount: '', method: 'cash', note: '' }
  const blankMigOut = { type: 'old_expense', date: acc.todayISO(), name: '', amount: '', method: 'cash', note: '' }
  const [migRows, setMigRows] = useState([])
  const [migIn, setMigIn] = useState(blankMigIn); const [migInErr, setMigInErr] = useState({})
  const [migOut, setMigOut] = useState(blankMigOut); const [migOutErr, setMigOutErr] = useState({})
  const [editMig, setEditMig] = useState(null)
  const [migNeedsMigration, setMigNeedsMigration] = useState(false); const [bootstrapping, setBootstrapping] = useState(false)
  const [migImport, setMigImport] = useState(null) // { rows:[{type,date,name,customer,amount,method,note,_ok}], fileName }
  const [importing, setImporting] = useState(false)
  // Jenis form migrasi yang aktif + form Piutang Customer Lama & Kasbon Karyawan Lama
  const [migKind, setMigKind] = useState('income') // income | expense | receivable | kasbon
  const blankRecv = { date: acc.todayISO(), customerName: '', amount: '', dueDate: '', note: '' }
  const blankOldKas = { date: acc.todayISO(), employeeName: '', amount: '', dueDate: '', method: 'cash', note: '' }
  const [recvForm, setRecvForm] = useState(blankRecv); const [recvErr, setRecvErr] = useState({})
  const [oldKasForm, setOldKasForm] = useState(blankOldKas); const [oldKasErr, setOldKasErr] = useState({})
  // Modal & Saldo Awal (ekuitas)
  const blankCap = { type: 'modal', date: acc.todayISO(), amount: '', method: 'transfer', name: '', note: '' }
  const [capForm, setCapForm] = useState(blankCap); const [capErr, setCapErr] = useState({}); const [capList, setCapList] = useState([])
  const loadCap = async () => { const r = await acc.listCapitalEntries(); if (r.ok) setCapList(r.data) }
  const [openingRecv, setOpeningRecv] = useState([]); const [openingKas, setOpeningKas] = useState([])
  const [editRecv, setEditRecv] = useState(null); const [editOldKas, setEditOldKas] = useState(null)

  // forms (default metode TRANSFER)
  const [expForm, setExpForm] = useState({ date: acc.todayISO(), category: 'Pembelian Bahan', amount: '', method: 'transfer', note: '' })
  const [purForm, setPurForm] = useState({ date: acc.todayISO(), supplier: '', item: '', qty: '', harga: '', paid: '', method: 'transfer', dueDate: '', dpMethod: 'transfer', note: '' })
  const [supForm, setSupForm] = useState({ id: null, name: '', phone: '', address: '', note: '' })
  const [sdForm, setSdForm] = useState({ supplier: '', item: '', total: '', dueDate: '' })
  const [payId, setPayId] = useState(null); const [payVal, setPayVal] = useState(''); const [payMethod, setPayMethod] = useState('transfer'); const [payNote, setPayNote] = useState('')
  // Hutang Supplier dikelompokkan per supplier
  const [supDetailName, setSupDetailName] = useState(null) // nama supplier (buka modal detail)
  const [supHist, setSupHist] = useState([]); const [supHistLoading, setSupHistLoading] = useState(false)
  const [expandNote, setExpandNote] = useState(null) // id nota yang riwayatnya dibuka
  const [fifoSup, setFifoSup] = useState(null) // nama supplier (buka modal Bayar FIFO)
  const [fifoForm, setFifoForm] = useState({ date: '', amount: '', method: 'transfer', note: '' })
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
  // Beban sewa SEMUA WAKTU (amortisasi) — untuk kartu Pengeluaran All Time.
  const rentBebanAllTimeAcc = useMemo(() => {
    const now = new Date()
    let sum = 0
    ;(rents || []).filter(r => r.status !== 'cancelled').forEach(r => { rentSchedule(r, now).forEach(s => { if (s.status !== 'pending') sum += s.amount }) })
    return sum
  }, [rents])
  // Sisipkan baris BEBAN SEWA (amortisasi) ke rincian Uang Keluar agar total
  // detail = angka kartu. Pembayaran sewa penuh TIDAK dihitung sbg uang keluar.
  const injectRentAmort = (kind, isAll, rows, total) => {
    if (kind !== 'uang_keluar') return { rows, total }
    const beban = Math.round(isAll ? rentBebanAllTimeAcc : rentAgg.bebanPeriod)
    if (beban <= 0) return { rows, total }
    const rr = [...(rows || []), { id: 'rent-amort', kind: 'rent_amort', date: new Date().toISOString(), source: 'Sewa', category: 'Beban Sewa (amortisasi)', party: '', ref: '', method: '', amount: beban, status: 'amortisasi', note: 'Beban sewa berjalan (bukan pembayaran penuh)' }]
    return { rows: rr, total: (total || 0) + beban }
  }
  // edit hutang supplier + riwayat
  const [editDebt, setEditDebt] = useState(null) // supplier_debt being edited
  const [editExp, setEditExp] = useState(null) // expense being edited
  const [editPur, setEditPur] = useState(null) // purchase being edited
  const [history, setHistory] = useState(null) // { kind:'supplier'|'bank', title, rows }
  const [hLoading, setHLoading] = useState(false)
  const [hEdit, setHEdit] = useState(null) // payment being edited

  const loadDashboard = async () => {
    const res = await acc.getDashboard(from, to)
    if (!res.ok) { if (/function|relation|does not exist|schema cache|acc_dashboard/i.test(res.error || '')) { setSetupNeeded(true); setSetupError(res.error || '') } else toast.error(res.error || 'Gagal') }
    else {
      setD(res.data); setSetupNeeded(false); setSetupError('')
      const chk = await acc.getPiutangAktif()
      if (chk.ok && Math.abs((chk.value || 0) - Math.round(res.data.piutang_aktif || 0)) > 1)
        console.warn('[Accounting] Piutang tidak sinkron — RPC:', res.data.piutang_aktif, 'debts:', chk.value)
      // Total pengeluaran (non-sewa) dari daftar rincian → kartu Uang Keluar =
      // jumlah baris di modal Rincian. Fallback ke pengeluaran_total bila gagal.
      const out = await acc.getOutflowTransactions(from, to)
      setPengOut(out.ok ? out.total : Math.round(res.data.pengeluaran_total || 0))
      // Segarkan SEMUA komponen Total Aset (Aset Tetap & Sewa Dibayar Dimuka)
      // supaya Total Aset & Kekayaan Bersih ikut berubah saat ada hapus/edit.
      loadAssets(); loadRents()
      loadAllTime() // segarkan card All Time (realtime ikut tiap loadDashboard)
    }
  }
  // Card "All Time" — TIDAK ikut filter tanggal. Omset = penjualan semua waktu.
  // Pengeluaran = pengeluaran_total semua waktu (TANPA sewa penuh). Beban sewa
  // amortisasi all-time ditambahkan saat render (rentBebanAllTimeAcc).
  const loadAllTime = async () => {
    const today = todayYMD()
    const dRes = await acc.getDashboard(ALL_TIME_FROM, today)
    if (dRes.ok) setAllTime({
      omset: Math.round(dRes.data.penjualan || 0),
      pengeluaran: Math.round(dRes.data.pengeluaran_total || 0),
    })
    const out = await acc.getOutflowTransactions(ALL_TIME_FROM, today)
    if (out.ok) setPengOutAll(out.total); else if (dRes.ok) setPengOutAll(Math.round(dRes.data.pengeluaran_total || 0))
  }
  const loadEntries = async (page = 0) => { const r = await acc.listEntries({ page, from, to }); if (r.ok) { setEntries(r.data); setEntCount(r.count); setEntPage(page) } else if (/relation|does not exist/i.test(r.error || '')) setSetupNeeded(true) }
  const loadExpenses = async () => { const r = await acc.listExpensesByRange({ from, to }); if (r.ok) setExpenses(r.data) }
  const loadExpCats = async () => { const r = await acc.listExpenseCategories(); if (r.ok) setExpCats(r.data) }
  const loadPurchases = async () => { const r = await acc.listPurchases({}); if (r.ok) setPurchases(r.data) }
  const loadSuppliers = async () => { const r = await acc.listSuppliers(supSearch); if (r.ok) setSuppliers(r.data) }
  const loadSupDebts = async () => { const r = await acc.listSupplierDebts(); if (r.ok) setSupDebts(r.data) }
  const loadBankLoans = async () => { const r = await acc.listBankLoans(); if (r.ok) setBankLoans(r.data) }
  const loadAssets = async () => { const r = await acc.listAssets(); if (r.ok) setAssets(r.data) }
  const loadAssetCats = async () => { const r = await acc.listAssetCategories(); if (r.ok) setAssetCats(r.data) }
  const loadRents = async () => { const r = await acc.listRents(); if (r.ok) setRents(r.data) }
  const loadRecap = async () => { const r = await acc.getRecapAdmin(from, to); if (r.ok) setRecap(r.data) }
  const [kasbonNeedsMigration, setKasbonNeedsMigration] = useState(false)
  const loadEmployees = async () => { const r = await acc.listEmployees(); if (r.ok) setEmployees(r.data) }
  const loadMig = async () => {
    const r = await acc.listMigrationDetails()
    if (r.ok) { setMigRows(r.data); setMigNeedsMigration(false) }
    else if (/relation|does not exist|schema cache/i.test(r.error || '')) { setMigRows([]); setMigNeedsMigration(true) }
    else toast.error(r.error || 'Gagal memuat data migrasi')
    // Saldo awal: piutang customer lama + kasbon karyawan lama (abaikan error diam2)
    const rr = await acc.listOpeningReceivables(); setOpeningRecv(rr.ok ? rr.data : [])
    const rk = await acc.listOpeningKasbon(); setOpeningKas(rk.ok ? rk.data : [])
  }
  const loadAdvances = async () => {
    const r = await acc.listEmployeeAdvances()
    if (r.ok) { setAdvances(r.data); setKasbonNeedsMigration(false) }
    // Tabel kasbon belum dimigrasi ≠ modul Accounting mati. Tampilkan
    // notice khusus di tab Kasbon saja, jangan set setupNeeded global.
    else if (/relation|does not exist|schema cache/i.test(r.error || '')) { setAdvances([]); setKasbonNeedsMigration(true) }
    else toast.error(r.error || 'Gagal memuat kasbon')
  }
  // Refresh data realtime + bangun ulang grup karyawan yang sedang dibuka di
  // modal detail (dipakai setelah bayar / edit / hapus kasbon / hapus pembayaran).
  const groupKeyOf = (a) => a.employee_id || ('name:' + (a.employee_name || '').trim().toLowerCase())
  const refreshDetailEmp = async (key) => {
    const r = await acc.listEmployeeAdvances()
    const list = r.ok ? r.data : []
    setAdvances(list)
    loadDashboard()
    if (!key) return
    const items = list.filter(a => groupKeyOf(a) === key)
      .sort((x, y) => (String(x.advance_date).localeCompare(String(y.advance_date))) || (String(x.created_at || '').localeCompare(String(y.created_at || ''))))
    if (items.length === 0) { setDetailEmp(null); setDetailPayRows({}); return }
    const totalAmount = items.reduce((s, x) => s + Math.round(x.amount || 0), 0)
    const totalPaid = items.reduce((s, x) => s + Math.round(x.paid || 0), 0)
    const totalSisa = Math.max(0, totalAmount - totalPaid)
    const todayLocal = new Date().toLocaleDateString('en-CA')
    const overdue = items.some(x => { const rem = Math.max(0, Math.round(x.amount || 0) - Math.round(x.paid || 0)); return x.due_date && String(x.due_date).slice(0, 10) < todayLocal && rem > 0 })
    setDetailEmp({ key, employeeId: items[0].employee_id || null, name: items[0].employee_name || '—', items, totalAmount, totalPaid, totalSisa, overdue, status: totalSisa <= 0 ? 'Lunas' : overdue ? 'Lewat Tempo' : 'Aktif' })
    const map = {}
    for (const it of items) { const pr = await acc.listAdvancePayments(it.id); map[it.id] = pr.ok ? pr.data : [] }
    setDetailPayRows(map)
  }

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
      else if (tab === 'kasbon') { await loadAdvances(); await loadEmployees() }
      else if (tab === 'aset') { await loadAssets(); await loadAssetCats() }
      else if (tab === 'sewa') await loadRents()
      else if (tab === 'migrasi') { await loadDashboard(); await loadMig(); await loadExpCats(); await loadCap() }
      else if (tab === 'pengaturan') await loadExpCats()
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
  // Laba = Omzet − Total Pengeluaran − Beban Sewa berjalan (rumus resmi bersama netProfit)
  // Basis pengeluaran (non-sewa) = total daftar rincian bila tersedia, jika belum
  // termuat pakai pengeluaran_total RPC. Dipakai agar kartu = jumlah baris rincian.
  const ukBasis = useMemo(() => pengOut != null ? pengOut : (d ? Math.round(d.pengeluaran_total || 0) : 0), [pengOut, d])
  const laba = useMemo(() => d ? netProfit(d.penjualan, ukBasis, rentAgg.bebanPeriod) : 0, [d, rentAgg, ukBasis])
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
            { Pos: 'total_aset', Nilai: asetTotal },
            { Pos: 'kekayaan_bersih', Nilai: kekayaanBersih },
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
        const r = await acc.addSupplierDebt({ supplier: purForm.supplier, item: purForm.item, total, dueDate: purForm.dueDate, method: purForm.dpMethod, note: purForm.note, date: purForm.date })
        if (!r.ok) { toast.error(r.error); setSaving(false); return }
        if (dp > 0 && r.id) { const rp = await acc.paySupplierDebt(r.id, dp, purForm.dpMethod, currentUser?.id, 'DP pembelian', purForm.date); if (!rp.ok) toast.error(rp.error) }
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

  // ── HUTANG SUPPLIER: kelompokkan per supplier ──
  const todayLocalStr = new Date().toLocaleDateString('en-CA')
  const supGroups = useMemo(() => {
    const g = {}
    ;(supDebts || []).forEach(x => { const k = x.supplier || '—'; (g[k] || (g[k] = [])).push(x) })
    return Object.entries(g).map(([supplier, notes]) => {
      const total = notes.reduce((s, n) => s + Math.round(n.total || 0), 0)
      const paid = notes.reduce((s, n) => s + Math.round(n.paid || 0), 0)
      const remaining = Math.max(0, total - paid)
      const open = notes.filter(n => Math.max(0, Math.round(n.total || 0) - Math.round(n.paid || 0)) > 0)
      const dues = open.map(n => n.due_date).filter(Boolean).map(d => String(d).slice(0, 10)).sort()
      const nearest = dues[0] || null
      const overdue = open.some(n => n.due_date && String(n.due_date).slice(0, 10) < todayLocalStr)
      const status = remaining <= 0 ? 'Lunas' : overdue ? 'Lewat Tempo' : 'Aktif'
      return { supplier, notes, total, paid, remaining, count: notes.length, nearest, overdue, status }
    }).sort((a, b) => b.remaining - a.remaining)
  }, [supDebts, todayLocalStr])
  // Notes (nota) untuk supplier yang sedang dibuka, urut FIFO (tempo lalu created_at).
  const supDetail = useMemo(() => {
    if (!supDetailName) return null
    const g = supGroups.find(x => x.supplier === supDetailName)
    if (!g) return null
    const notes = [...g.notes].sort((a, b) => {
      const ad = a.due_date ? String(a.due_date).slice(0, 10) : '9999-12-31'
      const bd = b.due_date ? String(b.due_date).slice(0, 10) : '9999-12-31'
      if (ad !== bd) return ad < bd ? -1 : 1
      return new Date(a.created_at) - new Date(b.created_at)
    })
    return { ...g, notes }
  }, [supDetailName, supGroups])
  const loadSupHist = async (name) => {
    setSupHistLoading(true)
    const r = await acc.listSupplierPaymentsBySupplier(name)
    setSupHist(r.ok ? r.data : []); setSupHistLoading(false)
  }
  const openSupDetail = (name) => { setSupDetailName(name); setSupHist([]); loadSupHist(name) }
  const refreshSupAll = async (name) => { await loadSupDebts(); await loadDashboard(); if (name) loadSupHist(name) }
  // Preview distribusi FIFO untuk modal Bayar Gabungan
  const fifoPreview = useMemo(() => {
    if (!fifoSup) return { rows: [], applied: 0, leftover: 0 }
    const g = supGroups.find(x => x.supplier === fifoSup)
    if (!g) return { rows: [], applied: 0, leftover: 0 }
    const active = g.notes
      .map(n => ({ ...n, rem: Math.max(0, Math.round(n.total || 0) - Math.round(n.paid || 0)) }))
      .filter(n => n.rem > 0)
      .sort((a, b) => {
        const ad = a.due_date ? String(a.due_date).slice(0, 10) : '9999-12-31'
        const bd = b.due_date ? String(b.due_date).slice(0, 10) : '9999-12-31'
        if (ad !== bd) return ad < bd ? -1 : 1
        return new Date(a.created_at) - new Date(b.created_at)
      })
    let left = parseCurrency(fifoForm.amount) || 0
    const rows = active.map(n => {
      const pay = Math.max(0, Math.min(left, n.rem))
      left -= pay
      return { ...n, pay, remAfter: n.rem - pay }
    })
    const amt = parseCurrency(fifoForm.amount) || 0
    return { rows, applied: amt - left, leftover: left }
  }, [fifoSup, supGroups, fifoForm.amount])
  const openFifo = (name) => { setFifoSup(name); setFifoForm({ date: new Date().toLocaleDateString('en-CA'), amount: '', method: 'transfer', note: '' }) }
  const submitFifo = async () => {
    if (saving) return
    const amt = parseCurrency(fifoForm.amount)
    if (!(amt > 0)) return toast.error('Nominal harus > 0')
    setSaving(true)
    const r = await acc.paySupplierFIFO(fifoSup, amt, fifoForm.method, currentUser?.id, fifoForm.note, fifoForm.date)
    setSaving(false)
    if (r.ok) {
      toast.success(`Pembayaran ${fmt(r.applied)} dialokasikan ke ${r.count} nota (FIFO)${r.leftover > 0 ? ` · sisa ${fmt(r.leftover)} tak terpakai` : ''}`)
      const name = fifoSup
      setFifoSup(null)
      refreshSupAll(name)
    } else toast.error(r.error || 'Gagal')
  }
  // Hapus 1 batch pembayaran FIFO (semua alokasi dibatalkan)
  const deleteFifoGroup = async (group, name) => {
    if (!(await confirm({ title: 'Yakin ingin menghapus pembayaran ini? Semua alokasi ke tiap nota akan dibatalkan.' }))) return
    const r = await acc.deleteSupplierFIFOGroup(group)
    if (r.ok) { toast.success('Pembayaran dibatalkan'); refreshSupAll(name) } else toast.error(r.error || 'Gagal')
  }
  const deleteSupPayOne = async (id, name) => {
    if (!(await confirm({ title: 'Yakin ingin menghapus data ini?' }))) return
    const r = await acc.deleteSupplierPayment(id)
    if (r.ok) { toast.success('Dihapus'); refreshSupAll(name) } else toast.error(r.error || 'Gagal')
  }

  // ── Detail sumber angka (audit, klik card) ──
  const openDetail = async (kind, title, color, range) => {
    const f = range?.from || from, t = range?.to || to
    setDetailSrc('all')
    setDetail({ kind, title, color, from: f, to: t, allTime: !!range, rows: [], total: 0, loading: true })
    const r = await acc.getCardDetail(kind, f, t)
    // Sinkronkan kartu Uang Keluar ke total rincian (non-sewa) supaya selalu sama.
    if (kind === 'uang_keluar' && r.ok) { if (range) setPengOutAll(r.total); else setPengOut(r.total) }
    const inj = injectRentAmort(kind, !!range, r.ok ? r.rows : [], r.ok ? r.total : 0)
    setDetail(d => d && d.kind === kind ? { ...d, rows: inj.rows, total: inj.total, loading: false } : d)
  }
  const reloadDetail = async () => {
    if (!detail) return
    const r = await acc.getCardDetail(detail.kind, detail.from || from, detail.to || to)
    if (detail.kind === 'uang_keluar' && r.ok) { if (detail.allTime) setPengOutAll(r.total); else setPengOut(r.total) }
    const inj = injectRentAmort(detail.kind, !!detail.allTime, r.ok ? r.rows : [], r.ok ? r.total : 0)
    setDetail(d => d ? { ...d, rows: inj.rows, total: inj.total } : d)
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
    else if (row.kind === 'kasbon') r = await acc.deleteEmployeeAdvance(row.id)
    else if (row.kind === 'rent') r = await acc.deleteRent(row.id)
    else if (row.kind === 'migration') r = await acc.deleteMigrationDetail(row.id)
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
  // Total Aset = Saldo (Kas & Bank) + Piutang Usaha + Piutang Karyawan
  //              + Aset Tetap + Sewa Dibayar Dimuka. Satu sumber kebenaran
  //              dipakai di Card, Neraca, dan Export agar tidak divergen.
  // Persediaan SENGAJA tidak ikut dijumlahkan (disembunyikan dari UI/Neraca);
  // data persediaan tetap ada di DB. PENTING: dideklarasikan SETELAH asetTetap & rentAgg (TDZ).
  const asetTotal = useMemo(() => d
    ? Math.round((d.saldo_kas || 0) + (d.saldo_rekening || 0) + (d.piutang_aktif || 0) + (d.piutang_karyawan || 0) + asetTetap + rentAgg.dibayarDimuka)
    : 0, [d, asetTetap, rentAgg])
  const kekayaanBersih = useMemo(() => asetTotal - totalHutang, [asetTotal, totalHutang])
  const saldoKasBank = useMemo(() => Math.round((d?.saldo_kas || 0) + (d?.saldo_rekening || 0)), [d])
  // Neraca: Aset HARUS = Kewajiban + Ekuitas. selisih>0 → tidak seimbang.
  const neracaBalance = useMemo(() => {
    const kewajibanEkuitas = totalHutang + kekayaanBersih
    const selisih = Math.round(asetTotal - kewajibanEkuitas)
    return { asetTotal, kewajibanEkuitas, selisih, balanced: Math.abs(selisih) <= 1 }
  }, [asetTotal, totalHutang, kekayaanBersih])

  // AUDIT keuangan otomatis di console saat data dashboard siap (owner saja, 1x).
  const auditedRef = React.useRef(false)
  useEffect(() => {
    if (!d || !isOwner || auditedRef.current) return
    auditedRef.current = true
    acc.auditAccounting?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d, isOwner])

  // Rincian breakdown untuk card Saldo / Total Aset / Kekayaan Bersih (klik → modal).
  const openInfo = (kind) => {
    if (!d) return
    if (kind === 'saldo') {
      setInfoModal({
        title: 'Rincian Saldo (Kas & Bank)',
        rows: [
          ['Saldo Awal (Modal + Pinjaman ke Kas)', d.saldo_awal || 0],
          ['Uang Masuk — Cash', d.masuk_cash || 0],
          ['Uang Masuk — Transfer', d.masuk_transfer || 0],
          ['Uang Masuk — QRIS', d.masuk_qris || 0],
          ['Uang Keluar — Cash', d.keluar_cash || 0, true],
          ['Uang Keluar — Transfer', d.keluar_transfer || 0, true],
          ['Uang Keluar — QRIS', d.keluar_qris || 0, true],
        ],
        total: ['Saldo Akhir (Kas & Bank)', saldoKasBank],
        note: 'Saldo bisa minus bila uang keluar lebih besar dari saldo awal + uang masuk. Sewa dibayar dimuka mengurangi saldo penuh saat dibayar; amortisasi bulanan TIDAK mengurangi saldo lagi.',
      })
    } else if (kind === 'totalaset') {
      setInfoModal({
        title: 'Rincian Total Aset',
        rows: [
          ['Saldo (Kas & Bank)', saldoKasBank],
          ['Piutang Usaha', d.piutang_aktif || 0],
          ['Piutang Karyawan', d.piutang_karyawan || 0],
          ['Aset Tetap (Nilai Buku)', asetTetap],
          ['Sewa Dibayar Dimuka', rentAgg.dibayarDimuka],
        ],
        total: ['Total Aset', asetTotal],
        note: 'Posisi s/d tanggal akhir filter.',
      })
    } else if (kind === 'kekayaan') {
      setInfoModal({
        title: 'Rincian Kekayaan Bersih',
        rows: [
          ['Total Aset', asetTotal],
          ['Hutang Supplier', d.hutang_supplier || 0, true],
          ['Hutang Bank', d.hutang_bank || 0, true],
        ],
        total: ['Kekayaan Bersih', kekayaanBersih],
        note: 'Kekayaan Bersih = Total Aset − Total Hutang (bukan dari laba/omset).',
      })
    }
  }

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
          <p className="text-xs leading-relaxed" style={{ color: 'var(--text-secondary)' }}>Buka <b>Supabase → SQL Editor</b>, lalu jalankan <b>satu file</b> <code>supabase/SUPABASE_SETUP_ALL.sql</code> (semua migrasi sudah digabung &amp; aman dijalankan berulang). Setelah selesai, kembali ke sini dan klik <b>Coba lagi</b>.</p>
          <p className="text-[11px] leading-relaxed mt-2" style={{ color: 'var(--text-tertiary, var(--text-secondary))' }}>Alternatif manual: jalankan semua file di <code>supabase/migrations</code> urut nama — …→ employee_cash_advances → employees_master → <b>migration_details → migration_opening_balances</b> → product_categories → product_categories_extend → customers_created_by → product_categories_realtime → customer_reassign → customer_owner_pic → products_is_favorite. <b>Jangan lewati migration_opening_balances</b> — di situ fungsi <code>acc_dashboard</code> versi final dibuat.</p>
          {setupError ? (
            <p className="text-[11px] leading-relaxed mt-2 p-2 rounded-lg" style={{ color: '#fca5a5', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', fontFamily: 'monospace', wordBreak: 'break-word' }}>Pesan error dari database: {setupError}</p>
          ) : null}
          <Button variant="secondary" className="mt-3" onClick={() => { setSetupNeeded(false); setSetupError(''); loadDashboard() }}><RefreshCw size={13} /> Coba lagi</Button>
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
      {/* Filter waktu cepat — berlaku untuk semua tab & modal detail (ikut from/to) */}
      <div className="mb-3"><RangeChips active={detectPreset(from, to)} onPick={(_k, r) => { setFrom(r.from); setTo(r.to) }} /></div>
      {/* Desktop: tab utama + grup dropdown (Hutang / More), muat 1 baris, tanpa scroll */}
      <div className="hidden md:flex items-center gap-1 mb-4 flex-wrap">
        <TabButton id="ringkasan" tab={tab} setTab={setTab} />
        <TabButton id="jurnal" tab={tab} setTab={setTab} />
        <TabButton id="pengeluaran" tab={tab} setTab={setTab} />
        <TabDropdown label="Hutang" icon={CreditCard} items={NAV_HUTANG} tab={tab} setTab={setTab} />
        <TabButton id="aset" tab={tab} setTab={setTab} />
        <TabDropdown label="More" icon={MoreHorizontal} items={NAV_MORE} tab={tab} setTab={setTab} />
      </div>

      {/* iPhone / mobile: dropdown select, tidak perlu scroll panjang */}
      <div className="md:hidden mb-4">
        <label className="block text-[10px] font-bold uppercase tracking-wider mb-1.5" style={{ color: 'var(--text-muted)', fontFamily: 'Syne' }}>Pilih Menu Accounting</label>
        <div className="relative">
          <select value={tab} onChange={e => setTab(e.target.value)}
            className="w-full appearance-none px-3.5 py-3 rounded-xl text-sm font-bold"
            style={{ background: 'var(--bg-card)', color: 'var(--text-primary)', border: '1.5px solid var(--accent)', fontFamily: 'Syne', boxShadow: '0 0 0 3px rgba(139,92,246,0.12)' }}>
            <optgroup label="Utama">
              {['ringkasan', 'jurnal', 'pengeluaran', 'aset'].map(id => <option key={id} value={id}>{TAB_META[id].label}</option>)}
            </optgroup>
            <optgroup label="Hutang">
              {NAV_HUTANG.map(id => <option key={id} value={id}>{TAB_META[id].label}</option>)}
            </optgroup>
            <optgroup label="Lainnya">
              {NAV_MORE.map(id => <option key={id} value={id}>{TAB_META[id].label}</option>)}
            </optgroup>
          </select>
          <ChevronDown size={18} style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--accent-light)', pointerEvents: 'none' }} />
        </div>
      </div>

      {loading && <div className="flex items-center justify-center py-8"><Loader2 size={20} className="animate-spin" style={{ color: 'var(--accent-light)' }} /></div>}

      {/* ── MIGRASI DATA AWAL (pemasukan/pengeluaran lama) ── */}
      {tab === 'migrasi' && !loading && (() => {
        const submitMig = async (which) => {
          const f = which === 'in' ? migIn : migOut
          const setErr = which === 'in' ? setMigInErr : setMigOutErr
          const e = {}
          if (!f.date) e.date = 'Tanggal wajib diisi'
          if (!f.name.trim()) e.name = which === 'in' ? 'Nama transaksi wajib diisi' : 'Kategori wajib diisi'
          if (!(parseCurrency(f.amount) > 0)) e.amount = 'Nominal harus lebih dari 0'
          setErr(e); if (Object.keys(e).length) return
          setSaving(true)
          const r = await acc.addMigrationDetail({ ...f, amount: parseCurrency(f.amount) }, currentUser?.id)
          setSaving(false)
          if (r.ok) {
            toast.success(which === 'in' ? 'Pemasukan lama dicatat' : 'Pengeluaran lama dicatat')
            if (which === 'in') { setMigIn(blankMigIn); setMigInErr({}) } else { setMigOut(blankMigOut); setMigOutErr({}) }
            loadMig(); loadDashboard()
          } else if (/relation|does not exist|schema cache/i.test(r.error || '')) { setMigNeedsMigration(true) } else toast.error(r.error)
        }
        const doBootstrap = async () => {
          if (bootstrapping) return; setBootstrapping(true)
          const r = await acc.bootstrapMigrationDetails()
          setBootstrapping(false)
          if (r.ok) { toast.success('Database migrasi siap dipakai'); setMigNeedsMigration(false); loadMig(); loadDashboard() }
          else if (r.missingFn) toast.error('Fungsi bootstrap belum ada di DB. Jalankan migration_details.sql sekali di Supabase → SQL Editor.')
          else toast.error(r.error)
        }
        const downloadTemplate = async () => {
          try {
            const mod = await import('xlsx'); const XLSX = mod.default || mod
            const inSheet = XLSX.utils.json_to_sheet([{ 'Tanggal': '2026-01-31', 'Nama Transaksi': 'Contoh penjualan tunai', 'Customer': 'Umum', 'Metode': 'cash', 'Nominal': 1500000, 'Catatan': 'opsional' }])
            const outSheet = XLSX.utils.json_to_sheet([{ 'Tanggal': '2026-01-31', 'Kategori': 'Operasional', 'Metode': 'transfer', 'Nominal': 500000, 'Catatan': 'opsional' }])
            const wb = XLSX.utils.book_new()
            XLSX.utils.book_append_sheet(wb, inSheet, 'Pemasukan Lama')
            XLSX.utils.book_append_sheet(wb, outSheet, 'Pengeluaran Lama')
            XLSX.writeFile(wb, 'template-migrasi-data.xlsx')
          } catch (er) { toast.error('Gagal membuat template: ' + (er?.message || er)) }
        }
        const onPickImport = async (file) => {
          if (!file) return
          try {
            const buf = await file.arrayBuffer()
            const mod = await import('xlsx'); const XLSX = mod.default || mod
            const wb = XLSX.read(buf, { type: 'array', cellDates: true })
            const toISO = (v) => {
              if (v == null || v === '') return ''
              if (v instanceof Date) return new Date(v.getTime() - v.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
              const s = String(v).trim(); const d = new Date(s)
              return isNaN(d.getTime()) ? s.slice(0, 10) : new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
            }
            const meth = (v) => { const s = String(v || '').toLowerCase(); if (s.includes('trans')) return 'transfer'; if (s.includes('qr')) return 'qris'; return 'cash' }
            const out = []
            const readSheet = (sheetName, type) => {
              const ws = wb.Sheets[sheetName]; if (!ws) return
              XLSX.utils.sheet_to_json(ws, { defval: '' }).forEach(r => {
                const get = (keys) => { for (const k of keys) { const kk = Object.keys(r).find(x => x.toLowerCase().trim() === k); if (kk != null) return r[kk] } return '' }
                const date = toISO(get(['tanggal', 'date']))
                const name = String(get(['nama transaksi', 'nama', 'kategori', 'sumber']) || '').trim()
                const customer = String(get(['customer', 'pelanggan']) || '').trim()
                const amount = parseCurrency(get(['nominal', 'amount', 'jumlah']))
                const method = meth(get(['metode', 'metode pembayaran', 'method']))
                const note = String(get(['catatan', 'note']) || '').trim()
                out.push({ type, date, name, customer: type === 'old_income' ? customer : '', amount: String(amount), method, note, _ok: !!(date && name && amount > 0) })
              })
            }
            readSheet('Pemasukan Lama', 'old_income')
            readSheet('Pengeluaran Lama', 'old_expense')
            if (out.length === 0) { toast.error('Sheet "Pemasukan Lama" / "Pengeluaran Lama" tidak ditemukan atau kosong'); return }
            setMigImport({ rows: out, fileName: file.name })
          } catch (er) { toast.error('Gagal membaca Excel: ' + (er?.message || er)) }
        }
        const confirmImport = async () => {
          if (importing || !migImport) return
          const valid = migImport.rows.filter(r => r._ok).map(r => ({ ...r, amount: parseCurrency(r.amount) }))
          if (valid.length === 0) return toast.error('Tidak ada baris valid untuk diimpor')
          setImporting(true)
          const r = await acc.bulkAddMigrationDetails(valid, currentUser?.id)
          setImporting(false)
          if (r.ok) { toast.success(`${r.count} data berhasil diimpor`); setMigImport(null); loadMig(); loadDashboard() } else toast.error(r.error)
        }
        const submitRecv = async () => {
          const e = {}
          if (!recvForm.date) e.date = 'Tanggal wajib diisi'
          if (!recvForm.customerName.trim()) e.customerName = 'Nama customer wajib diisi'
          if (!(parseCurrency(recvForm.amount) > 0)) e.amount = 'Nominal harus lebih dari 0'
          setRecvErr(e); if (Object.keys(e).length) return
          setSaving(true)
          const r = await acc.addOldReceivable({ ...recvForm, amount: parseCurrency(recvForm.amount) }, currentUser?.id)
          setSaving(false)
          if (r.ok) { toast.success('Piutang customer lama dicatat'); setRecvForm(blankRecv); setRecvErr({}); loadMig(); loadDashboard() }
          else toast.error(r.error)
        }
        const submitOldKas = async () => {
          const e = {}
          if (!oldKasForm.date) e.date = 'Tanggal wajib diisi'
          if (!oldKasForm.employeeName.trim()) e.employeeName = 'Nama karyawan wajib diisi'
          if (!(parseCurrency(oldKasForm.amount) > 0)) e.amount = 'Nominal harus lebih dari 0'
          setOldKasErr(e); if (Object.keys(e).length) return
          setSaving(true)
          const r = await acc.addOldKasbon({ ...oldKasForm, amount: parseCurrency(oldKasForm.amount) }, currentUser?.id)
          setSaving(false)
          if (r.ok) { toast.success('Kasbon karyawan lama dicatat'); setOldKasForm(blankOldKas); setOldKasErr({}); loadMig(); loadDashboard() }
          else toast.error(r.error)
        }
        const totIn = migRows.filter(x => x.type === 'old_income').reduce((s, x) => s + Math.round(x.amount || 0), 0)
        const totOut = migRows.filter(x => x.type === 'old_expense').reduce((s, x) => s + Math.round(x.amount || 0), 0)
        const totRecv = openingRecv.reduce((s, x) => s + Math.max(0, Math.round(x.total_debt || 0)), 0)
        const totKas = openingKas.reduce((s, x) => s + Math.round(x.amount || 0), 0)
        const importValidCount = (migImport?.rows || []).filter(r => r._ok).length
        // Riwayat gabungan 4 jenis (terbaru di atas)
        const histRows = [
          ...migRows.filter(x => x.type === 'old_income' || x.type === 'old_expense').map(x => ({ kind: x.type === 'old_income' ? 'income' : 'expense', id: x.id, date: x.trx_date, name: x.name || '—', customer: x.customer || '', amount: Math.round(x.amount || 0), method: x.method || '', note: x.notes || '', raw: x })),
          ...openingRecv.map(x => ({ kind: 'receivable', id: x.id, date: String(x.created_at).slice(0, 10), name: x.customer_name || '—', customer: '', amount: Math.round(x.total_debt || 0), paid: Math.round(x.paid || 0), method: '', note: x.notes || '', due: x.due_date, raw: x })),
          ...openingKas.map(x => ({ kind: 'kasbon', id: x.id, date: x.advance_date, name: x.employee_name || '—', customer: '', amount: Math.round(x.amount || 0), paid: Math.round(x.paid || 0), method: x.payment_method || '', note: x.notes || '', due: x.due_date, raw: x })),
        ].sort((a, b) => String(b.date).localeCompare(String(a.date)))
        const KIND_META = {
          income: { label: 'Pemasukan', color: '#10d98a', sign: '+' },
          expense: { label: 'Pengeluaran', color: '#ef4444', sign: '−' },
          receivable: { label: 'Piutang Customer', color: '#38BDF8', sign: '+' },
          kasbon: { label: 'Kasbon Karyawan', color: '#a78bfa', sign: '+' },
        }
        return (
        <div className="space-y-4">
          {migNeedsMigration && (
            <div className="rounded-2xl p-4" style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.35)' }}>
              <div className="flex items-center gap-2 mb-1" style={{ color: '#f59e0b' }}><AlertTriangle size={14} /> <span className="font-bold text-xs" style={{ fontFamily: 'Syne' }}>Tabel Migrasi belum dibuat</span></div>
              <p className="text-xs leading-relaxed" style={{ color: 'var(--text-secondary)' }}>Klik <b>Buat Database Otomatis</b> untuk membuat tabel langsung dari aplikasi. Jika gagal, jalankan <code>supabase/migrations/2026_06_migration_details.sql</code> sekali di Supabase → SQL Editor.</p>
              <div className="flex flex-wrap gap-2 mt-2.5">
                <button onClick={doBootstrap} disabled={bootstrapping} className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold btn-press" style={{ background: 'linear-gradient(135deg, var(--accent), #6366f1)', color: '#fff', fontFamily: 'Syne' }}>{bootstrapping ? <Loader2 size={12} className="animate-spin" /> : <Database size={12} />} Buat Database Otomatis</button>
                <button onClick={loadMig} className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold btn-press" style={{ background: 'var(--bg-elevated)', color: 'var(--text-primary)', border: '1px solid var(--border)', fontFamily: 'Syne' }}><RefreshCw size={11} /> Coba lagi</button>
              </div>
            </div>
          )}

          {/* RINGKASAN MIGRASI */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-3">
            <div className="rounded-xl p-3 min-w-0 overflow-hidden" style={{ background: 'var(--bg-card)', border: '1px solid rgba(16,217,138,0.3)' }}><div className="text-[10px] uppercase" style={{ color: 'var(--text-muted)' }}>Pemasukan Lama</div><div className="text-sm font-bold truncate" style={{ color: '#10d98a', fontVariantNumeric: 'tabular-nums' }}>{fmt(totIn)}</div></div>
            <div className="rounded-xl p-3 min-w-0 overflow-hidden" style={{ background: 'var(--bg-card)', border: '1px solid rgba(239,68,68,0.3)' }}><div className="text-[10px] uppercase" style={{ color: 'var(--text-muted)' }}>Pengeluaran Lama</div><div className="text-sm font-bold truncate" style={{ color: '#ef4444', fontVariantNumeric: 'tabular-nums' }}>{fmt(totOut)}</div></div>
            <div className="rounded-xl p-3 min-w-0 overflow-hidden" style={{ background: 'var(--bg-card)', border: '1px solid rgba(56,189,248,0.3)' }}><div className="text-[10px] uppercase" style={{ color: 'var(--text-muted)' }}>Piutang Customer</div><div className="text-sm font-bold truncate" style={{ color: '#38BDF8', fontVariantNumeric: 'tabular-nums' }}>{fmt(totRecv)}</div></div>
            <div className="rounded-xl p-3 min-w-0 overflow-hidden" style={{ background: 'var(--bg-card)', border: '1px solid rgba(167,139,250,0.3)' }}><div className="text-[10px] uppercase" style={{ color: 'var(--text-muted)' }}>Kasbon Karyawan</div><div className="text-sm font-bold truncate" style={{ color: '#a78bfa', fontVariantNumeric: 'tabular-nums' }}>{fmt(totKas)}</div></div>
          </div>

          {/* Pemilih jenis data lama */}
          <div className="flex gap-1.5 flex-wrap">
            {[['income', 'Pemasukan', TrendingUp], ['expense', 'Pengeluaran', TrendingDown], ['receivable', 'Piutang Customer', UsersIcon], ['kasbon', 'Kasbon Karyawan', HandCoins], ['modal', 'Modal & Saldo Awal', Wallet]].map(([k, lbl, Ic]) => {
              const a = migKind === k
              return <button key={k} onClick={() => setMigKind(k)} className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold transition-all flex-shrink-0" style={{ background: a ? 'linear-gradient(135deg, var(--accent), #6366f1)' : 'var(--bg-card)', color: a ? '#fff' : 'var(--text-secondary)', border: `1px solid ${a ? 'transparent' : 'var(--border)'}`, fontFamily: 'Syne' }}><Ic size={12} /> {lbl}</button>
            })}
          </div>

          {/* PEMASUKAN LAMA */}
          {migKind === 'income' && (
            <FormCard icon={TrendingUp} title="Tambah Pemasukan Lama" subtitle="Transaksi masuk sebelum POS dipakai. Menambah Omset & Uang Masuk — tanpa invoice / order / potong stok.">
              <Field icon={Receipt} label="Tanggal" required error={migInErr.date}>
                <input type="date" value={migIn.date} onChange={e => setMigIn(p => ({ ...p, date: e.target.value }))} className={FIELD_CLS} style={{ ...inpErr(migInErr.date), colorScheme: 'dark' }} />
              </Field>
              <Field icon={UsersIcon} label="Nama Transaksi" required error={migInErr.name}>
                <input value={migIn.name} onChange={e => setMigIn(p => ({ ...p, name: e.target.value }))} placeholder="Contoh: Penjualan tunai bulan lalu" className={FIELD_CLS} style={inpErr(migInErr.name)} />
              </Field>
              <Field icon={UsersIcon} label="Customer" hint="Opsional">
                <input value={migIn.customer} onChange={e => setMigIn(p => ({ ...p, customer: e.target.value }))} placeholder="Nama customer (opsional)" className={FIELD_CLS} style={inp} />
              </Field>
              <Field icon={Wallet} label="Metode Pembayaran">
                <select value={migIn.method} onChange={e => setMigIn(p => ({ ...p, method: e.target.value }))} className={FIELD_CLS} style={inp}>{METHODS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}</select>
              </Field>
              <Field icon={TrendingUp} label="Nominal" required error={migInErr.amount}>
                <MoneyInput value={migIn.amount} onChange={v => setMigIn(p => ({ ...p, amount: v }))} placeholder="0" className={FIELD_CLS} style={inpErr(migInErr.amount)} />
              </Field>
              <Field icon={BookOpen} label="Catatan">
                <input value={migIn.note} onChange={e => setMigIn(p => ({ ...p, note: e.target.value }))} placeholder="Opsional" className={FIELD_CLS} style={inp} />
              </Field>
              <Button variant="primary" className="w-full" disabled={saving} onClick={() => submitMig('in')}>{saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Catat Pemasukan Lama</Button>
            </FormCard>
          )}

          {/* PENGELUARAN LAMA */}
          {migKind === 'expense' && (
            <FormCard icon={TrendingDown} title="Tambah Pengeluaran Lama" subtitle="Pengeluaran sebelum POS dipakai. Menambah Total Pengeluaran & Uang Keluar; mengurangi Arus Kas & Laba.">
              <Field icon={Receipt} label="Tanggal" required error={migOutErr.date}>
                <input type="date" value={migOut.date} onChange={e => setMigOut(p => ({ ...p, date: e.target.value }))} className={FIELD_CLS} style={{ ...inpErr(migOutErr.date), colorScheme: 'dark' }} />
              </Field>
              <Field icon={Receipt} label="Kategori" required error={migOutErr.name}>
                <Combo value={migOut.name} onChange={v => setMigOut(p => ({ ...p, name: v }))} options={catOptions} error={migOutErr.name} baseStyle={inp} errStyle={inpErr(true)} placeholder="Pilih / cari kategori" allowCreate onCreate={async (name) => { const r = await acc.addExpenseCategory(name); if (r.ok) { toast.success('Kategori ditambah'); loadExpCats() } else if (!/relation|does not exist|schema cache/i.test(r.error || '')) toast.error(r.error) }} />
              </Field>
              <Field icon={Wallet} label="Metode Pembayaran">
                <select value={migOut.method} onChange={e => setMigOut(p => ({ ...p, method: e.target.value }))} className={FIELD_CLS} style={inp}>{METHODS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}</select>
              </Field>
              <Field icon={TrendingDown} label="Nominal" required error={migOutErr.amount}>
                <MoneyInput value={migOut.amount} onChange={v => setMigOut(p => ({ ...p, amount: v }))} placeholder="0" className={FIELD_CLS} style={inpErr(migOutErr.amount)} />
              </Field>
              <Field icon={BookOpen} label="Catatan">
                <input value={migOut.note} onChange={e => setMigOut(p => ({ ...p, note: e.target.value }))} placeholder="Opsional" className={FIELD_CLS} style={inp} />
              </Field>
              <Button variant="primary" className="w-full" disabled={saving} onClick={() => submitMig('out')}>{saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Catat Pengeluaran Lama</Button>
            </FormCard>
          )}

          {/* PIUTANG CUSTOMER LAMA */}
          {migKind === 'receivable' && (
            <FormCard icon={UsersIcon} title="Tambah Piutang Customer Lama" subtitle="Saldo awal piutang customer (sebelum POS). Menambah Piutang Usaha & Total Aset — TANPA uang masuk / invoice. Masuk modul Piutang & bisa dibayar normal.">
              <Field icon={Receipt} label="Tanggal" required error={recvErr.date}>
                <input type="date" value={recvForm.date} onChange={e => setRecvForm(p => ({ ...p, date: e.target.value }))} className={FIELD_CLS} style={{ ...inpErr(recvErr.date), colorScheme: 'dark' }} />
              </Field>
              <Field icon={UsersIcon} label="Nama Customer" required error={recvErr.customerName} hint="Jika sudah ada, otomatis digabung ke customer tsb">
                <input value={recvForm.customerName} onChange={e => setRecvForm(p => ({ ...p, customerName: e.target.value }))} placeholder="Nama customer" className={FIELD_CLS} style={inpErr(recvErr.customerName)} />
              </Field>
              <Field icon={Wallet} label="Nominal Piutang" required error={recvErr.amount}>
                <MoneyInput value={recvForm.amount} onChange={v => setRecvForm(p => ({ ...p, amount: v }))} placeholder="0" className={FIELD_CLS} style={inpErr(recvErr.amount)} />
              </Field>
              <Field icon={Receipt} label="Jatuh Tempo">
                <input type="date" value={recvForm.dueDate} onChange={e => setRecvForm(p => ({ ...p, dueDate: e.target.value }))} className={FIELD_CLS} style={{ ...inp, colorScheme: 'dark' }} />
              </Field>
              <Field icon={BookOpen} label="Catatan">
                <input value={recvForm.note} onChange={e => setRecvForm(p => ({ ...p, note: e.target.value }))} placeholder="Opsional" className={FIELD_CLS} style={inp} />
              </Field>
              <Button variant="primary" className="w-full" disabled={saving} onClick={submitRecv}>{saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Catat Piutang Customer Lama</Button>
            </FormCard>
          )}

          {/* KASBON KARYAWAN LAMA */}
          {migKind === 'kasbon' && (
            <FormCard icon={HandCoins} title="Tambah Kasbon Karyawan Lama" subtitle="Saldo awal kasbon karyawan (sebelum POS). Menambah Piutang Karyawan & Total Aset — TANPA uang keluar baru. Masuk modul Kasbon & bisa dibayar FIFO.">
              <Field icon={Receipt} label="Tanggal" required error={oldKasErr.date}>
                <input type="date" value={oldKasForm.date} onChange={e => setOldKasForm(p => ({ ...p, date: e.target.value }))} className={FIELD_CLS} style={{ ...inpErr(oldKasErr.date), colorScheme: 'dark' }} />
              </Field>
              <Field icon={UsersIcon} label="Nama Karyawan" required error={oldKasErr.employeeName} hint="Jika sudah ada, otomatis digabung ke karyawan tsb">
                <input value={oldKasForm.employeeName} onChange={e => setOldKasForm(p => ({ ...p, employeeName: e.target.value }))} placeholder="Nama karyawan" className={FIELD_CLS} style={inpErr(oldKasErr.employeeName)} />
              </Field>
              <Field icon={Wallet} label="Nominal Kasbon" required error={oldKasErr.amount}>
                <MoneyInput value={oldKasForm.amount} onChange={v => setOldKasForm(p => ({ ...p, amount: v }))} placeholder="0" className={FIELD_CLS} style={inpErr(oldKasErr.amount)} />
              </Field>
              <Field icon={Receipt} label="Jatuh Tempo">
                <input type="date" value={oldKasForm.dueDate} onChange={e => setOldKasForm(p => ({ ...p, dueDate: e.target.value }))} className={FIELD_CLS} style={{ ...inp, colorScheme: 'dark' }} />
              </Field>
              <Field icon={Wallet} label="Metode Pencairan">
                <select value={oldKasForm.method} onChange={e => setOldKasForm(p => ({ ...p, method: e.target.value }))} className={FIELD_CLS} style={inp}><option value="cash">Cash</option><option value="transfer">Transfer</option></select>
              </Field>
              <Field icon={BookOpen} label="Catatan">
                <input value={oldKasForm.note} onChange={e => setOldKasForm(p => ({ ...p, note: e.target.value }))} placeholder="Opsional" className={FIELD_CLS} style={inp} />
              </Field>
              <Button variant="primary" className="w-full" disabled={saving} onClick={submitOldKas}>{saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Catat Kasbon Karyawan Lama</Button>
            </FormCard>
          )}

          {/* MODAL & SALDO AWAL (EKUITAS) */}
          {migKind === 'modal' && (
            <>
            <FormCard icon={Wallet} title="Modal & Saldo Awal" subtitle="Catat setoran modal pemilik atau kas dari pencairan pinjaman. Menambah Saldo Kas/Bank & Total Aset, supaya Neraca seimbang (Aset = Hutang + Modal).">
              <Field icon={BookOpen} label="Jenis" required hint="Setoran Modal = ekuitas pemilik. Pencairan Pinjaman = kas dari hutang bank yang sudah dicatat (ekuitas netral).">
                <select value={capForm.type} onChange={e => setCapForm(p => ({ ...p, type: e.target.value }))} className={FIELD_CLS} style={inp}>
                  <option value="modal">Setoran Modal (Ekuitas Pemilik)</option>
                  <option value="loan_cash">Pencairan Pinjaman ke Kas</option>
                </select>
              </Field>
              <Field icon={Receipt} label="Tanggal" required error={capErr.date}>
                <input type="date" value={capForm.date} onChange={e => setCapForm(p => ({ ...p, date: e.target.value }))} className={FIELD_CLS} style={{ ...inpErr(capErr.date), colorScheme: 'dark' }} />
              </Field>
              <Field icon={Pencil} label="Keterangan" hint="mis. Setoran modal awal / Pencairan KPR BCA">
                <input value={capForm.name} onChange={e => setCapForm(p => ({ ...p, name: e.target.value }))} placeholder={capForm.type === 'modal' ? 'Setoran Modal' : 'Pencairan Pinjaman ke Kas'} className={FIELD_CLS} style={inp} />
              </Field>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Field icon={Wallet} label="Nominal" required error={capErr.amount}>
                  <MoneyInput value={capForm.amount} onChange={v => setCapForm(p => ({ ...p, amount: v }))} placeholder="0" className={FIELD_CLS} style={inpErr(capErr.amount)} />
                </Field>
                <Field icon={Landmark} label="Masuk ke">
                  <select value={capForm.method} onChange={e => setCapForm(p => ({ ...p, method: e.target.value }))} className={FIELD_CLS} style={inp}><option value="cash">Kas (Cash)</option><option value="transfer">Bank (Transfer)</option><option value="qris">Bank (QRIS)</option></select>
                </Field>
              </div>
              <Field icon={BookOpen} label="Catatan">
                <input value={capForm.note} onChange={e => setCapForm(p => ({ ...p, note: e.target.value }))} placeholder="Opsional" className={FIELD_CLS} style={inp} />
              </Field>
              <Button variant="primary" className="w-full" disabled={saving} onClick={async () => {
                const e = {}; if (!(parseCurrency(capForm.amount) > 0)) e.amount = 'Nominal harus > 0'; if (!capForm.date) e.date = 'Tanggal wajib'
                setCapErr(e); if (Object.keys(e).length) return
                setSaving(true); const r = await acc.addCapitalEntry({ ...capForm, amount: parseCurrency(capForm.amount) }, currentUser?.id); setSaving(false)
                if (r.ok) { toast.success('Modal/saldo awal dicatat'); setCapForm(blankCap); setCapErr({}); loadCap(); loadDashboard() } else toast.error(r.error)
              }}>{saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Catat Modal / Saldo Awal</Button>
            </FormCard>
            {capList.length > 0 && (
              <div className="rounded-2xl p-4" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
                <div className="text-xs font-bold uppercase tracking-wider mb-2" style={{ color: 'var(--accent-light)', fontFamily: 'Syne' }}>Riwayat Modal & Saldo Awal</div>
                <div className="space-y-2">
                  {capList.map(x => (
                    <div key={x.id} className="flex items-center gap-3 p-2.5 rounded-xl min-w-0" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}>
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{x.name || (x.type === 'modal' ? 'Setoran Modal' : 'Pencairan Pinjaman')} <span className="text-[9px] px-1.5 py-0.5 rounded font-bold" style={{ background: x.type === 'modal' ? 'rgba(16,217,138,0.15)' : 'rgba(56,189,248,0.15)', color: x.type === 'modal' ? '#10d98a' : '#38BDF8' }}>{x.type === 'modal' ? 'MODAL' : 'PINJAMAN'}</span></div>
                        <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{dt(x.trx_date)} · {(x.method || 'cash').toUpperCase()}{x.notes ? ` · ${x.notes}` : ''}</div>
                      </div>
                      <div className="text-sm font-bold whitespace-nowrap" style={{ color: '#10d98a', fontVariantNumeric: 'tabular-nums' }}>{fmt(x.amount)}</div>
                      <button onClick={async () => { if (!(await confirm({ title: 'Yakin ingin menghapus data ini?' }))) return; const r = await acc.deleteMigrationDetail(x.id); if (r.ok) { toast.success('Dihapus'); loadCap(); loadDashboard() } else toast.error(r.error) }} className="w-7 h-7 rounded-lg inline-flex items-center justify-center flex-shrink-0" style={{ background: 'rgba(255,77,106,0.08)', color: 'var(--red)' }} title="Hapus"><Trash2 size={11} /></button>
                    </div>
                  ))}
                </div>
              </div>
            )}
            </>
          )}

          {/* IMPORT EXCEL */}
          <FormCard icon={FileSpreadsheet} title="Import Excel" subtitle="Unggah banyak data sekaligus. 2 sheet: 'Pemasukan Lama' & 'Pengeluaran Lama'.">
            <div className="flex flex-col sm:flex-row gap-2">
              <Button variant="secondary" className="flex-1" onClick={downloadTemplate}><Download size={14} /> Download Template</Button>
              <label className="flex-1 inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-xl text-sm font-semibold cursor-pointer btn-press" style={{ background: 'rgba(139,92,246,0.1)', color: 'var(--accent-light)', border: '1px solid rgba(139,92,246,0.25)', fontFamily: 'Syne' }}>
                <Upload size={14} /> Upload Excel
                <input type="file" accept=".xlsx,.xls" className="hidden" onChange={e => { onPickImport(e.target.files?.[0]); e.target.value = '' }} />
              </label>
            </div>
            {migImport && (
              <div className="rounded-xl p-3" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}>
                <div className="flex items-center gap-2 mb-2 flex-wrap">
                  <span className="text-xs font-bold" style={{ color: 'var(--text-primary)', fontFamily: 'Syne' }}>Preview: {migImport.fileName}</span>
                  <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{importValidCount} valid / {migImport.rows.length} baris</span>
                  <button onClick={() => setMigImport(null)} className="ml-auto text-[11px]" style={{ color: 'var(--red)' }}>Batal</button>
                </div>
                <div className="overflow-x-auto -mx-1" style={{ maxHeight: 260, overflowY: 'auto' }}>
                  <table className="w-full text-xs" style={{ borderCollapse: 'collapse', minWidth: 520 }}>
                    <thead><tr style={{ borderBottom: '1px solid var(--border)' }}>{['Jenis', 'Tanggal', 'Nama/Kategori', 'Customer', 'Metode', 'Nominal', 'OK'].map(h => <th key={h} className={`px-2 py-1.5 ${h === 'Nominal' ? 'text-right' : 'text-left'}`} style={{ color: 'var(--text-muted)', fontSize: 10 }}>{h}</th>)}</tr></thead>
                    <tbody>
                      {migImport.rows.map((r, i) => (
                        <tr key={i} style={{ borderBottom: '1px solid var(--border)', opacity: r._ok ? 1 : 0.5 }}>
                          <td className="px-2 py-1.5"><span style={{ color: r.type === 'old_income' ? '#10d98a' : '#ef4444' }}>{r.type === 'old_income' ? 'Masuk' : 'Keluar'}</span></td>
                          <td className="px-2 py-1.5" style={{ color: 'var(--text-secondary)' }}>{r.date || '—'}</td>
                          <td className="px-2 py-1.5 truncate" style={{ color: 'var(--text-primary)', maxWidth: 160 }}>{r.name || '—'}</td>
                          <td className="px-2 py-1.5 truncate" style={{ color: 'var(--text-muted)', maxWidth: 110 }}>{r.customer || '—'}</td>
                          <td className="px-2 py-1.5 uppercase" style={{ color: 'var(--text-muted)', fontSize: 10 }}>{r.method}</td>
                          <td className="px-2 py-1.5 text-right font-bold" style={{ color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>{fmt(parseCurrency(r.amount))}</td>
                          <td className="px-2 py-1.5">{r._ok ? <Check size={12} style={{ color: '#10d98a' }} /> : <X size={12} style={{ color: '#ef4444' }} />}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <Button variant="primary" className="w-full mt-2" disabled={importing || importValidCount === 0} onClick={confirmImport}>{importing ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Konfirmasi Import ({importValidCount})</Button>
              </div>
            )}
          </FormCard>

          {/* RIWAYAT MIGRASI (4 jenis) */}
          <div className="rounded-2xl p-4" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
            <div className="flex items-center gap-2 mb-3">
              <BookOpen size={15} style={{ color: 'var(--accent-light)' }} />
              <h3 className="font-bold text-sm" style={{ fontFamily: 'Syne', color: 'var(--text-primary)' }}>Riwayat Migrasi Data</h3>
              <span className="ml-auto text-[11px]" style={{ color: 'var(--text-muted)' }}>{histRows.length} data</span>
            </div>
            {histRows.length === 0 ? <p className="text-xs text-center py-4" style={{ color: 'var(--text-muted)' }}>Belum ada data migrasi</p> : (
              <div className="space-y-2">
                {histRows.map(x => {
                  const m = KIND_META[x.kind]; const c = m.color
                  const onEdit = () => {
                    if (x.kind === 'income' || x.kind === 'expense') setEditMig({ id: x.id, type: x.raw.type, date: x.raw.trx_date, name: x.raw.name || '', customer: x.raw.customer || '', amount: String(Math.round(x.raw.amount || 0)), method: x.raw.method || 'cash', note: x.raw.notes || '' })
                    else if (x.kind === 'receivable') setEditRecv({ id: x.id, customerName: x.name, date: x.date, amount: String(x.amount), dueDate: x.due || '', note: x.note })
                    else setEditOldKas({ id: x.id, employeeName: x.name, date: x.date, amount: String(x.amount), dueDate: x.due || '', method: x.method || 'cash', note: x.note })
                  }
                  const onDelete = async () => {
                    if (!(await confirm({ title: 'Yakin ingin menghapus data migrasi ini?', message: 'Data akan dihapus & dashboard (omset/pengeluaran/piutang/aset/laba) menyesuaikan realtime.' }))) return
                    let r
                    if (x.kind === 'income' || x.kind === 'expense') r = await acc.deleteMigrationDetail(x.id)
                    else if (x.kind === 'receivable') r = await acc.deleteOldReceivable(x.id)
                    else r = await acc.deleteEmployeeAdvance(x.id)
                    if (r.ok) { toast.success('Data migrasi dihapus'); loadMig(); loadDashboard() } else toast.error(r.error)
                  }
                  return (
                    <div key={x.kind + x.id} className="rounded-xl p-3 min-w-0 overflow-hidden" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}>
                      <div className="flex items-center gap-2 flex-wrap min-w-0">
                        <span className="text-[10px] px-1.5 py-0.5 rounded font-bold flex-shrink-0" style={{ background: `${c}22`, color: c }}>{m.label}</span>
                        <span className="text-xs font-semibold truncate min-w-0" style={{ color: 'var(--text-primary)' }}>{x.name || '—'}</span>
                        {x.kind === 'income' && x.customer && <span className="text-[10px] px-1.5 py-0.5 rounded flex-shrink-0" style={{ background: 'rgba(56,189,248,0.12)', color: '#38BDF8' }}>{x.customer}</span>}
                        {x.method && <span className="text-[10px] uppercase flex-shrink-0" style={{ color: 'var(--text-muted)' }}>{x.method}</span>}
                        <span className="ml-auto text-sm font-bold flex-shrink-0" style={{ color: c, fontVariantNumeric: 'tabular-nums' }}>{m.sign}{fmt(x.amount)}</span>
                      </div>
                      <div className="flex items-center gap-2 mt-1.5">
                        <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{dt(x.date)}{(x.kind === 'receivable' || x.kind === 'kasbon') && x.paid > 0 ? ` · dibayar ${fmt(x.paid)}` : ''}{x.note ? ` · ${x.note}` : ''}</span>
                        <div className="ml-auto flex gap-1.5 flex-shrink-0">
                          <button onClick={onEdit} className="w-8 h-8 rounded-lg inline-flex items-center justify-center btn-press" style={{ background: 'rgba(139,92,246,0.1)', color: 'var(--accent-light)' }} title="Edit"><Pencil size={12} /></button>
                          <button onClick={onDelete} className="w-8 h-8 rounded-lg inline-flex items-center justify-center btn-press" style={{ background: 'rgba(255,77,106,0.08)', color: 'var(--red)' }} title="Hapus"><Trash2 size={12} /></button>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* Sinkronisasi & urutan migrasi DB */}
          <FormCard icon={Database} title="Sinkronisasi & Migrasi Database" subtitle="Hitung ulang seluruh jurnal & saldo accounting, lalu ekspor data bila perlu.">
            <div className="flex flex-col sm:flex-row gap-2">
              <Button variant="primary" className="flex-1" disabled={syncing} onClick={doSync}>{syncing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} Sinkronkan Sekarang</Button>
              <Button variant="secondary" className="flex-1" disabled={exporting} onClick={exportExcel}>{exporting ? <Loader2 size={14} className="animate-spin" /> : <FileSpreadsheet size={14} />} Export Excel</Button>
            </div>
            <div className="rounded-xl p-3" style={{ background: 'var(--bg-elevated)' }}>
              <div className="text-[10px] font-bold uppercase tracking-wider mb-1.5" style={{ color: 'var(--text-muted)', fontFamily: 'Syne' }}>Urutan Migrasi Database (Supabase → SQL Editor)</div>
              <p className="text-[11px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>… → supplier_debt_fixes → employee_cash_advances → employees_master → migration_details.</p>
            </div>
          </FormCard>
        </div>
        )
      })()}

      {/* ── PENGATURAN ACCOUNTING ── */}
      {tab === 'pengaturan' && !loading && (
        <div className="space-y-4">
          <FormCard icon={Settings} title="Pengaturan Accounting" subtitle="Atur kategori pengeluaran & pintasan pengelolaan modul accounting.">
            {canManageCat ? (
              <Button variant="secondary" className="w-full" onClick={() => { setCatMgr(true); setCatNew(''); setCatEdit(null); setCatSearch('') }}><Receipt size={14} /> Kelola Kategori Pengeluaran</Button>
            ) : (
              <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Pengelolaan kategori hanya untuk Owner / Staff Admin.</p>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <Button variant="secondary" className="w-full" onClick={() => setTab('migrasi')}><Database size={14} /> Migrasi Data</Button>
              <Button variant="secondary" className="w-full" disabled={syncing} onClick={doSync}>{syncing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} Sinkronkan</Button>
            </div>
            <div className="rounded-xl p-3" style={{ background: 'var(--bg-elevated)' }}>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div><div className="text-[10px] uppercase" style={{ color: 'var(--text-muted)' }}>Periode Laporan</div><div className="font-semibold" style={{ color: 'var(--text-primary)' }}>{dt(from)} — {dt(to)}</div></div>
                <div><div className="text-[10px] uppercase" style={{ color: 'var(--text-muted)' }}>Peran Anda</div><div className="font-semibold" style={{ color: 'var(--accent-light)' }}>{isOwner ? 'Owner' : (currentUser?.role === 'admin' ? 'Staff Admin' : 'Staff')}</div></div>
              </div>
            </div>
          </FormCard>
        </div>
      )}

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
              <div className="text-[11px] mt-1.5" style={{ color: 'var(--text-muted)', fontFamily: "'Inter', sans-serif" }}>Penjualan {fmt(d.penjualan)} − Uang Keluar {fmt(ukBasis + rentAgg.bebanPeriod)}<span style={{ opacity: 0.7 }}> (sudah termasuk beban sewa {fmt(rentAgg.bebanPeriod)})</span></div>
            </div>
          )}

          {/* BARIS 1 — Aktivitas Kas: Penjualan(biru) · Arus Kas(tosca) · Sudah Bayar(hijau muda) · Uang Masuk(hijau) */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <Card icon={Wallet} label="Penjualan / Omzet" value={fmt(d.penjualan)} color="#3b82f6" sub="Total invoice valid" onClick={() => openDetail('penjualan', 'Penjualan / Omzet', '#3b82f6')} />
            <Card icon={Wallet} label="Total Omset All Time" value={allTime ? fmt(allTime.omset) : '…'} color="#2563eb" sub="Semua waktu" onClick={() => openDetail('penjualan', 'Total Omset — Semua Waktu', '#2563eb', { from: ALL_TIME_FROM, to: todayYMD() })} />
            <Card icon={Scale} label="Arus Saldo Bersih" value={fmt((d.uang_masuk_total || 0) - (ukBasis + rentAgg.cashOutPeriod))} color="#14b8a6" sub="Uang masuk aktual − uang keluar aktual" onClick={() => setArusKasOpen(true)} />
            <Card icon={TrendingUp} label="Sudah Bayar (Piutang)" value={fmt(d.sudah_bayar)} color="#4ade80" sub="DP + cicilan diterima" onClick={() => openDetail('sudah_bayar', 'Sudah Bayar (Piutang)', '#4ade80')} />
            <Card icon={TrendingUp} label="Uang Masuk" value={fmt(d.uang_masuk_total)} color="#10d98a" sub="Yang benar-benar diterima" onClick={() => openDetail('uang_masuk', 'Uang Masuk', '#10d98a')} />
          </div>

          {/* BARIS 2 — Kewajiban & Biaya: Uang Keluar(merah) · Beban(kuning tua) · Hutang Supplier(orange) · Persediaan(ungu) */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <Card icon={TrendingDown} label="Uang Keluar" value={fmt(ukBasis + rentAgg.bebanPeriod)} color="#ef4444" sub="Termasuk beban sewa (amortisasi)" onClick={() => openDetail('uang_keluar', 'Uang Keluar', '#ef4444')} />
            <Card icon={TrendingDown} label="Total Pengeluaran All Time" value={(pengOutAll != null || allTime) ? fmt((pengOutAll != null ? pengOutAll : allTime.pengeluaran) + rentBebanAllTimeAcc) : '…'} color="#dc2626" sub="Semua waktu" onClick={() => openDetail('uang_keluar', 'Total Pengeluaran — Semua Waktu', '#dc2626', { from: ALL_TIME_FROM, to: todayYMD() })} />
            <Card icon={Receipt} label="Beban (Op+Gaji+Bunga)" value={fmt((d.operasional || 0) + (d.gaji || 0) + (d.beban_bunga || 0))} color="#d97706" onClick={() => openDetail('beban', 'Beban (Operasional+Gaji+Bunga)', '#d97706')} />
            <Card icon={Truck} label="Hutang Supplier" value={fmt(d.hutang_supplier)} color="#f97316" onClick={() => openDetail('hutang_supplier', 'Hutang Supplier', '#f97316')} />
            <Card icon={HandCoins} label="Piutang Karyawan" value={fmt(d.piutang_karyawan)} color="#22c55e" sub="Total sisa kasbon aktif" onClick={() => setTab('kasbon')} />
            <Card icon={Home} label="Beban Sewa Bulan Ini" value={fmt(rentAgg.bebanBulanIni)} color="#d97706" sub="Akrual sewa berjalan" onClick={() => setTab('sewa')} />
          </div>

          {/* BARIS 3 — Aset & Kewajiban: Piutang Usaha(emas) · Hutang Bank(merah tua, terakhir) */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <Card icon={TrendingUp} label="Piutang Usaha" value={fmt(d.piutang_aktif)} color="#f59e0b" onClick={() => openDetail('piutang', 'Piutang Usaha (Aktif)', '#f59e0b')} />
            <Card icon={Building2} label="Hutang Bank" value={fmt(d.hutang_bank)} color="#b91c1c" sub={`${d.pinjaman_aktif || 0} pinjaman aktif · cicilan ${fmt(d.cicilan_bank)}`} onClick={() => openDetail('hutang_bank', 'Hutang Bank', '#b91c1c')} />
          </div>

          {/* BARIS 4 — Saldo, Aset & Kekayaan Bersih — OWNER ONLY (sensitif) */}
          {isOwner && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <Card icon={Wallet} label="Saldo (Kas & Bank)" value={fmt(saldoKasBank)} color={saldoKasBank >= 0 ? '#14b8a6' : '#ef4444'} sub="Klik → rincian saldo" onClick={() => setSaldoDetailOpen(true)} />
            <Card icon={Landmark} label="Aset Tetap (Nilai Buku)" value={fmt(asetTetap)} color="#a78bfa" sub="Klik → kelola aset" onClick={() => setTab('aset')} />
            <Card icon={Home} label="Sewa Dibayar Dimuka" value={fmt(rentAgg.dibayarDimuka)} color="#a78bfa" sub="Sisa sewa belum jadi beban" onClick={() => setTab('sewa')} />
            <Card icon={Wallet} label="Total Aset" value={fmt(asetTotal)} color="#3b82f6" sub="Saldo+Piutang+Karyawan+Aset+Sewa" onClick={() => openInfo('totalaset')} />
            <Card icon={Scale} label="Kekayaan Bersih" value={fmt(kekayaanBersih)} color="#10d98a" sub="Total Aset − Total Hutang" onClick={() => openInfo('kekayaan')} />
          </div>
          )}

          {/* Neraca sederhana — OWNER ONLY (data ekuitas sensitif) */}
          {isOwner && (
          <div className="rounded-2xl p-4" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
            <div className="text-xs font-bold uppercase tracking-wider mb-3" style={{ color: 'var(--accent-light)', fontFamily: 'Syne' }}>Neraca Sederhana (s/d {dt(to)})</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
              <div>
                <div className="font-bold mb-1" style={{ color: 'var(--text-secondary)' }}>Aset</div>
                {[['Saldo (Kas & Bank)', saldoKasBank], ['Piutang Usaha', d.piutang_aktif], ['Piutang Karyawan', d.piutang_karyawan], ['Aset Tetap', asetTetap], ['Sewa Dibayar Dimuka', rentAgg.dibayarDimuka]].map(([k, v]) => <div key={k} className="flex justify-between py-0.5" style={{ color: 'var(--text-muted)' }}><span>{k}</span><span style={{ color: 'var(--text-primary)' }}>{fmt(v)}</span></div>)}
                <div className="flex justify-between py-1 mt-1 font-bold" style={{ borderTop: '1px solid var(--border)', color: 'var(--text-primary)' }}><span>Total Aset</span><span>{fmt(asetTotal)}</span></div>
              </div>
              <div>
                <div className="font-bold mb-1" style={{ color: 'var(--text-secondary)' }}>Kewajiban & Ekuitas</div>
                <div className="flex justify-between py-0.5" style={{ color: 'var(--text-muted)' }}><span>Hutang Supplier</span><span style={{ color: 'var(--text-primary)' }}>{fmt(d.hutang_supplier)}</span></div>
                <div className="flex justify-between py-0.5" style={{ color: 'var(--text-muted)' }}><span>Hutang Bank</span><span style={{ color: 'var(--text-primary)' }}>{fmt(d.hutang_bank)}</span></div>
                <div className="flex justify-between py-0.5 font-semibold" style={{ color: 'var(--text-muted)' }}><span>Total Hutang</span><span style={{ color: '#ef4444' }}>{fmt(totalHutang)}</span></div>
                <div className="flex justify-between py-0.5 mt-1" style={{ color: 'var(--text-muted)' }}><span>Modal Disetor</span><span style={{ color: 'var(--text-primary)' }}>{fmt(d.modal_disetor || 0)}</span></div>
                <div className="flex justify-between py-0.5" style={{ color: 'var(--text-muted)' }}><span>Laba Ditahan</span><span style={{ color: 'var(--text-primary)' }}>{fmt(kekayaanBersih - (d.modal_disetor || 0))}</span></div>
                <div className="flex justify-between py-0.5 font-semibold" style={{ color: 'var(--text-muted)' }}><span>Total Ekuitas</span><span style={{ color: '#10d98a' }}>{fmt(kekayaanBersih)}</span></div>
                <div className="flex justify-between py-1 mt-1 font-bold" style={{ borderTop: '1px solid var(--border)', color: 'var(--text-primary)' }}><span>Total Kewajiban + Ekuitas</span><span>{fmt(totalHutang + kekayaanBersih)}</span></div>
              </div>
            </div>
            {/* Status keseimbangan neraca: Aset = Kewajiban + Ekuitas */}
            <div className="mt-3 rounded-xl px-3 py-2.5 flex items-center justify-between gap-2 flex-wrap"
              style={{
                background: neracaBalance.balanced ? 'rgba(16,217,138,0.08)' : 'rgba(239,68,68,0.08)',
                border: `1px solid ${neracaBalance.balanced ? 'rgba(16,217,138,0.3)' : 'rgba(239,68,68,0.35)'}`,
              }}>
              <span className="text-xs font-bold inline-flex items-center gap-1.5" style={{ color: neracaBalance.balanced ? '#10d98a' : '#ef4444', fontFamily: 'Syne' }}>
                {neracaBalance.balanced ? <><Check size={13} /> Neraca Seimbang</> : <><AlertTriangle size={13} /> Neraca TIDAK Seimbang</>}
              </span>
              <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                Aset {fmt(neracaBalance.asetTotal)} = Kewajiban+Ekuitas {fmt(neracaBalance.kewajibanEkuitas)} · Selisih <b style={{ color: neracaBalance.balanced ? '#10d98a' : '#ef4444' }}>{fmt(neracaBalance.selisih)}</b>
              </span>
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
            <div className="flex items-center justify-between gap-2 flex-wrap mb-1">
              <div className="text-xs font-bold uppercase tracking-wider" style={{ color: 'var(--text-muted)', fontFamily: 'Syne' }}>Riwayat Pengeluaran</div>
              <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                Menampilkan <b style={{ color: 'var(--text-secondary)' }}>{expenses.length}</b> transaksi · Periode: <b style={{ color: 'var(--accent-light)' }}>{(QUICK_PRESETS.find(([k]) => k === detectPreset(from, to)) || [])[1] || `${dt(from)} – ${dt(to)}`}</b>
              </div>
            </div>
            {expenses.length === 0 && <p className="text-xs text-center py-6" style={{ color: 'var(--text-muted)' }}>Tidak ada pengeluaran pada periode ini</p>}
            {expenses.map(x => (
              <div key={x.id} className="flex items-center gap-3 p-3 rounded-xl" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{x.category}{x.note ? <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}> · {x.note}</span> : null}</div>
                  <div className="text-[11px] mt-0.5 flex items-center gap-1.5 flex-wrap" style={{ color: 'var(--text-muted)' }}><span>{formatDateTimeWIB(x.expense_date, x.created_at)}</span><span className="px-1.5 py-0.5 rounded" style={{ background: 'rgba(139,92,246,0.1)', color: 'var(--accent-light)', textTransform: 'uppercase', fontSize: 9 }}>{x.method}</span></div>
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
          {/* LIST UTAMA: 1 card per supplier (dikelompokkan) */}
          <div className="space-y-2.5">{supGroups.length === 0 && <p className="text-xs text-center py-4" style={{ color: 'var(--text-muted)' }}>Belum ada hutang supplier</p>}
            {supGroups.map(g => {
              const stColor = g.remaining <= 0 ? '#10d98a' : g.overdue ? '#fb923c' : '#f59e0b'
              return (
                <div key={g.supplier} className="rounded-2xl p-3.5 min-w-0" style={{ background: 'var(--bg-card)', border: `1px solid ${g.overdue ? 'rgba(251,146,60,0.4)' : 'var(--border)'}` }}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-bold truncate" style={{ color: 'var(--text-primary)', fontFamily: 'Syne' }}>{g.supplier}</div>
                      <div className="text-[11px] truncate" style={{ color: 'var(--text-muted)' }}>{g.count} nota hutang{g.nearest ? ` · Tempo terdekat ${dt(g.nearest)}` : ''}</div>
                    </div>
                    <span className="text-[10px] px-1.5 py-0.5 rounded font-bold flex-shrink-0" style={{ background: `${stColor}22`, color: stColor }}>{g.status}</span>
                  </div>
                  <div className="grid grid-cols-3 gap-2 mt-2.5">
                    <div className="rounded-lg p-2 min-w-0" style={{ background: 'var(--bg-elevated)' }}><div className="text-[9px] uppercase" style={{ color: 'var(--text-muted)' }}>Total</div><div className="text-xs font-bold truncate" style={{ color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>{fmt(g.total)}</div></div>
                    <div className="rounded-lg p-2 min-w-0" style={{ background: 'var(--bg-elevated)' }}><div className="text-[9px] uppercase" style={{ color: 'var(--text-muted)' }}>Bayar</div><div className="text-xs font-bold truncate" style={{ color: '#10d98a', fontVariantNumeric: 'tabular-nums' }}>{fmt(g.paid)}</div></div>
                    <div className="rounded-lg p-2 min-w-0" style={{ background: 'var(--bg-elevated)' }}><div className="text-[9px] uppercase" style={{ color: 'var(--text-muted)' }}>Sisa</div><div className="text-xs font-bold truncate" style={{ color: g.remaining > 0 ? '#ef4444' : '#10d98a', fontVariantNumeric: 'tabular-nums' }}>{fmt(g.remaining)}</div></div>
                  </div>
                  <div className="flex gap-2 mt-2.5">
                    <button onClick={() => openSupDetail(g.supplier)} className="flex-1 h-9 rounded-lg text-xs font-semibold inline-flex items-center justify-center gap-1.5 btn-press" style={{ background: 'var(--bg-elevated)', color: 'var(--text-primary)', border: '1px solid var(--border)', fontFamily: 'Syne' }}><BookOpen size={13} /> Detail</button>
                    {g.remaining > 0 && <button onClick={() => openFifo(g.supplier)} className="flex-1 h-9 rounded-lg text-xs font-semibold inline-flex items-center justify-center gap-1.5 btn-press" style={{ background: 'linear-gradient(135deg,#10d98a,#059669)', color: '#fff', fontFamily: 'Syne' }}><Wallet size={13} /> Bayar FIFO</button>}
                  </div>
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
                                    <td className="px-2 py-2" style={{ color: 'var(--text-secondary)' }}>{formatDateTimeWIB(p.paid_at, p.paid_at)}</td>
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

      {/* ── KASBON KARYAWAN (Piutang Karyawan / Aset) ── */}
      {tab === 'kasbon' && !loading && (() => {
        const todayLocal = new Date().toLocaleDateString('en-CA')
        // Opsi nama untuk dropdown: master karyawan + nama yang sudah dipakai di kasbon.
        const empMap = new Map()
        ;(employees || []).forEach(e => empMap.set(e.name.trim().toLowerCase(), { id: e.id, name: e.name }))
        ;(advances || []).forEach(a => { const n = (a.employee_name || '').trim(); if (n && !empMap.has(n.toLowerCase())) empMap.set(n.toLowerCase(), { id: 'adv:' + n, name: n }) })
        const employeeOptions = [...empMap.values()].sort((a, b) => a.name.localeCompare(b.name))
        const empIdByName = (name) => (employees || []).find(e => e.name.trim().toLowerCase() === (name || '').trim().toLowerCase())?.id || null
        // ── Kelompokkan kasbon per karyawan (employee_id bila ada, fallback nama) ──
        const gmap = new Map()
        ;(advances || []).forEach(a => {
          const key = a.employee_id || ('name:' + (a.employee_name || '').trim().toLowerCase())
          if (!gmap.has(key)) gmap.set(key, { key, employeeId: a.employee_id || null, name: (a.employee_name || '—'), items: [] })
          gmap.get(key).items.push(a)
        })
        const groupsAll = [...gmap.values()].map(g => {
          // FIFO: urut paling lama dulu untuk tampilan & alokasi pembayaran.
          const items = [...g.items].sort((x, y) => (String(x.advance_date).localeCompare(String(y.advance_date))) || (String(x.created_at || '').localeCompare(String(y.created_at || ''))))
          const totalAmount = items.reduce((s, x) => s + Math.round(x.amount || 0), 0)
          const totalPaid = items.reduce((s, x) => s + Math.round(x.paid || 0), 0)
          const totalSisa = Math.max(0, totalAmount - totalPaid)
          const overdue = items.some(x => { const rem = Math.max(0, Math.round(x.amount || 0) - Math.round(x.paid || 0)); return x.due_date && String(x.due_date).slice(0, 10) < todayLocal && rem > 0 })
          return { ...g, items, totalAmount, totalPaid, totalSisa, overdue, status: totalSisa <= 0 ? 'Lunas' : overdue ? 'Lewat Tempo' : 'Aktif' }
        }).sort((a, b) => b.totalSisa - a.totalSisa || a.name.localeCompare(b.name))
        const groups = groupsAll.filter(g => {
          if (kasbonFilter === 'aktif') return g.totalSisa > 0
          if (kasbonFilter === 'lunas') return g.totalSisa <= 0
          if (kasbonFilter === 'tempo') return g.overdue
          return true
        })
        const exportKasbon = async () => {
          if (exporting) return; setExporting(true)
          try {
            const mod = await import('xlsx'); const XLSX = mod.default || mod
            const rows = []
            groups.forEach(g => g.items.forEach(x => rows.push({
              'Nama Karyawan': g.name,
              'Tanggal Kasbon': x.advance_date,
              'Kasbon Awal': Math.round(x.amount || 0),
              'Sudah Dibayar': Math.round(x.paid || 0),
              'Sisa Kasbon': Math.max(0, Math.round(x.amount || 0) - Math.round(x.paid || 0)),
              'Jatuh Tempo': x.due_date || '',
              'Status': Math.max(0, Math.round(x.amount || 0) - Math.round(x.paid || 0)) <= 0 ? 'Lunas' : 'Aktif',
            })))
            const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Kasbon Karyawan')
            XLSX.writeFile(wb, `kasbon-karyawan-${acc.todayISO()}.xlsx`)
          } catch (e) { toast.error('Gagal export: ' + (e?.message || e)) } finally { setExporting(false) }
        }
        const submitKasbon = async () => {
          const e = {}
          if (!kasbonForm.employeeName.trim()) e.employeeName = 'Nama karyawan wajib diisi'
          if (!(parseCurrency(kasbonForm.amount) > 0)) e.amount = 'Nominal harus lebih dari 0'
          if (!kasbonForm.date) e.date = 'Tanggal kasbon wajib diisi'
          setKasbonErr(e); if (Object.keys(e).length) return
          setSaving(true)
          const r = await acc.addEmployeeAdvance({ ...kasbonForm, employeeId: empIdByName(kasbonForm.employeeName), amount: parseCurrency(kasbonForm.amount) }, currentUser?.id)
          setSaving(false)
          if (r.ok) { toast.success('Kasbon dicatat'); setKasbonForm(blankKasbon); setKasbonErr({}); loadAdvances(); loadDashboard() } else toast.error(r.error)
        }
        const totAwal = groups.reduce((s, g) => s + g.totalAmount, 0)
        const totBayar = groups.reduce((s, g) => s + g.totalPaid, 0)
        const totSisa = Math.max(0, totAwal - totBayar)
        return (
        <div className="space-y-4">
          {kasbonNeedsMigration && (
            <div className="rounded-2xl p-4" style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.35)' }}>
              <div className="flex items-center gap-2 mb-1" style={{ color: '#f59e0b' }}><AlertTriangle size={14} /> <span className="font-bold text-xs" style={{ fontFamily: 'Syne' }}>Tabel Kasbon belum dimigrasi</span></div>
              <p className="text-xs leading-relaxed" style={{ color: 'var(--text-secondary)' }}>Jalankan <code>supabase/migrations/2026_06_employee_cash_advances.sql</code> lalu <code>2026_06_employees_master.sql</code> di Supabase → SQL Editor, lalu klik Coba lagi. Tab Accounting lain tetap berfungsi normal.</p>
              <button onClick={loadAdvances} className="mt-2 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold" style={{ background: 'var(--bg-elevated)', color: 'var(--text-primary)', border: '1px solid var(--border)', fontFamily: 'Syne' }}><RefreshCw size={11} /> Coba lagi</button>
            </div>
          )}
          <FormCard icon={HandCoins} title="Tambah Kasbon Karyawan" subtitle="Uang perusahaan yang dipinjamkan ke karyawan. Tercatat sebagai Piutang Karyawan (aset) — bukan beban/gaji.">
            {/* Form 1 kolom vertikal (rapi di desktop & iPhone portrait/landscape) */}
            <Field icon={UsersIcon} label="Nama Karyawan" required error={kasbonErr.employeeName}>
              <Combo
                value={kasbonForm.employeeName}
                onChange={v => setKasbonForm(p => ({ ...p, employeeName: v }))}
                options={employeeOptions}
                error={kasbonErr.employeeName}
                baseStyle={inp} errStyle={inpErr(true)}
                placeholder="Pilih nama lama / ketik nama baru"
                allowCreate
                onCreate={async (name) => { const r = await acc.addEmployee({ name }); if (r.ok) { toast.success('Karyawan ditambah'); loadEmployees() } else if (!/relation|does not exist|schema cache/i.test(r.error || '')) toast.error(r.error) }}
                rightButton={<button type="button" onClick={() => setEmpModal({ ...blankEmp })} className="flex-shrink-0 px-3 rounded-xl text-xs font-semibold inline-flex items-center gap-1" style={{ background: 'rgba(139,92,246,0.12)', color: 'var(--accent-light)', border: '1px solid rgba(139,92,246,0.3)', fontFamily: 'Syne' }} title="Tambah karyawan baru"><Plus size={13} /> <span className="hidden sm:inline">Karyawan</span></button>}
              />
            </Field>
            <Field icon={TrendingDown} label="Nominal Kasbon" required error={kasbonErr.amount}>
              <MoneyInput value={kasbonForm.amount} onChange={v => setKasbonForm(p => ({ ...p, amount: v }))} placeholder="0" className={FIELD_CLS} style={inpErr(kasbonErr.amount)} />
            </Field>
            <Field icon={Receipt} label="Tanggal Kasbon" required error={kasbonErr.date}>
              <input type="date" value={kasbonForm.date} onChange={e => setKasbonForm(p => ({ ...p, date: e.target.value }))} className={FIELD_CLS} style={{ ...inpErr(kasbonErr.date), colorScheme: 'dark' }} />
            </Field>
            <Field icon={Receipt} label="Jatuh Tempo">
              <input type="date" value={kasbonForm.dueDate} onChange={e => setKasbonForm(p => ({ ...p, dueDate: e.target.value }))} className={FIELD_CLS} style={{ ...inp, colorScheme: 'dark' }} />
            </Field>
            <Field icon={Wallet} label="Metode Pencairan">
              <select value={kasbonForm.method} onChange={e => setKasbonForm(p => ({ ...p, method: e.target.value }))} className={FIELD_CLS} style={inp}>
                <option value="cash">Cash</option><option value="transfer">Transfer</option>
              </select>
            </Field>
            <Field icon={BookOpen} label="Catatan">
              <input value={kasbonForm.note} onChange={e => setKasbonForm(p => ({ ...p, note: e.target.value }))} placeholder="Opsional" className={FIELD_CLS} style={inp} />
            </Field>
            <Button variant="primary" className="w-full" disabled={saving} onClick={submitKasbon}>{saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Catat Kasbon</Button>
          </FormCard>

          {/* Ringkasan + filter + export */}
          <div className="flex items-center gap-2 flex-wrap">
            <select value={kasbonFilter} onChange={e => setKasbonFilter(e.target.value)} className="px-3 py-2 rounded-xl text-xs font-semibold" style={inp}>
              <option value="all">Semua Karyawan</option><option value="aktif">Aktif</option><option value="lunas">Lunas</option><option value="tempo">Jatuh Tempo</option>
            </select>
            <button onClick={exportKasbon} disabled={exporting} className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold btn-press ml-auto" style={{ background: 'rgba(16,217,138,0.12)', color: '#10d98a', border: '1px solid rgba(16,217,138,0.3)', fontFamily: 'Syne' }}>{exporting ? <Loader2 size={12} className="animate-spin" /> : <FileSpreadsheet size={12} />} Excel</button>
          </div>
          {groups.length > 0 && (
            <div className="grid grid-cols-3 gap-2 sm:gap-3">
              <div className="rounded-xl p-3 min-w-0 overflow-hidden" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}><div className="text-[10px] uppercase" style={{ color: 'var(--text-muted)' }}>Total Kasbon</div><div className="text-sm font-bold truncate" style={{ color: 'var(--text-primary)' }}>{fmt(totAwal)}</div></div>
              <div className="rounded-xl p-3 min-w-0 overflow-hidden" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}><div className="text-[10px] uppercase" style={{ color: 'var(--text-muted)' }}>Sudah Bayar</div><div className="text-sm font-bold truncate" style={{ color: '#10d98a' }}>{fmt(totBayar)}</div></div>
              <div className="rounded-xl p-3 min-w-0 overflow-hidden" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}><div className="text-[10px] uppercase" style={{ color: 'var(--text-muted)' }}>Sisa Piutang</div><div className="text-sm font-bold truncate" style={{ color: '#ef4444' }}>{fmt(totSisa)}</div></div>
            </div>
          )}

          {/* Daftar dikelompokkan per karyawan — 1 card / karyawan, full width */}
          <div className="space-y-2.5">
            {groups.length === 0 && <p className="text-xs text-center py-4" style={{ color: 'var(--text-muted)' }}>Belum ada kasbon</p>}
            {groups.map(g => {
              const stColor = g.totalSisa <= 0 ? '#10d98a' : g.overdue ? '#fb923c' : '#f59e0b'
              const openDetail = async () => {
                setDetailEmp(g)
                // muat riwayat pembayaran tiap kasbon karyawan ini
                const map = {}
                for (const it of g.items) { const r = await acc.listAdvancePayments(it.id); map[it.id] = r.ok ? r.data : [] }
                setDetailPayRows(map)
              }
              return (
                <div key={g.key} className="rounded-2xl p-4 w-full min-w-0 overflow-hidden acc-card cursor-pointer" style={{ background: 'var(--bg-card)', border: `1px solid ${g.overdue ? 'rgba(251,146,60,0.4)' : 'var(--border)'}`, '--card-glow': `${stColor}3a` }} onClick={openDetail}>
                  <div className="flex items-center gap-2 mb-3 min-w-0">
                    <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: `${stColor}1f`, border: `1px solid ${stColor}44` }}><UsersIcon size={16} style={{ color: stColor }} /></div>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-bold truncate" style={{ color: 'var(--text-primary)', fontFamily: 'Syne' }}>{g.name}</div>
                      <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{g.items.length} kasbon</div>
                    </div>
                    <span className="text-[10px] px-2 py-0.5 rounded-full font-bold flex-shrink-0" style={{ background: `${stColor}22`, color: stColor }}>{g.status}</span>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <div className="min-w-0"><div className="text-[9px] uppercase" style={{ color: 'var(--text-muted)' }}>Total Kasbon</div><div className="text-xs font-bold truncate" style={{ color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>{fmt(g.totalAmount)}</div></div>
                    <div className="min-w-0"><div className="text-[9px] uppercase" style={{ color: 'var(--text-muted)' }}>Sudah Bayar</div><div className="text-xs font-bold truncate" style={{ color: '#10d98a', fontVariantNumeric: 'tabular-nums' }}>{fmt(g.totalPaid)}</div></div>
                    <div className="min-w-0"><div className="text-[9px] uppercase" style={{ color: 'var(--text-muted)' }}>Sisa</div><div className="text-xs font-bold truncate" style={{ color: g.totalSisa > 0 ? '#ef4444' : '#10d98a', fontVariantNumeric: 'tabular-nums' }}>{fmt(g.totalSisa)}</div></div>
                  </div>
                  <div className="flex gap-2 mt-3 pt-3" style={{ borderTop: '1px solid var(--border)' }} onClick={e => e.stopPropagation()}>
                    {g.totalSisa > 0 && <button onClick={() => setGroupPay({ key: g.key, name: g.name, sisa: g.totalSisa, items: g.items, amount: String(g.totalSisa), method: 'cash', date: acc.todayISO(), note: '' })} className="flex-1 py-2.5 rounded-xl text-xs font-bold btn-press inline-flex items-center justify-center gap-1.5" style={{ background: 'linear-gradient(135deg,#10d98a,#059669)', color: '#fff', fontFamily: 'Syne' }}><Wallet size={13} /> Bayar (FIFO)</button>}
                    <button onClick={openDetail} className="flex-1 py-2.5 rounded-xl text-xs font-bold btn-press inline-flex items-center justify-center gap-1.5" style={{ background: 'rgba(56,189,248,0.12)', color: '#38BDF8', fontFamily: 'Syne' }}><BookOpen size={13} /> Detail</button>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
        )
      })()}

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

      {/* ── EDIT KASBON KARYAWAN ── */}
      <Modal open={!!editAdv} zIndex={1100} onClose={() => setEditAdv(null)} title="Edit Kasbon Karyawan" size="sm">
        {editAdv && (
          <div className="space-y-3">
            <Field icon={UsersIcon} label="Nama Karyawan" required><input value={editAdv.employeeName} onChange={e => setEditAdv(p => ({ ...p, employeeName: e.target.value }))} className={FIELD_CLS} style={inp} /></Field>
            <Field icon={TrendingDown} label="Nominal Kasbon" required><MoneyInput value={editAdv.amount} onChange={v => setEditAdv(p => ({ ...p, amount: v }))} className={FIELD_CLS} style={inp} /></Field>
            <div className="grid grid-cols-2 gap-2">
              <Field icon={Receipt} label="Tanggal Kasbon" required><input type="date" value={editAdv.date} onChange={e => setEditAdv(p => ({ ...p, date: e.target.value }))} className={FIELD_CLS} style={{ ...inp, colorScheme: 'dark' }} /></Field>
              <Field icon={Receipt} label="Jatuh Tempo"><input type="date" value={editAdv.dueDate} onChange={e => setEditAdv(p => ({ ...p, dueDate: e.target.value }))} className={FIELD_CLS} style={{ ...inp, colorScheme: 'dark' }} /></Field>
            </div>
            <Field icon={Wallet} label="Metode Pencairan"><select value={editAdv.method} onChange={e => setEditAdv(p => ({ ...p, method: e.target.value }))} className={FIELD_CLS} style={inp}><option value="cash">Cash</option><option value="transfer">Transfer</option></select></Field>
            <Field icon={Pencil} label="Catatan"><input value={editAdv.note} onChange={e => setEditAdv(p => ({ ...p, note: e.target.value }))} className={FIELD_CLS} style={inp} /></Field>
            <Button variant="primary" className="w-full" disabled={saving} onClick={async () => {
              if (!editAdv.employeeName.trim()) return toast.error('Nama karyawan wajib diisi')
              if (!(parseCurrency(editAdv.amount) > 0)) return toast.error('Nominal harus lebih dari 0')
              setSaving(true)
              const r = await acc.editEmployeeAdvance(editAdv.id, { ...editAdv, amount: parseCurrency(editAdv.amount) })
              setSaving(false)
              if (r.ok) { toast.success('Kasbon diperbarui'); setEditAdv(null); if (detailEmp) refreshDetailEmp(detailEmp.key); else { loadAdvances(); loadDashboard() } } else toast.error(r.error)
            }}><Check size={14} /> Simpan</Button>
          </div>
        )}
      </Modal>

      {/* ── EDIT PEMBAYARAN KASBON (di atas modal detail, z lebih tinggi) ── */}
      <Modal open={!!editPay} zIndex={1100} onClose={() => setEditPay(null)} title="Edit Pembayaran Kasbon" subtitle="Perubahan langsung menghitung ulang sudah bayar, sisa, status & dashboard." size="sm">
        {editPay && (
          <div className="space-y-3">
            <Field icon={Receipt} label="Tanggal Pembayaran" required><input type="date" value={editPay.date} onChange={e => setEditPay(p => ({ ...p, date: e.target.value }))} className={FIELD_CLS} style={{ ...inp, colorScheme: 'dark' }} /></Field>
            <Field icon={TrendingDown} label="Nominal Pembayaran" required><MoneyInput value={editPay.amount} onChange={v => setEditPay(p => ({ ...p, amount: v }))} className={FIELD_CLS} style={inp} /></Field>
            <Field icon={Wallet} label="Metode Pembayaran"><select value={editPay.method} onChange={e => setEditPay(p => ({ ...p, method: e.target.value }))} className={FIELD_CLS} style={inp}><option value="cash">Cash</option><option value="transfer">Transfer</option></select></Field>
            <Field icon={Pencil} label="Catatan"><input value={editPay.note} onChange={e => setEditPay(p => ({ ...p, note: e.target.value }))} className={FIELD_CLS} style={inp} /></Field>
            <Button variant="primary" className="w-full" disabled={saving} onClick={async () => {
              if (saving) return
              if (!(parseCurrency(editPay.amount) > 0)) return toast.error('Nominal harus lebih dari 0')
              setSaving(true)
              const r = await acc.editAdvancePayment(editPay.id, { amount: parseCurrency(editPay.amount), method: editPay.method, note: editPay.note, date: editPay.date })
              setSaving(false)
              if (r.ok) { toast.success('Pembayaran diperbarui'); setEditPay(null); if (detailEmp) refreshDetailEmp(detailEmp.key); else { loadAdvances(); loadDashboard() } } else toast.error(r.error)
            }}><Check size={14} /> Simpan</Button>
          </div>
        )}
      </Modal>

      {/* ── DETAIL KASBON PER KARYAWAN (rincian semua kasbon + riwayat bayar) ── */}
      <Modal open={!!detailEmp} mobileFull zIndex={1010} lockClose={!!editAdv || !!groupPay || !!editPay} onClose={() => { setDetailEmp(null); setDetailPayRows({}); setAdvPayInModal(null) }} title={detailEmp ? `Kasbon — ${detailEmp.name}` : ''} subtitle={detailEmp ? `${detailEmp.items.length} kasbon` : ''} size="lg">
        {detailEmp && (() => {
          const todayLocal = new Date().toLocaleDateString('en-CA')
          const sum = [['Total Kasbon', fmt(detailEmp.totalAmount), 'var(--text-primary)'], ['Sudah Bayar', fmt(detailEmp.totalPaid), '#10d98a'], ['Sisa', fmt(detailEmp.totalSisa), detailEmp.totalSisa > 0 ? '#ef4444' : '#10d98a'], ['Status', detailEmp.status, detailEmp.totalSisa <= 0 ? '#10d98a' : detailEmp.overdue ? '#fb923c' : '#f59e0b']]
          return (
            <div className="space-y-4">
              {/* Ringkasan grup */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {sum.map(([k, v, c]) => <div key={k} className="rounded-xl p-2.5 min-w-0 overflow-hidden" style={{ background: 'var(--bg-elevated)' }}><div className="text-[9px] uppercase" style={{ color: 'var(--text-muted)' }}>{k}</div><div className="text-sm font-bold truncate" style={{ color: c, fontVariantNumeric: 'tabular-nums' }}>{v}</div></div>)}
              </div>
              {detailEmp.totalSisa > 0 && (
                <button onClick={() => setGroupPay({ key: detailEmp.key, name: detailEmp.name, sisa: detailEmp.totalSisa, items: detailEmp.items, amount: String(detailEmp.totalSisa), method: 'cash', date: acc.todayISO(), note: '' })} className="w-full py-3 rounded-xl text-sm font-bold btn-press inline-flex items-center justify-center gap-2" style={{ background: 'linear-gradient(135deg,#10d98a,#059669)', color: '#fff', fontFamily: 'Syne' }}><Wallet size={15} /> Bayar Semua (FIFO)</button>
              )}

              {/* Daftar kasbon karyawan ini (paling lama dulu) */}
              <div className="space-y-2.5">
                {detailEmp.items.map((x, idx) => {
                  const awal = Math.round(x.amount || 0)
                  const bayar = Math.round(x.paid || 0)
                  const rem = Math.max(0, awal - bayar)
                  const overdue = x.due_date && String(x.due_date).slice(0, 10) < todayLocal && rem > 0
                  const status = rem <= 0 ? 'Lunas' : overdue ? 'Lewat Tempo' : 'Aktif'
                  const stColor = rem <= 0 ? '#10d98a' : overdue ? '#fb923c' : '#f59e0b'
                  const pays = detailPayRows[x.id] || []
                  return (
                    <div key={x.id} className="rounded-xl p-3 min-w-0 overflow-hidden" style={{ background: 'var(--bg-card)', border: `1px solid ${overdue ? 'rgba(251,146,60,0.4)' : 'var(--border)'}` }}>
                      <div className="flex items-center gap-2 mb-2">
                        <span className="text-[10px] font-bold px-1.5 py-0.5 rounded" style={{ background: 'var(--bg-elevated)', color: 'var(--text-muted)' }}>#{idx + 1}</span>
                        <span className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>{dt(x.advance_date)}</span>
                        <span className="text-[10px] px-1.5 py-0.5 rounded font-bold" style={{ background: `${stColor}22`, color: stColor }}>{status}</span>
                        <span className="ml-auto text-[10px] uppercase" style={{ color: 'var(--text-muted)' }}>{x.payment_method}</span>
                      </div>
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-2">
                        <div className="min-w-0"><div className="text-[9px] uppercase" style={{ color: 'var(--text-muted)' }}>Nominal Awal</div><div className="text-xs font-bold truncate" style={{ color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>{fmt(awal)}</div></div>
                        <div className="min-w-0"><div className="text-[9px] uppercase" style={{ color: 'var(--text-muted)' }}>Sudah Dibayar</div><div className="text-xs font-bold truncate" style={{ color: '#10d98a', fontVariantNumeric: 'tabular-nums' }}>{fmt(bayar)}</div></div>
                        <div className="min-w-0"><div className="text-[9px] uppercase" style={{ color: 'var(--text-muted)' }}>Sisa</div><div className="text-xs font-bold truncate" style={{ color: rem > 0 ? '#ef4444' : '#10d98a', fontVariantNumeric: 'tabular-nums' }}>{fmt(rem)}</div></div>
                        <div className="min-w-0"><div className="text-[9px] uppercase" style={{ color: 'var(--text-muted)' }}>Jatuh Tempo</div><div className="text-xs font-bold truncate" style={{ color: overdue ? '#fb923c' : 'var(--text-primary)' }}>{x.due_date ? dt(x.due_date) : '—'}</div></div>
                      </div>
                      {x.notes && <p className="text-[11px] mb-2" style={{ color: 'var(--text-muted)' }}>Catatan: {x.notes}</p>}

                      {/* Riwayat pembayaran kasbon ini */}
                      {pays.length > 0 && (
                        <div className="rounded-lg p-2 mb-2" style={{ background: 'var(--bg-elevated)' }}>
                          <div className="text-[9px] font-bold uppercase tracking-wider mb-1" style={{ color: 'var(--text-muted)' }}>Riwayat Pembayaran</div>
                          <div className="space-y-1">
                            {pays.map(p => (
                              <div key={p.id} className="flex items-center gap-2 text-[11px]">
                                <span style={{ color: 'var(--text-secondary)' }}>{dt(p.payment_date)}</span>
                                <span className="font-bold" style={{ color: '#10d98a', fontVariantNumeric: 'tabular-nums' }}>{fmt(p.amount)}</span>
                                <span className="uppercase text-[9px]" style={{ color: 'var(--text-muted)' }}>{p.payment_method}</span>
                                {p.notes && <span className="truncate" style={{ color: 'var(--text-muted)' }}>· {p.notes}</span>}
                                <div className="ml-auto flex items-center gap-1 flex-shrink-0">
                                  <button onClick={() => setEditPay({ id: p.id, amount: String(Math.round(p.amount || 0)), method: p.payment_method === 'transfer' ? 'transfer' : 'cash', date: String(p.payment_date).slice(0, 10), note: p.notes || '' })} className="w-6 h-6 rounded inline-flex items-center justify-center" style={{ background: 'rgba(139,92,246,0.12)', color: 'var(--accent-light)' }} title="Edit pembayaran"><Pencil size={10} /></button>
                                  {isOwner && <button onClick={async () => { if (!(await confirm({ title: 'Yakin ingin menghapus pembayaran kasbon ini?', message: 'Pembayaran dibatalkan (soft delete). Sisa kasbon naik kembali; uang masuk, arus kas, piutang karyawan & dashboard menyesuaikan.' }))) return; const r = await acc.deleteAdvancePayment(p.id); if (r.ok) { toast.success('Pembayaran dihapus'); refreshDetailEmp(detailEmp.key) } else toast.error(r.error) }} className="w-6 h-6 rounded inline-flex items-center justify-center" style={{ background: 'rgba(255,77,106,0.08)', color: 'var(--red)' }} title="Hapus pembayaran"><Trash2 size={10} /></button>}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Aksi per kasbon: Bayar / Edit / Hapus */}
                      <div className="flex gap-1.5">
                        {rem > 0 && <button onClick={() => { setAdvPayInModal(advPayInModal === x.id ? null : x.id); setAdvPay({ amount: String(rem), method: 'cash', date: acc.todayISO(), note: '' }) }} className="flex-1 py-2 rounded-lg text-[11px] font-bold btn-press" style={{ background: 'rgba(16,217,138,0.12)', color: '#10d98a', fontFamily: 'Syne' }}>Bayar</button>}
                        <button onClick={() => setEditAdv({ id: x.id, employeeName: x.employee_name || '', amount: String(awal), date: x.advance_date || acc.todayISO(), dueDate: x.due_date || '', method: x.payment_method || 'cash', note: x.notes || '' })} className="flex-1 py-2 rounded-lg text-[11px] font-bold btn-press" style={{ background: 'rgba(139,92,246,0.12)', color: 'var(--accent-light)', fontFamily: 'Syne' }}>Edit</button>
                        {isOwner && <button onClick={async () => { if (!(await confirm({ title: 'Yakin ingin menghapus data ini?', message: 'Kasbon ini & pembayarannya akan disembunyikan. Dashboard & neraca akan menyesuaikan.' }))) return; const r = await acc.deleteEmployeeAdvance(x.id); if (r.ok) { toast.success('Kasbon dihapus'); refreshDetailEmp(detailEmp.key) } else toast.error(r.error) }} className="px-3 py-2 rounded-lg btn-press" style={{ background: 'rgba(255,77,106,0.08)', color: 'var(--red)' }} title="Hapus kasbon"><Trash2 size={12} /></button>}
                      </div>

                      {/* Form bayar 1 kasbon (inline) */}
                      {advPayInModal === x.id && (
                        <div className="grid grid-cols-2 gap-2 mt-2 pt-2" style={{ borderTop: '1px dashed var(--border)' }}>
                          <MoneyInput value={advPay.amount} onChange={v => setAdvPay(p => ({ ...p, amount: v }))} placeholder="Nominal" className="px-2.5 py-2 rounded-lg text-xs" style={inp} />
                          <input type="date" value={advPay.date} onChange={e => setAdvPay(p => ({ ...p, date: e.target.value }))} className="px-2.5 py-2 rounded-lg text-xs" style={{ ...inp, colorScheme: 'dark' }} />
                          <select value={advPay.method} onChange={e => setAdvPay(p => ({ ...p, method: e.target.value }))} className="px-2.5 py-2 rounded-lg text-xs" style={inp}><option value="cash">Cash</option><option value="transfer">Transfer</option></select>
                          <Button variant="success" size="sm" disabled={saving} onClick={async () => { if (saving) return; const amt = parseCurrency(advPay.amount); if (!(amt > 0)) return toast.error('Nominal > 0'); setSaving(true); const r = await acc.payEmployeeAdvance(x.id, { amount: Math.min(amt, rem), method: advPay.method, date: advPay.date, note: advPay.note }, currentUser?.id); setSaving(false); if (r.ok) { toast.success('Pembayaran dicatat'); setAdvPayInModal(null); refreshDetailEmp(detailEmp.key) } else toast.error(r.error) }}>Konfirmasi</Button>
                          <input value={advPay.note} onChange={e => setAdvPay(p => ({ ...p, note: e.target.value }))} placeholder="Catatan (opsional)" className="px-2.5 py-2 rounded-lg text-xs col-span-2" style={inp} />
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })()}
      </Modal>

      {/* ── BAYAR KASBON FIFO (per kelompok karyawan) ── */}
      <Modal open={!!groupPay} zIndex={1100} onClose={() => setGroupPay(null)} title={groupPay ? `Bayar Kasbon — ${groupPay.name}` : ''} subtitle="Pembayaran otomatis masuk ke kasbon paling lama dulu (FIFO)." size="sm">
        {groupPay && (() => {
          const amt = parseCurrency(groupPay.amount)
          // Pratinjau alokasi FIFO
          const queue = [...groupPay.items]
            .map(a => ({ id: a.id, date: a.advance_date, rem: Math.max(0, Math.round(a.amount || 0) - Math.round(a.paid || 0)) }))
            .filter(a => a.rem > 0)
            .sort((x, y) => String(x.date).localeCompare(String(y.date)))
          let left = amt; const alloc = []
          for (const q of queue) { if (left <= 0) break; const pay = Math.min(left, q.rem); alloc.push({ ...q, pay }); left -= pay }
          return (
            <div className="space-y-3">
              <div className="rounded-xl p-3 text-xs" style={{ background: 'var(--bg-elevated)', color: 'var(--text-secondary)' }}>Sisa kasbon <b style={{ color: 'var(--text-primary)' }}>{groupPay.name}</b>: <b style={{ color: '#ef4444' }}>{fmt(groupPay.sisa)}</b></div>
              <Field icon={Wallet} label="Nominal Pembayaran" required>
                <MoneyInput value={groupPay.amount} onChange={v => setGroupPay(p => ({ ...p, amount: v }))} placeholder="0" className={FIELD_CLS} style={inp} />
              </Field>
              <div className="grid grid-cols-2 gap-2">
                <Field icon={Receipt} label="Tanggal Bayar"><input type="date" value={groupPay.date} onChange={e => setGroupPay(p => ({ ...p, date: e.target.value }))} className={FIELD_CLS} style={{ ...inp, colorScheme: 'dark' }} /></Field>
                <Field icon={Wallet} label="Metode"><select value={groupPay.method} onChange={e => setGroupPay(p => ({ ...p, method: e.target.value }))} className={FIELD_CLS} style={inp}><option value="cash">Cash</option><option value="transfer">Transfer</option></select></Field>
              </div>
              <Field icon={Pencil} label="Catatan"><input value={groupPay.note} onChange={e => setGroupPay(p => ({ ...p, note: e.target.value }))} placeholder="Opsional" className={FIELD_CLS} style={inp} /></Field>
              {amt > 0 && (
                <div className="rounded-xl p-2.5" style={{ background: 'rgba(16,217,138,0.06)', border: '1px solid rgba(16,217,138,0.25)' }}>
                  <div className="text-[10px] font-bold uppercase tracking-wider mb-1" style={{ color: '#10d98a' }}>Pratinjau Alokasi FIFO</div>
                  {alloc.length === 0 ? <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>Tidak ada sisa kasbon.</p> : alloc.map((a, i) => (
                    <div key={a.id} className="flex items-center gap-2 text-[11px]"><span style={{ color: 'var(--text-secondary)' }}>Kasbon {dt(a.date)}</span><span className="ml-auto font-bold" style={{ color: '#10d98a', fontVariantNumeric: 'tabular-nums' }}>{fmt(a.pay)}</span>{a.pay >= a.rem ? <span className="text-[9px] px-1 rounded" style={{ background: 'rgba(16,217,138,0.2)', color: '#10d98a' }}>LUNAS</span> : <span className="text-[9px] px-1 rounded" style={{ background: 'rgba(245,158,11,0.2)', color: '#f59e0b' }}>SISA {fmt(a.rem - a.pay)}</span>}</div>
                  ))}
                  {left > 0 && <p className="text-[10px] mt-1" style={{ color: '#fb923c' }}>Kelebihan {fmt(left)} tidak dialokasikan (melebihi sisa kasbon).</p>}
                </div>
              )}
              <Button variant="primary" className="w-full" disabled={saving} onClick={async () => {
                if (saving) return
                const a = parseCurrency(groupPay.amount); if (!(a > 0)) return toast.error('Nominal harus > 0')
                setSaving(true)
                const r = await acc.payEmployeeFIFO(groupPay.items, { amount: Math.min(a, groupPay.sisa), method: groupPay.method, date: groupPay.date, note: groupPay.note }, currentUser?.id)
                setSaving(false)
                if (r.ok) { toast.success(`Pembayaran ${fmt(r.applied)} dialokasikan ke ${r.count} kasbon`); setGroupPay(null); if (detailEmp) refreshDetailEmp(groupPay.key); else { loadAdvances(); loadDashboard() } } else toast.error(r.error)
              }}><Check size={14} /> Bayar (FIFO)</Button>
            </div>
          )
        })()}
      </Modal>

      {/* ── TAMBAH / EDIT MASTER KARYAWAN ── */}
      <Modal open={!!empModal} onClose={() => setEmpModal(null)} title={empModal?.id ? 'Edit Karyawan' : 'Tambah Karyawan'} subtitle="Data karyawan tersimpan agar tidak perlu diketik ulang saat input kasbon." size="sm">
        {empModal && (
          <div className="space-y-3">
            <Field icon={UsersIcon} label="Nama Karyawan" required><input value={empModal.name} onChange={e => setEmpModal(p => ({ ...p, name: e.target.value }))} placeholder="Nama lengkap" className={FIELD_CLS} style={inp} /></Field>
            <Field icon={Wallet} label="No HP"><input value={empModal.phone} onChange={e => setEmpModal(p => ({ ...p, phone: e.target.value }))} placeholder="08xx" inputMode="tel" className={FIELD_CLS} style={inp} /></Field>
            <Field icon={Building2} label="Jabatan"><input value={empModal.position} onChange={e => setEmpModal(p => ({ ...p, position: e.target.value }))} placeholder="Contoh: Operator Produksi" className={FIELD_CLS} style={inp} /></Field>
            <Field icon={Pencil} label="Catatan"><input value={empModal.notes} onChange={e => setEmpModal(p => ({ ...p, notes: e.target.value }))} placeholder="Opsional" className={FIELD_CLS} style={inp} /></Field>
            <Button variant="primary" className="w-full" disabled={saving} onClick={async () => {
              if (!empModal.name.trim()) return toast.error('Nama karyawan wajib diisi')
              setSaving(true)
              const r = empModal.id ? await acc.updateEmployee(empModal.id, empModal) : await acc.addEmployee(empModal)
              setSaving(false)
              if (r.ok) { toast.success(empModal.id ? 'Karyawan diperbarui' : 'Karyawan ditambah'); if (!empModal.id && r.data?.name) setKasbonForm(p => ({ ...p, employeeName: r.data.name })); setEmpModal(null); loadEmployees() }
              else if (/relation|does not exist|schema cache/i.test(r.error || '')) toast.error('Tabel karyawan belum dimigrasi. Jalankan 2026_06_employees_master.sql.')
              else toast.error(r.error)
            }}><Check size={14} /> {empModal.id ? 'Simpan' : 'Tambah Karyawan'}</Button>
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
                      <td className="px-2 py-2" style={{ color: 'var(--text-muted)' }}>{formatDateTimeWIB(p.paid_at, p.paid_at)}</td>
                      <td className="px-2 py-2" colSpan={editCols}>
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                          <MoneyInput value={hEdit.amount} onChange={v => setHEdit(s => ({ ...s, amount: v }))} placeholder="Nominal" className="px-2 py-1 rounded text-xs" style={inp} />
                          <select value={hEdit.method} onChange={e => setHEdit(s => ({ ...s, method: e.target.value }))} className="px-2 py-1 rounded text-xs" style={inp}>{METHODS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}</select>
                          <input value={hEdit.note} onChange={e => setHEdit(s => ({ ...s, note: e.target.value }))} placeholder="Keterangan" className="px-2 py-1 rounded text-xs" style={inp} />
                        </div>
                      </td>
                      <td className="px-2 py-2 text-right whitespace-nowrap">
                        <button onClick={async () => {
                          const amt = parseCurrency(hEdit.amount)
                          if (!(amt > 0)) return toast.error('Nominal harus lebih dari 0')
                          // Cegah overpay: nominal baru tidak boleh membuat total
                          // pembayaran melebihi total hutang supplier.
                          if (!isBank && history.ctx?.total != null) {
                            const maxAmt = Math.max(0, Math.round(history.ctx.total) - (Math.round(history.ctx.paid || 0) - Math.round(p.amount || 0)))
                            if (amt > maxAmt) return toast.error(`Maksimal ${fmt(maxAmt)} — melebihi sisa hutang`)
                          }
                          const r = isBank
                            ? await acc.editBankPayment(p.id, { amount: amt, method: hEdit.method, note: hEdit.note })
                            : await acc.editSupplierPayment(p.id, { amount: amt, method: hEdit.method, note: hEdit.note })
                          if (r.ok) { toast.success('Diperbarui'); setHEdit(null); reloadHistory() } else toast.error(r.error)
                        }} className="w-6 h-6 rounded inline-flex items-center justify-center mr-1" style={{ background: 'rgba(16,217,138,0.12)', color: '#10d98a' }}><Check size={11} /></button>
                        <button onClick={() => setHEdit(null)} className="w-6 h-6 rounded inline-flex items-center justify-center" style={{ background: 'rgba(255,255,255,0.05)', color: 'var(--text-secondary)' }}><X size={11} /></button>
                      </td>
                    </tr>
                  ) : (
                    <tr key={p.id} style={{ borderBottom: '1px solid var(--border)' }}>
                      {isBank && <td className="px-2 py-2 font-bold" style={{ color: 'var(--accent-light)' }}>#{numMap[p.id]}</td>}
                      <td className="px-2 py-2" style={{ color: 'var(--text-secondary)' }}>{formatDateTimeWIB(p.paid_at, p.paid_at)}</td>
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

      {/* ── DETAIL HUTANG SUPPLIER (per supplier) ── */}
      <Modal open={!!supDetail} onClose={() => { setSupDetailName(null); setPayId(null); setExpandNote(null) }} mobileFull title={supDetail ? `Detail Hutang Supplier — ${supDetail.supplier}` : ''} size="lg">
        {supDetail && (
          <div className="space-y-3">
            {/* Ringkasan */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <div className="rounded-xl p-3 min-w-0" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}><div className="text-[10px] uppercase" style={{ color: 'var(--text-muted)' }}>Total Hutang</div><div className="text-sm font-bold truncate" style={{ color: 'var(--text-primary)' }}>{fmt(supDetail.total)}</div></div>
              <div className="rounded-xl p-3 min-w-0" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}><div className="text-[10px] uppercase" style={{ color: 'var(--text-muted)' }}>Sudah Bayar</div><div className="text-sm font-bold truncate" style={{ color: '#10d98a' }}>{fmt(supDetail.paid)}</div></div>
              <div className="rounded-xl p-3 min-w-0" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}><div className="text-[10px] uppercase" style={{ color: 'var(--text-muted)' }}>Sisa</div><div className="text-sm font-bold truncate" style={{ color: supDetail.remaining > 0 ? '#ef4444' : '#10d98a' }}>{fmt(supDetail.remaining)}</div></div>
              <div className="rounded-xl p-3 min-w-0" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}><div className="text-[10px] uppercase" style={{ color: 'var(--text-muted)' }}>Jumlah Nota</div><div className="text-sm font-bold truncate" style={{ color: 'var(--text-primary)' }}>{supDetail.count}</div></div>
            </div>
            {supDetail.remaining > 0 && (
              <button onClick={() => { setSupDetailName(null); openFifo(supDetail.supplier) }} className="w-full h-10 rounded-xl text-sm font-semibold inline-flex items-center justify-center gap-1.5 btn-press" style={{ background: 'linear-gradient(135deg,#10d98a,#059669)', color: '#fff', fontFamily: 'Syne' }}><Wallet size={15} /> Bayar Gabungan FIFO</button>
            )}

            {/* Daftar nota */}
            <div>
              <div className="text-[11px] font-bold uppercase mb-1.5" style={{ color: 'var(--text-muted)', fontFamily: 'Syne' }}>Daftar Nota ({supDetail.notes.length})</div>
              <div className="space-y-2">
                {supDetail.notes.map(n => {
                  const rem = Math.max(0, Math.round(n.total || 0) - Math.round(n.paid || 0))
                  const overdue = n.due_date && String(n.due_date).slice(0, 10) < todayLocalStr && rem > 0
                  const status = rem <= 0 ? 'Lunas' : overdue ? 'Lewat Tempo' : 'Aktif'
                  const stColor = rem <= 0 ? '#10d98a' : overdue ? '#fb923c' : '#f59e0b'
                  return (
                    <div key={n.id} className="rounded-xl p-2.5 min-w-0" style={{ background: 'var(--bg-card)', border: `1px solid ${overdue ? 'rgba(251,146,60,0.35)' : 'var(--border)'}` }}>
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="text-xs font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{n.item || '—'} <span className="text-[10px] px-1.5 py-0.5 rounded font-bold" style={{ background: `${stColor}22`, color: stColor }}>{status}</span></div>
                          <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{formatDateTimeWIB(n.created_at, n.created_at)}{n.due_date ? ` · Tempo ${dt(n.due_date)}` : ''}</div>
                        </div>
                        <div className="flex items-center gap-1 flex-shrink-0">
                          {rem > 0 && <button onClick={() => { setPayId(payId === n.id ? null : n.id); setPayVal(String(rem)); setPayMethod('transfer'); setPayNote('') }} className="px-2 h-7 rounded-lg text-[11px] font-semibold" style={{ background: 'linear-gradient(135deg,#10d98a,#059669)', color: '#fff', fontFamily: 'Syne' }}>Bayar</button>}
                          <button onClick={() => setExpandNote(expandNote === n.id ? null : n.id)} className="w-7 h-7 rounded-lg inline-flex items-center justify-center" style={{ background: 'rgba(56,189,248,0.1)', color: '#38BDF8' }} title="Riwayat pembayaran nota ini"><BookOpen size={11} /></button>
                          <button onClick={() => setEditDebt({ id: n.id, supplier: n.supplier || '', item: n.item || '', total: String(Math.round(n.total || 0)), dueDate: n.due_date || '', note: n.note || '', method: n.payment_method || 'transfer' })} className="w-7 h-7 rounded-lg inline-flex items-center justify-center" style={{ background: 'rgba(139,92,246,0.1)', color: 'var(--accent-light)' }} title="Edit"><Pencil size={11} /></button>
                          <button onClick={async () => { if (!(await confirm({ title: 'Yakin ingin menghapus data ini?' }))) return; const r = await acc.deleteSupplierDebt(n.id); if (r.ok) { toast.success('Dihapus'); refreshSupAll(supDetail.supplier) } else toast.error(r.error) }} className="w-7 h-7 rounded-lg inline-flex items-center justify-center" style={{ background: 'rgba(255,77,106,0.08)', color: 'var(--red)' }} title="Hapus"><Trash2 size={11} /></button>
                        </div>
                      </div>
                      <div className="grid grid-cols-3 gap-2 mt-2">
                        <div className="min-w-0"><div className="text-[9px] uppercase" style={{ color: 'var(--text-muted)' }}>Nominal</div><div className="text-[11px] font-bold truncate" style={{ color: 'var(--text-primary)' }}>{fmt(n.total)}</div></div>
                        <div className="min-w-0"><div className="text-[9px] uppercase" style={{ color: 'var(--text-muted)' }}>Dibayar</div><div className="text-[11px] font-bold truncate" style={{ color: '#10d98a' }}>{fmt(n.paid)}</div></div>
                        <div className="min-w-0"><div className="text-[9px] uppercase" style={{ color: 'var(--text-muted)' }}>Sisa</div><div className="text-[11px] font-bold truncate" style={{ color: rem > 0 ? '#ef4444' : '#10d98a' }}>{fmt(rem)}</div></div>
                      </div>
                      {payId === n.id && (
                        <div className="grid grid-cols-2 gap-2 mt-2 pt-2" style={{ borderTop: '1px dashed var(--border)' }}>
                          <MoneyInput value={payVal} onChange={setPayVal} placeholder="Nominal" className="px-2 py-1.5 rounded-lg text-xs" style={inp} />
                          <select value={payMethod} onChange={e => setPayMethod(e.target.value)} className="px-2 py-1.5 rounded-lg text-xs" style={inp}>{METHODS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}</select>
                          <input value={payNote} onChange={e => setPayNote(e.target.value)} placeholder="Catatan" className="px-2 py-1.5 rounded-lg text-xs col-span-2" style={inp} />
                          <Button variant="success" size="sm" className="col-span-2" disabled={saving} onClick={async () => { if (saving) return; const amt = parseCurrency(payVal); if (!(amt > 0)) return toast.error('Nominal > 0'); setSaving(true); const r = await acc.paySupplierDebt(n.id, Math.min(amt, rem), payMethod, currentUser?.id, payNote); setSaving(false); if (r.ok) { toast.success('Dibayar'); setPayId(null); refreshSupAll(supDetail.supplier) } else toast.error(r.error) }}>Konfirmasi Bayar</Button>
                        </div>
                      )}
                      {expandNote === n.id && (() => {
                        const pays = supHist.filter(p => p.supplier_debt_id === n.id)
                        return (
                          <div className="mt-2 pt-2" style={{ borderTop: '1px dashed var(--border)' }}>
                            <div className="text-[10px] font-bold uppercase mb-1" style={{ color: 'var(--text-muted)' }}>Riwayat Pembayaran Nota Ini</div>
                            {pays.length === 0 ? <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>Belum ada pembayaran.</p>
                            : pays.map(p => (
                              <div key={p.id} className="flex items-center justify-between gap-2 text-[10px] py-0.5">
                                <span style={{ color: 'var(--text-secondary)' }}>{formatDateTimeWIB(p.paid_at, p.paid_at)} · <span className="uppercase">{p.method}</span>{p.fifo_group ? ' · FIFO' : ''}{p.note ? ` · ${p.note}` : ''}</span>
                                <span className="font-bold flex-shrink-0" style={{ color: '#10d98a' }}>{fmt(p.amount)}</span>
                              </div>
                            ))}
                          </div>
                        )
                      })()}
                    </div>
                  )
                })}
              </div>
            </div>

            {/* Riwayat pembayaran (gabungan semua nota) */}
            <div>
              <div className="text-[11px] font-bold uppercase mb-1.5" style={{ color: 'var(--text-muted)', fontFamily: 'Syne' }}>Riwayat Pembayaran</div>
              {supHistLoading ? <div className="flex justify-center py-4"><Loader2 size={16} className="animate-spin" style={{ color: 'var(--accent-light)' }} /></div>
              : supHist.length === 0 ? <p className="text-[11px] text-center py-3" style={{ color: 'var(--text-muted)' }}>Belum ada pembayaran</p>
              : (() => {
                  // Kelompokkan per fifo_group; baris tanpa group berdiri sendiri.
                  const groups = {}
                  supHist.forEach(p => { const k = p.fifo_group || `single:${p.id}`; (groups[k] || (groups[k] = [])).push(p) })
                  const list = Object.entries(groups).map(([k, rows]) => ({
                    key: k, isFifo: !k.startsWith('single:') && rows.length >= 1 && !!rows[0].fifo_group,
                    rows, amount: rows.reduce((s, r) => s + Math.round(r.amount || 0), 0),
                    date: rows[0].paid_at, method: rows[0].method, note: rows[0].note,
                  })).sort((a, b) => new Date(b.date) - new Date(a.date))
                  return (
                    <div className="space-y-1.5">
                      {list.map(grp => (
                        <div key={grp.key} className="rounded-lg p-2.5 min-w-0" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}>
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0 flex-1">
                              <div className="text-xs font-bold" style={{ color: '#10d98a' }}>{fmt(grp.amount)} <span className="text-[10px] font-normal uppercase" style={{ color: 'var(--text-muted)' }}>{grp.method}</span>{grp.isFifo && grp.rows.length > 1 && <span className="ml-1 text-[9px] px-1.5 py-0.5 rounded font-bold" style={{ background: 'rgba(56,189,248,0.15)', color: '#38BDF8' }}>FIFO · {grp.rows.length} nota</span>}</div>
                              <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{dt(grp.date)}{grp.note ? ` · ${grp.note}` : ''}</div>
                              <div className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>{grp.rows.map((r, i) => `${r.item || 'nota'}: ${fmt(r.amount)}`).join(' · ')}</div>
                            </div>
                            <div className="flex items-center gap-1 flex-shrink-0">
                              {!grp.isFifo && grp.rows.length === 1 && (
                                <button onClick={() => setHEdit({ id: grp.rows[0].id, amount: String(Math.round(grp.rows[0].amount || 0)), method: grp.rows[0].method || 'transfer', note: grp.rows[0].note || '', _sup: supDetail.supplier })} className="w-7 h-7 rounded-lg inline-flex items-center justify-center" style={{ background: 'rgba(139,92,246,0.1)', color: 'var(--accent-light)' }} title="Edit"><Pencil size={11} /></button>
                              )}
                              <button onClick={() => grp.isFifo ? deleteFifoGroup(grp.rows[0].fifo_group, supDetail.supplier) : deleteSupPayOne(grp.rows[0].id, supDetail.supplier)} className="w-7 h-7 rounded-lg inline-flex items-center justify-center" style={{ background: 'rgba(255,77,106,0.08)', color: 'var(--red)' }} title="Hapus"><Trash2 size={11} /></button>
                            </div>
                          </div>
                          {hEdit && hEdit.id === grp.rows[0].id && (
                            <div className="grid grid-cols-2 gap-2 mt-2 pt-2" style={{ borderTop: '1px dashed var(--border)' }}>
                              <MoneyInput value={hEdit.amount} onChange={v => setHEdit(p => ({ ...p, amount: v }))} placeholder="Nominal" className="px-2 py-1.5 rounded-lg text-xs" style={inp} />
                              <select value={hEdit.method} onChange={e => setHEdit(p => ({ ...p, method: e.target.value }))} className="px-2 py-1.5 rounded-lg text-xs" style={inp}>{METHODS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}</select>
                              <input value={hEdit.note} onChange={e => setHEdit(p => ({ ...p, note: e.target.value }))} placeholder="Catatan" className="px-2 py-1.5 rounded-lg text-xs col-span-2" style={inp} />
                              <Button variant="primary" size="sm" className="col-span-2" onClick={async () => { const r = await acc.editSupplierPayment(hEdit.id, { amount: parseCurrency(hEdit.amount), method: hEdit.method, note: hEdit.note }); if (r.ok) { toast.success('Pembayaran diperbarui'); setHEdit(null); refreshSupAll(supDetail.supplier) } else toast.error(r.error) }}><Check size={13} /> Simpan</Button>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )
                })()}
            </div>
          </div>
        )}
      </Modal>

      {/* ── BAYAR GABUNGAN FIFO ── */}
      <Modal open={!!fifoSup} onClose={() => setFifoSup(null)} mobileFull title={fifoSup ? `Bayar Gabungan FIFO — ${fifoSup}` : ''} size="lg">
        {fifoSup && (
          <div className="space-y-3">
            <p className="text-[11px] leading-relaxed p-2.5 rounded-lg" style={{ color: 'var(--text-secondary)', background: 'rgba(56,189,248,0.07)', border: '1px solid rgba(56,189,248,0.2)' }}>Pembayaran dialokasikan ke nota <b>jatuh tempo paling awal</b> dulu (FIFO). Sisa pembayaran lanjut ke nota berikutnya.</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field icon={Receipt} label="Tanggal Bayar"><input type="date" value={fifoForm.date} onChange={e => setFifoForm(p => ({ ...p, date: e.target.value }))} className={FIELD_CLS} style={{ ...inp, colorScheme: 'dark' }} /></Field>
              <Field icon={TrendingDown} label="Nominal Bayar"><MoneyInput value={fifoForm.amount} onChange={v => setFifoForm(p => ({ ...p, amount: v }))} placeholder="0" className={FIELD_CLS} style={inp} /></Field>
              <Field icon={Wallet} label="Metode"><select value={fifoForm.method} onChange={e => setFifoForm(p => ({ ...p, method: e.target.value }))} className={FIELD_CLS} style={inp}>{METHODS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}</select></Field>
              <Field icon={Pencil} label="Catatan"><input value={fifoForm.note} onChange={e => setFifoForm(p => ({ ...p, note: e.target.value }))} placeholder="Opsional" className={FIELD_CLS} style={inp} /></Field>
            </div>
            {/* Preview distribusi */}
            {(parseCurrency(fifoForm.amount) > 0) && (
              <div className="rounded-xl p-2.5" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}>
                <div className="text-[11px] font-bold uppercase mb-1.5" style={{ color: 'var(--text-muted)', fontFamily: 'Syne' }}>Preview Alokasi FIFO</div>
                <div className="space-y-1">
                  {fifoPreview.rows.filter(r => r.pay > 0).map(r => (
                    <div key={r.id} className="flex items-center justify-between gap-2 text-[11px]">
                      <span className="truncate min-w-0" style={{ color: 'var(--text-secondary)' }}>{r.item || 'nota'}{r.due_date ? ` (tempo ${dt(r.due_date)})` : ''}</span>
                      <span className="flex-shrink-0 font-semibold" style={{ color: r.remAfter <= 0 ? '#10d98a' : '#f59e0b' }}>{fmt(r.pay)}{r.remAfter > 0 ? ` · sisa ${fmt(r.remAfter)}` : ' · LUNAS'}</span>
                    </div>
                  ))}
                  {fifoPreview.rows.filter(r => r.pay > 0).length === 0 && <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>Tidak ada nota dengan sisa hutang.</p>}
                </div>
                <div className="flex items-center justify-between mt-2 pt-2 text-[11px]" style={{ borderTop: '1px dashed var(--border)' }}>
                  <span style={{ color: 'var(--text-muted)' }}>Terpakai: <b style={{ color: 'var(--text-primary)' }}>{fmt(fifoPreview.applied)}</b></span>
                  {fifoPreview.leftover > 0 && <span style={{ color: '#fb923c' }}>Sisa tak terpakai: {fmt(fifoPreview.leftover)}</span>}
                </div>
              </div>
            )}
            <Button variant="success" className="w-full" disabled={saving} onClick={submitFifo}>{saving ? <Loader2 size={14} className="animate-spin" /> : <Wallet size={14} />} Konfirmasi Bayar FIFO</Button>
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
      {/* ── EDIT MIGRASI DATA LAMA ── */}
      <Modal open={!!editMig} onClose={() => setEditMig(null)} title={editMig ? (editMig.type === 'old_income' ? 'Edit Pemasukan Lama' : 'Edit Pengeluaran Lama') : ''} size="sm">
        {editMig && (
          <div className="space-y-3">
            <Field icon={Receipt} label="Tanggal" required><input type="date" value={editMig.date} onChange={e => setEditMig(p => ({ ...p, date: e.target.value }))} className={FIELD_CLS} style={{ ...inp, colorScheme: 'dark' }} /></Field>
            <Field icon={editMig.type === 'old_income' ? UsersIcon : Receipt} label={editMig.type === 'old_income' ? 'Nama / Sumber Pemasukan' : 'Kategori Pengeluaran'} required>
              {editMig.type === 'old_income'
                ? <input value={editMig.name} onChange={e => setEditMig(p => ({ ...p, name: e.target.value }))} className={FIELD_CLS} style={inp} />
                : <Combo value={editMig.name} onChange={v => setEditMig(p => ({ ...p, name: v }))} options={catOptions} baseStyle={inp} errStyle={inpErr(true)} placeholder="Pilih / cari kategori" allowCreate onCreate={async (name) => { const r = await acc.addExpenseCategory(name); if (r.ok) loadExpCats() }} />}
            </Field>
            {editMig.type === 'old_income' && <Field icon={UsersIcon} label="Customer" hint="Opsional"><input value={editMig.customer || ''} onChange={e => setEditMig(p => ({ ...p, customer: e.target.value }))} className={FIELD_CLS} style={inp} /></Field>}
            <Field icon={editMig.type === 'old_income' ? TrendingUp : TrendingDown} label="Nominal" required><MoneyInput value={editMig.amount} onChange={v => setEditMig(p => ({ ...p, amount: v }))} className={FIELD_CLS} style={inp} /></Field>
            <Field icon={Wallet} label="Metode Pembayaran"><select value={editMig.method} onChange={e => setEditMig(p => ({ ...p, method: e.target.value }))} className={FIELD_CLS} style={inp}>{METHODS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}</select></Field>
            <Field icon={Pencil} label="Catatan"><input value={editMig.note} onChange={e => setEditMig(p => ({ ...p, note: e.target.value }))} className={FIELD_CLS} style={inp} /></Field>
            <Button variant="primary" className="w-full" disabled={saving} onClick={async () => {
              if (!editMig.name.trim()) return toast.error('Nama / kategori wajib diisi')
              if (!(parseCurrency(editMig.amount) > 0)) return toast.error('Nominal harus lebih dari 0')
              setSaving(true)
              const r = await acc.updateMigrationDetail(editMig.id, { ...editMig, amount: parseCurrency(editMig.amount) })
              setSaving(false)
              if (r.ok) { toast.success('Data migrasi diperbarui'); setEditMig(null); loadMig(); loadDashboard() } else toast.error(r.error)
            }}><Check size={14} /> Simpan</Button>
          </div>
        )}
      </Modal>

      {/* ── RINCIAN SALDO / TOTAL ASET / KEKAYAAN (breakdown) ── */}
      <Modal open={!!infoModal} onClose={() => setInfoModal(null)} title={infoModal ? infoModal.title : ''} size="sm">
        {infoModal && (
          <div className="space-y-1.5">
            {infoModal.rows.map(([label, val, neg], i) => (
              <div key={i} className="flex justify-between items-center py-1.5 text-sm" style={{ borderBottom: '1px solid var(--border)' }}>
                <span style={{ color: 'var(--text-secondary)' }}>{label}</span>
                <span className="font-semibold" style={{ color: neg ? '#ef4444' : 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>{neg ? '−' : ''}{fmt(val)}</span>
              </div>
            ))}
            <div className="flex justify-between items-center py-2 mt-1" style={{ borderTop: '2px solid var(--border-strong)' }}>
              <span className="font-bold" style={{ color: 'var(--text-primary)', fontFamily: 'Syne' }}>{infoModal.total[0]}</span>
              <span className="font-extrabold" style={{ color: infoModal.total[1] >= 0 ? '#10d98a' : '#ef4444', fontFamily: 'Syne', fontVariantNumeric: 'tabular-nums' }}>{fmt(infoModal.total[1])}</span>
            </div>
            {infoModal.note && <p className="text-[11px] mt-2 leading-relaxed" style={{ color: 'var(--text-muted)' }}>{infoModal.note}</p>}
          </div>
        )}
      </Modal>

      {/* ── DETAIL ARUS KAS BERSIH (masuk + keluar, filter waktu) ── */}
      <ArusKasDetail
        open={arusKasOpen}
        onClose={() => setArusKasOpen(false)}
        loadCashflow={acc.getCashflowDetail}
        onInvoiceClick={(inv) => invoicePreview.openInvoice(inv)}
      />

      {/* ── DETAIL SALDO (KAS & BANK): per metode + histori mutasi ── */}
      <SaldoDetail
        open={saldoDetailOpen}
        onClose={() => setSaldoDetailOpen(false)}
        d={d}
        loadCashflow={acc.getCashflowDetail}
        onInvoiceClick={(inv) => invoicePreview.openInvoice(inv)}
      />

      {/* ── EDIT PIUTANG CUSTOMER LAMA ── */}
      <Modal open={!!editRecv} onClose={() => setEditRecv(null)} title="Edit Piutang Customer Lama" size="sm">
        {editRecv && (
          <div className="space-y-3">
            <Field icon={Receipt} label="Tanggal" required><input type="date" value={editRecv.date} onChange={e => setEditRecv(p => ({ ...p, date: e.target.value }))} className={FIELD_CLS} style={{ ...inp, colorScheme: 'dark' }} /></Field>
            <Field icon={UsersIcon} label="Nama Customer"><input value={editRecv.customerName} disabled className={FIELD_CLS} style={{ ...inp, opacity: 0.7 }} /></Field>
            <Field icon={Wallet} label="Nominal Piutang" required><MoneyInput value={editRecv.amount} onChange={v => setEditRecv(p => ({ ...p, amount: v }))} className={FIELD_CLS} style={inp} /></Field>
            <Field icon={Receipt} label="Jatuh Tempo"><input type="date" value={editRecv.dueDate} onChange={e => setEditRecv(p => ({ ...p, dueDate: e.target.value }))} className={FIELD_CLS} style={{ ...inp, colorScheme: 'dark' }} /></Field>
            <Field icon={Pencil} label="Catatan"><input value={editRecv.note} onChange={e => setEditRecv(p => ({ ...p, note: e.target.value }))} className={FIELD_CLS} style={inp} /></Field>
            <Button variant="primary" className="w-full" disabled={saving} onClick={async () => {
              if (!(parseCurrency(editRecv.amount) > 0)) return toast.error('Nominal harus lebih dari 0')
              setSaving(true)
              const r = await acc.editOldReceivable(editRecv.id, { date: editRecv.date, amount: parseCurrency(editRecv.amount), dueDate: editRecv.dueDate, note: editRecv.note })
              setSaving(false)
              if (r.ok) { toast.success('Piutang lama diperbarui'); setEditRecv(null); loadMig(); loadDashboard() } else toast.error(r.error)
            }}><Check size={14} /> Simpan</Button>
          </div>
        )}
      </Modal>

      {/* ── EDIT KASBON KARYAWAN LAMA ── */}
      <Modal open={!!editOldKas} onClose={() => setEditOldKas(null)} title="Edit Kasbon Karyawan Lama" size="sm">
        {editOldKas && (
          <div className="space-y-3">
            <Field icon={Receipt} label="Tanggal" required><input type="date" value={editOldKas.date} onChange={e => setEditOldKas(p => ({ ...p, date: e.target.value }))} className={FIELD_CLS} style={{ ...inp, colorScheme: 'dark' }} /></Field>
            <Field icon={UsersIcon} label="Nama Karyawan" required><input value={editOldKas.employeeName} onChange={e => setEditOldKas(p => ({ ...p, employeeName: e.target.value }))} className={FIELD_CLS} style={inp} /></Field>
            <Field icon={TrendingDown} label="Nominal Kasbon" required><MoneyInput value={editOldKas.amount} onChange={v => setEditOldKas(p => ({ ...p, amount: v }))} className={FIELD_CLS} style={inp} /></Field>
            <Field icon={Receipt} label="Jatuh Tempo"><input type="date" value={editOldKas.dueDate} onChange={e => setEditOldKas(p => ({ ...p, dueDate: e.target.value }))} className={FIELD_CLS} style={{ ...inp, colorScheme: 'dark' }} /></Field>
            <Field icon={Wallet} label="Metode Pencairan"><select value={editOldKas.method} onChange={e => setEditOldKas(p => ({ ...p, method: e.target.value }))} className={FIELD_CLS} style={inp}><option value="cash">Cash</option><option value="transfer">Transfer</option></select></Field>
            <Field icon={Pencil} label="Catatan"><input value={editOldKas.note} onChange={e => setEditOldKas(p => ({ ...p, note: e.target.value }))} className={FIELD_CLS} style={inp} /></Field>
            <Button variant="primary" className="w-full" disabled={saving} onClick={async () => {
              if (!editOldKas.employeeName.trim()) return toast.error('Nama karyawan wajib diisi')
              if (!(parseCurrency(editOldKas.amount) > 0)) return toast.error('Nominal harus lebih dari 0')
              setSaving(true)
              const r = await acc.editEmployeeAdvance(editOldKas.id, { employeeName: editOldKas.employeeName, amount: parseCurrency(editOldKas.amount), date: editOldKas.date, dueDate: editOldKas.dueDate, method: editOldKas.method, note: editOldKas.note })
              setSaving(false)
              if (r.ok) { toast.success('Kasbon lama diperbarui'); setEditOldKas(null); loadMig(); loadDashboard() } else toast.error(r.error)
            }}><Check size={14} /> Simpan</Button>
          </div>
        )}
      </Modal>

      <Modal open={!!detail} onClose={() => setDetail(null)} title={detail ? `Detail — ${detail.title}` : ''} size="lg">
        {detail && (() => {
          if (detail.loading) return <div className="flex justify-center py-8"><Loader2 size={18} className="animate-spin" style={{ color: 'var(--accent-light)' }} /></div>
          const allRows = detail.rows || []
          const isOutflow = detail.kind === 'uang_keluar'
          // Filter sumber (khusus Uang Keluar)
          const SRC_FILTERS = [
            ['all', 'Semua'], ['Pengeluaran', 'Pengeluaran'], ['Hutang Bank', 'Hutang Bank'],
            ['Hutang Supplier', 'Hutang Supplier'], ['Sewa', 'Sewa'], ['Migrasi Data', 'Migrasi Data'],
            ['Pembelian', 'Pembelian'], ['Kasbon Karyawan', 'Kasbon'],
          ]
          const shown = isOutflow && detailSrc !== 'all' ? allRows.filter(r => r.source === detailSrc) : allRows
          const shownTotal = shown.reduce((s, r) => s + (r.amount || 0), 0)
          const dupCount = allRows.filter(r => r.dupSuspect).length
          const periodLabel = detail.allTime ? 'Semua waktu (semua data)' : `${dt(detail.from || from)} – ${dt(detail.to || to)}`
          return (
            <div>
              <div className="flex items-center justify-between flex-wrap gap-2 mb-2">
                <p className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>Periode: <b style={{ color: 'var(--text-primary)' }}>{periodLabel}</b></p>
                {isOwner && dupCount > 0 && <span className="text-[10px] px-2 py-1 rounded-lg font-bold inline-flex items-center gap-1" style={{ background: 'rgba(245,158,11,0.12)', color: '#f59e0b', border: '1px solid rgba(245,158,11,0.3)' }}><AlertTriangle size={11} /> {dupCount} baris potensi double</span>}
              </div>
              {isOutflow && (
                <div className="flex items-center gap-1.5 flex-wrap mb-3">
                  {SRC_FILTERS.map(([val, label]) => {
                    const active = detailSrc === val
                    return <button key={val} onClick={() => setDetailSrc(val)} className="text-[11px] px-2.5 py-1 rounded-lg font-semibold btn-press" style={{ background: active ? 'var(--accent)' : 'var(--bg-elevated)', color: active ? '#fff' : 'var(--text-secondary)', border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`, fontFamily: 'Syne' }}>{label}</button>
                  })}
                </div>
              )}
              {shown.length === 0 ? <p className="text-xs text-center py-6" style={{ color: 'var(--text-muted)' }}>Tidak ada data (data yang dihapus tidak ditampilkan).</p>
              : <div>
              <div className="overflow-x-auto -mx-1">
                <table className="w-full text-xs" style={{ borderCollapse: 'collapse', minWidth: 620 }}>
                  <thead><tr style={{ borderBottom: '1px solid var(--border)' }}>{['Tanggal', 'Sumber', 'Kategori', 'Metode', 'Status', 'Nominal', ''].map((h, i) => <th key={i} className={`px-2 py-2 ${h === 'Nominal' ? 'text-right' : 'text-left'}`} style={{ color: 'var(--text-muted)', fontFamily: 'Syne', fontSize: 10 }}>{h}</th>)}</tr></thead>
                  <tbody>
                    {shown.map((row, i) => {
                      const editable = ['expense', 'purchase', 'supplier_payment', 'bank_payment', 'supplier_debt', 'bank_loan', 'kasbon', 'rent', 'migration'].includes(row.kind)
                      const canEdit = ['expense', 'purchase', 'supplier_debt'].includes(row.kind)
                      const kategori = row.category || row.ref || row.party || row.source
                      return (
                        <tr key={row.kind + row.id + i} style={{ borderBottom: '1px solid var(--border)' }}>
                          <td className="px-2 py-2 whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>{dt(row.date)}</td>
                          <td className="px-2 py-2" style={{ color: 'var(--text-primary)' }}>
                            <span className="inline-flex items-center gap-1 flex-wrap">
                              {row.kind === 'migration' ? <span className="text-[9px] px-1.5 py-0.5 rounded font-bold" style={{ background: 'rgba(167,139,250,0.18)', color: '#a78bfa' }}>Migrasi Data</span> : row.source}
                              {isOwner && row.dupSuspect && <span className="text-[9px] px-1.5 py-0.5 rounded font-bold inline-flex items-center gap-0.5" style={{ background: 'rgba(245,158,11,0.15)', color: '#f59e0b' }} title="Tanggal & nominal sama dengan baris lain — periksa pencatatan ganda">⚠️ double</span>}
                            </span>
                          </td>
                          <td className="px-2 py-2 truncate" style={{ color: 'var(--text-muted)', maxWidth: 160 }}>{kategori || '—'}{row.party && row.party !== kategori ? <span style={{ opacity: 0.6 }}> · {row.party}</span> : null}</td>
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
                  <tfoot><tr style={{ borderTop: '2px solid var(--border)' }}><td colSpan={5} className="px-2 py-2.5 font-bold" style={{ color: 'var(--text-primary)', fontFamily: 'Syne' }}>TOTAL ({shown.length} baris{isOutflow && detailSrc !== 'all' ? ` · filter: ${detailSrc}` : ''})</td><td className="px-2 py-2.5 text-right font-extrabold whitespace-nowrap" style={{ color: detail.color, fontFamily: 'Syne', fontVariantNumeric: 'tabular-nums' }}>{fmt(shownTotal)}</td><td /></tr></tfoot>
                </table>
              </div>
              <p className="text-[11px] mt-3" style={{ color: 'var(--text-muted)' }}>{isOutflow && detailSrc !== 'all' ? <>Total semua sumber: <b style={{ color: 'var(--text-primary)' }}>{fmt(detail.total)}</b>. </> : null}Total keseluruhan sama dengan angka di card. Tiap sumber dihitung sekali (anti double-count). Data terhapus/cancel tidak dihitung. Edit/Hapus langsung memperbarui dashboard.</p>
            </div>}
            </div>
          )
        })()}
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
