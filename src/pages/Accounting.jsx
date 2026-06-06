import React, { useEffect, useMemo, useState } from 'react'
import {
  Loader2, TrendingUp, TrendingDown, Wallet, Landmark, Scale, Receipt,
  ShoppingCart, BookOpen, Plus, Trash2, AlertTriangle, RefreshCw, Truck,
  FileSpreadsheet, Users as UsersIcon, Building2, Pencil, Check, X,
} from 'lucide-react'
import { formatRupiah, formatCurrency, parseCurrency } from '../utils/helpers'
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
]
const METHODS = [{ id: 'cash', label: 'Cash' }, { id: 'transfer', label: 'Transfer' }, { id: 'qris', label: 'QRIS' }]
const EXP_CATEGORIES = ['Pembelian Bahan', 'Gaji', 'Listrik', 'Internet', 'Transport', 'Sewa', 'Konsumsi', 'Perawatan Mesin', 'Pengeluaran Lainnya']
const fmt = (n) => formatRupiah(Math.round(Number(n) || 0))
const dt = (d) => (d ? new Date(d).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' }) : '—')
// Input uang: hanya angka + titik ribuan
function MoneyInput({ value, onChange, placeholder, className, style }) {
  return <input inputMode="numeric" value={formatCurrency(value)} placeholder={placeholder}
    onChange={(e) => onChange(String(parseCurrency(e.target.value)))} className={className} style={style} />
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

function Card({ icon: Icon, label, value, color = '#38BDF8', sub, onClick }) {
  return (
    <div onClick={onClick} className={`rounded-2xl p-4 ${onClick ? 'cursor-pointer hover:brightness-110 transition' : ''}`} style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
      <div className="flex items-center gap-2 mb-2">
        <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: `${color}1f`, border: `1px solid ${color}44` }}><Icon size={15} style={{ color }} /></div>
        <span className="text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>{label}</span>
      </div>
      <div className="font-bold truncate" style={{ fontFamily: 'Syne', color, fontVariantNumeric: 'tabular-nums', fontSize: 'clamp(15px,4.2vw,20px)' }}>{value}</div>
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
  const [supErr, setSupErr] = useState({}); const [sdErr, setSdErr] = useState({}); const [loanErr, setLoanErr] = useState({})
  const [bpay, setBpay] = useState(null) // {loanId, amount, pokok, bunga, method}
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
  const loadPurchases = async () => { const r = await acc.listPurchases({}); if (r.ok) setPurchases(r.data) }
  const loadSuppliers = async () => { const r = await acc.listSuppliers(supSearch); if (r.ok) setSuppliers(r.data) }
  const loadSupDebts = async () => { const r = await acc.listSupplierDebts(); if (r.ok) setSupDebts(r.data) }
  const loadBankLoans = async () => { const r = await acc.listBankLoans(); if (r.ok) setBankLoans(r.data) }
  const loadRecap = async () => { const r = await acc.getRecapAdmin(from, to); if (r.ok) setRecap(r.data) }

  useEffect(() => {
    setLoading(true)
    const run = async () => {
      if (tab === 'ringkasan') { await loadDashboard(); await loadRecap() }
      else if (tab === 'jurnal') await loadEntries(0)
      else if (tab === 'pengeluaran') await loadExpenses()
      else if (tab === 'pembelian') { await loadPurchases(); await loadSuppliers() }
      else if (tab === 'supplier') await loadSuppliers()
      else if (tab === 'hsupplier') await loadSupDebts()
      else if (tab === 'hbank') await loadBankLoans()
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
  const laba = useMemo(() => d ? Math.round((d.penjualan || 0) - (d.pengeluaran_total || 0)) : 0, [d])
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
      if (d) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(Object.entries(d).map(([k, v]) => ({ Pos: k, Nilai: Math.round(Number(v) || 0) })).concat([{ Pos: 'laba_bersih', Nilai: laba }])), 'Ringkasan')
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
    if (!expForm.category) e.category = 'Kategori wajib dipilih'
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
              <div className="text-[11px] mt-1.5" style={{ color: 'var(--text-muted)', fontFamily: "'Inter', sans-serif" }}>Penjualan {fmt(d.penjualan)} − Total Pengeluaran {fmt(d.pengeluaran_total)}</div>
            </div>
          )}

          {/* BARIS 2: Penjualan · Uang Masuk · Uang Keluar · Beban */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <Card icon={Wallet} label="Penjualan / Omzet" value={fmt(d.penjualan)} color="#38BDF8" sub="Total invoice valid" onClick={() => openDetail('penjualan', 'Penjualan / Omzet', '#38BDF8')} />
            <Card icon={TrendingUp} label="Uang Masuk" value={fmt(d.uang_masuk_total)} color="#10d98a" sub="Yang benar-benar diterima" onClick={() => openDetail('uang_masuk', 'Uang Masuk', '#10d98a')} />
            <Card icon={TrendingDown} label="Uang Keluar" value={fmt(d.pengeluaran_total)} color="#ef4444" sub="Semua pembayaran keluar" onClick={() => openDetail('uang_keluar', 'Uang Keluar', '#ef4444')} />
            <Card icon={Receipt} label="Beban (Op+Gaji+Bunga)" value={fmt((d.operasional || 0) + (d.gaji || 0) + (d.beban_bunga || 0))} color="#f59e0b" onClick={() => openDetail('beban', 'Beban (Operasional+Gaji+Bunga)', '#f59e0b')} />
          </div>

          {/* BARIS 3: Arus Kas Bersih · Piutang Usaha · Hutang Supplier · Hutang Bank */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <Card icon={Scale} label="Arus Kas Bersih" value={fmt((d.uang_masuk_total || 0) - (d.pengeluaran_total || 0))} color={(d.uang_masuk_total - d.pengeluaran_total) >= 0 ? '#10d98a' : '#ef4444'} sub="Uang Masuk − Uang Keluar" onClick={() => openDetail('arus_kas', 'Arus Kas Bersih', '#10d98a')} />
            <Card icon={TrendingUp} label="Piutang Usaha" value={fmt(d.piutang_aktif)} color="#f59e0b" onClick={() => openDetail('piutang', 'Piutang Usaha (Aktif)', '#f59e0b')} />
            <Card icon={TrendingDown} label="Hutang Supplier" value={fmt(d.hutang_supplier)} color="#fb923c" onClick={() => openDetail('hutang_supplier', 'Hutang Supplier', '#fb923c')} />
            <Card icon={Building2} label="Hutang Bank" value={fmt(d.hutang_bank)} color="#ef4444" sub={`${d.pinjaman_aktif || 0} pinjaman aktif · cicilan ${fmt(d.cicilan_bank)}`} onClick={() => openDetail('hutang_bank', 'Hutang Bank', '#ef4444')} />
          </div>

          {/* BARIS 4: Sudah Bayar Piutang · Persediaan */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <Card icon={TrendingUp} label="Sudah Bayar (Piutang)" value={fmt(d.sudah_bayar)} color="#10d98a" onClick={() => openDetail('sudah_bayar', 'Sudah Bayar (Piutang)', '#10d98a')} />
            <Card icon={ShoppingCart} label="Persediaan" value={fmt(d.persediaan)} color="#a78bfa" onClick={() => openDetail('persediaan', 'Persediaan', '#a78bfa')} />
          </div>

          {/* Neraca sederhana — OWNER ONLY (data ekuitas sensitif) */}
          {isOwner && (
          <div className="rounded-2xl p-4" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
            <div className="text-xs font-bold uppercase tracking-wider mb-3" style={{ color: 'var(--accent-light)', fontFamily: 'Syne' }}>Neraca Sederhana (s/d {dt(to)})</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
              <div>
                <div className="font-bold mb-1" style={{ color: 'var(--text-secondary)' }}>Aset</div>
                {[['Kas', d.saldo_kas], ['Bank', d.saldo_rekening], ['Piutang Usaha', d.piutang_aktif], ['Persediaan', d.persediaan]].map(([k, v]) => <div key={k} className="flex justify-between py-0.5" style={{ color: 'var(--text-muted)' }}><span>{k}</span><span style={{ color: 'var(--text-primary)' }}>{fmt(v)}</span></div>)}
                <div className="flex justify-between py-1 mt-1 font-bold" style={{ borderTop: '1px solid var(--border)', color: 'var(--text-primary)' }}><span>Total Aset</span><span>{fmt(totalAset)}</span></div>
              </div>
              <div>
                <div className="font-bold mb-1" style={{ color: 'var(--text-secondary)' }}>Kewajiban & Ekuitas</div>
                <div className="flex justify-between py-0.5" style={{ color: 'var(--text-muted)' }}><span>Hutang Supplier</span><span style={{ color: 'var(--text-primary)' }}>{fmt(d.hutang_supplier)}</span></div>
                <div className="flex justify-between py-0.5" style={{ color: 'var(--text-muted)' }}><span>Hutang Bank</span><span style={{ color: 'var(--text-primary)' }}>{fmt(d.hutang_bank)}</span></div>
                <div className="flex justify-between py-0.5" style={{ color: 'var(--text-muted)' }}><span>Ekuitas (penyeimbang)</span><span style={{ color: 'var(--text-primary)' }}>{fmt(totalAset - totalHutang)}</span></div>
                <div className="flex justify-between py-1 mt-1 font-bold" style={{ borderTop: '1px solid var(--border)', color: 'var(--text-primary)' }}><span>Total</span><span>{fmt(totalAset)}</span></div>
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
            <Field icon={BookOpen} label="Kategori" required error={expErr.category}>
              <select value={expForm.category} onChange={e => setExpForm(p => ({ ...p, category: e.target.value }))} className={FIELD_CLS} style={inpErr(expErr.category)}>{EXP_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}</select>
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
            <Field icon={UsersIcon} label="Supplier" required error={sdErr.supplier}>
              <input value={sdForm.supplier} onChange={e => setSdForm(p => ({ ...p, supplier: e.target.value }))} placeholder="Nama supplier" className={FIELD_CLS} style={inpErr(sdErr.supplier)} />
            </Field>
            <Field icon={ShoppingCart} label="Barang" required error={sdErr.item}>
              <input value={sdForm.item} onChange={e => setSdForm(p => ({ ...p, item: e.target.value }))} placeholder="Nama barang / bahan" className={FIELD_CLS} style={inpErr(sdErr.item)} />
            </Field>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field icon={TrendingDown} label="Total Hutang" required error={sdErr.total}>
                <MoneyInput value={sdForm.total} onChange={v => setSdForm(p => ({ ...p, total: v }))} placeholder="0" className={FIELD_CLS} style={inpErr(sdErr.total)} />
              </Field>
              <Field icon={Receipt} label="Jatuh Tempo">
                <input type="date" value={sdForm.dueDate} onChange={e => setSdForm(p => ({ ...p, dueDate: e.target.value }))} className={FIELD_CLS} style={{ ...inp, colorScheme: 'dark' }} />
              </Field>
            </div>
            <Button variant="primary" className="w-full" disabled={saving} onClick={async () => {
              const e = {}; if (!sdForm.supplier.trim()) e.supplier = 'Supplier wajib diisi'; if (!sdForm.item.trim()) e.item = 'Barang wajib diisi'; if (!(parseCurrency(sdForm.total) > 0)) e.total = 'Total harus lebih dari 0'
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
                <MoneyInput value={loanForm.plafon} onChange={v => setLoanForm(p => ({ ...p, plafon: v, sisaPokok: p.sisaPokok || v }))} placeholder="0" className={FIELD_CLS} style={inpErr(loanErr.plafon)} />
              </Field>
              <Field icon={TrendingDown} label="Sisa Pokok" hint="Default = plafon">
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
                    <div className="flex-1 min-w-0"><div className="text-xs font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{x.nama_bank} <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>· {x.jenis_pinjaman}</span></div>
                      <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>Plafon {fmt(x.plafon_pinjaman)} · Cicilan {fmt(x.cicilan_bulanan)}/bln {x.tanggal_jatuh_tempo ? `· Tempo ${dt(x.tanggal_jatuh_tempo)}` : ''}</div>
                      {overdue7 && <div className="text-[11px] font-bold mt-0.5" style={{ color: '#f59e0b' }}>⏰ Cicilan {x.nama_bank} jatuh tempo dalam 7 hari</div>}
                    </div>
                    <div className="text-right"><div className="text-[10px] uppercase" style={{ color: 'var(--text-muted)' }}>Sisa Pokok</div><div className="text-sm font-bold" style={{ color: x.sisa_pokok > 0 ? '#ef4444' : '#10d98a' }}>{fmt(x.sisa_pokok)}</div></div>
                    {x.sisa_pokok > 0 && <button onClick={async () => {
                      if (bpay?.loanId === x.id) { setBpay(null); return }
                      const h = await acc.listBankPayments(x.id)
                      const n = (h.ok ? h.data.length : 0) + 1
                      setBpay({ loanId: x.id, amount: String(Math.round(x.cicilan_bulanan || 0)), method: 'transfer', note: '', paymentNumber: n, sisa: Math.round(x.sisa_pokok || 0) })
                    }} className="px-2.5 h-8 rounded-lg text-xs font-semibold" style={{ background: 'linear-gradient(135deg,#10d98a,#059669)', color: '#fff', fontFamily: 'Syne' }}>Bayar</button>}
                    <button onClick={() => openHistory('bank', { id: x.id, title: `${x.nama_bank} · ${x.jenis_pinjaman}`, bank: x.nama_bank, jenis: x.jenis_pinjaman })} className="w-8 h-8 rounded-lg inline-flex items-center justify-center" style={{ background: 'rgba(56,189,248,0.1)', color: '#38BDF8' }} title="Riwayat Pembayaran"><BookOpen size={11} /></button>
                    <button onClick={async () => { if (!(await confirm())) return; const r = await acc.deleteBankLoan(x.id); if (r.ok) { toast.success('Dihapus'); loadBankLoans(); loadDashboard() } else toast.error(r.error) }} className="w-8 h-8 rounded-lg inline-flex items-center justify-center" style={{ background: 'rgba(255,77,106,0.08)', color: 'var(--red)' }}><Trash2 size={11} /></button>
                  </div>
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
            <Field icon={BookOpen} label="Kategori" required><select value={editExp.category} onChange={e => setEditExp(p => ({ ...p, category: e.target.value }))} className={FIELD_CLS} style={inp}>{EXP_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}</select></Field>
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
