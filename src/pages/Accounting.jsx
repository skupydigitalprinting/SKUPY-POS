import React, { useEffect, useMemo, useState } from 'react'
import {
  Loader2, TrendingUp, TrendingDown, Wallet, Landmark, Scale, Receipt,
  ShoppingCart, BookOpen, Plus, Trash2, AlertTriangle, RefreshCw, Truck,
  FileSpreadsheet, Users as UsersIcon, Building2, Pencil, Check, X,
} from 'lucide-react'
import { formatRupiah, formatCurrency, parseCurrency } from '../utils/helpers'
import { Button } from '../components/ui'
import { useToast } from '../components/Toast'
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

function Card({ icon: Icon, label, value, color = '#38BDF8', sub }) {
  return (
    <div className="rounded-2xl p-4" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
      <div className="flex items-center gap-2 mb-2">
        <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: `${color}1f`, border: `1px solid ${color}44` }}><Icon size={15} style={{ color }} /></div>
        <span className="text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>{label}</span>
      </div>
      <div className="text-lg font-bold truncate" style={{ fontFamily: 'Syne', color, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      {sub && <div className="text-[11px] mt-0.5 truncate" style={{ color: 'var(--text-muted)' }}>{sub}</div>}
    </div>
  )
}

export default function Accounting({ admins = [], currentUser, setActivePage } = {}) {
  const toast = useToast()
  const acc = useAccounting()
  const [tab, setTab] = useState('ringkasan')
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

  // forms
  const [expForm, setExpForm] = useState({ date: acc.todayISO(), category: 'Pembelian Bahan', amount: '', method: 'cash', note: '' })
  const [purForm, setPurForm] = useState({ date: acc.todayISO(), supplier: '', item: '', qty: '', harga: '', paid: '', method: 'cash', note: '' })
  const [supForm, setSupForm] = useState({ id: null, name: '', phone: '', address: '', note: '' })
  const [sdForm, setSdForm] = useState({ supplier: '', item: '', total: '', dueDate: '' })
  const [payId, setPayId] = useState(null); const [payVal, setPayVal] = useState(''); const [payMethod, setPayMethod] = useState('cash')
  const [loanForm, setLoanForm] = useState({ namaBank: '', jenis: 'KPR', nomor: '', mulai: '', jatuhTempo: '', plafon: '', sisaPokok: '', bunga: '', cicilan: '', keterangan: '' })
  const [bpay, setBpay] = useState(null) // {loanId, amount, pokok, bunga, method}

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

  // Auto-refresh ringkasan realtime
  useEffect(() => {
    if (tab !== 'ringkasan') return
    const t = setInterval(loadDashboard, 15000)
    const onVis = () => { if (document.visibilityState === 'visible') loadDashboard() }
    document.addEventListener('visibilitychange', onVis)
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVis) }
    /* eslint-disable-next-line */
  }, [tab, from, to])

  const laba = useMemo(() => d ? Math.round((d.penjualan || 0) - (d.modal_barang || 0) - (d.operasional || 0) - (d.gaji || 0) - (d.beban_bunga || 0)) : 0, [d])
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
  const lastPage = Math.max(0, Math.ceil(entCount / acc.PAGE_SIZE) - 1)

  // ── submit handlers ──
  const submitExpense = async () => {
    if (!(parseCurrency(expForm.amount) > 0)) return toast.error('Nominal harus > 0')
    setSaving(true); const r = await acc.addExpense({ ...expForm, amount: parseCurrency(expForm.amount), cashierId: currentUser?.id }); setSaving(false)
    if (r.ok) { toast.success('Pengeluaran dicatat'); setExpForm({ date: acc.todayISO(), category: 'Pembelian Bahan', amount: '', method: 'cash', note: '' }); loadExpenses() } else toast.error(r.error || 'Gagal')
  }
  const submitPurchase = async () => {
    const qty = Number(parseCurrency(purForm.qty)) || 0
    const harga = parseCurrency(purForm.harga)
    const total = qty > 0 ? qty * harga : harga
    const paid = Math.min(parseCurrency(purForm.paid || (purForm.method === 'hutang' ? '0' : String(total))), total)
    const sisa = Math.max(0, total - paid)
    if (total <= 0) return toast.error('Total pembelian harus > 0')
    setSaving(true)
    try {
      if (paid > 0) { const r = await acc.addPurchase({ date: purForm.date, supplier: purForm.supplier, item: purForm.item, qty, amount: paid, method: purForm.method === 'hutang' ? 'cash' : purForm.method, isCredit: false, note: purForm.note }); if (!r.ok) { toast.error(r.error); setSaving(false); return } }
      if (sisa > 0) { const r2 = await acc.addSupplierDebt({ supplier: purForm.supplier, item: purForm.item, total: sisa, dueDate: null, note: purForm.note }); if (!r2.ok) { toast.error(r2.error); setSaving(false); return } }
      toast.success('Pembelian dicatat'); setPurForm({ date: acc.todayISO(), supplier: '', item: '', qty: '', harga: '', paid: '', method: 'cash', note: '' }); loadPurchases()
    } finally { setSaving(false) }
  }
  const saveSupplier = async () => {
    if (!supForm.name.trim()) return toast.error('Nama supplier wajib')
    setSaving(true)
    const r = supForm.id ? await acc.updateSupplier(supForm.id, supForm) : await acc.addSupplier(supForm)
    setSaving(false)
    if (r.ok) { toast.success('Supplier disimpan'); setSupForm({ id: null, name: '', phone: '', address: '', note: '' }); loadSuppliers() } else toast.error(r.error || 'Gagal')
  }
  const submitLoan = async () => {
    if (!loanForm.namaBank.trim()) return toast.error('Nama bank wajib')
    if (!(parseCurrency(loanForm.plafon) > 0)) return toast.error('Plafon harus > 0')
    setSaving(true); const r = await acc.addBankLoan(loanForm); setSaving(false)
    if (r.ok) { toast.success('Hutang bank dicatat'); setLoanForm({ namaBank: '', jenis: 'KPR', nomor: '', mulai: '', jatuhTempo: '', plafon: '', sisaPokok: '', bunga: '', cicilan: '', keterangan: '' }); loadBankLoans() } else toast.error(r.error || 'Gagal')
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
      <div className="flex gap-1 mb-4 flex-wrap">
        {TABS.map(t => { const Icon = t.icon; const a = tab === t.id; return (
          <button key={t.id} onClick={() => setTab(t.id)} className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold transition-all"
            style={{ background: a ? 'linear-gradient(135deg, var(--accent), #6366f1)' : 'var(--bg-card)', color: a ? '#fff' : 'var(--text-secondary)', border: `1px solid ${a ? 'transparent' : 'var(--border)'}`, fontFamily: 'Syne' }}><Icon size={12} /> {t.label}</button>
        )})}
      </div>

      {loading && <div className="flex items-center justify-center py-8"><Loader2 size={20} className="animate-spin" style={{ color: 'var(--accent-light)' }} /></div>}

      {/* ── RINGKASAN ── */}
      {tab === 'ringkasan' && !loading && d && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Card icon={TrendingUp} label="Uang Masuk (Arus Kas)" value={fmt(d.uang_masuk_total)} color="#10d98a" />
            <Card icon={TrendingDown} label="Uang Keluar" value={fmt(d.pengeluaran_total)} color="#ef4444" />
            <Card icon={Wallet} label="Penjualan" value={fmt(d.penjualan)} color="#38BDF8" />
            <Card icon={Receipt} label="Beban (Op+Gaji+Bunga)" value={fmt((d.operasional || 0) + (d.gaji || 0) + (d.beban_bunga || 0))} color="#f59e0b" />
          </div>
          <div className="rounded-2xl p-4" style={{ background: laba >= 0 ? 'rgba(167,139,250,0.10)' : 'rgba(239,68,68,0.10)', border: `1px solid ${laba >= 0 ? 'rgba(167,139,250,0.35)' : 'rgba(239,68,68,0.35)'}` }}>
            <div className="flex justify-between items-center flex-wrap gap-2">
              <div><div className="text-xs font-bold uppercase tracking-wider" style={{ color: 'var(--text-muted)', fontFamily: 'Syne' }}>Laba Bersih (periode)</div><div className="text-2xl font-extrabold" style={{ fontFamily: 'Syne', color: laba >= 0 ? '#a78bfa' : '#ef4444' }}>{fmt(laba)}</div></div>
              <div className="text-xs text-right" style={{ color: 'var(--text-muted)' }}>Penjualan {fmt(d.penjualan)} − Modal {fmt(d.modal_barang)} − Operasional {fmt((d.operasional || 0) + (d.gaji || 0))} − Bunga {fmt(d.beban_bunga)}</div>
            </div>
          </div>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Card icon={Scale} label="Arus Kas Bersih" value={fmt((d.uang_masuk_total || 0) - (d.pengeluaran_total || 0))} color={(d.uang_masuk_total - d.pengeluaran_total) >= 0 ? '#10d98a' : '#ef4444'} />
            <button onClick={() => setActivePage?.('piutang')} className="text-left"><Card icon={TrendingUp} label="Piutang Usaha (=Piutang Aktif)" value={fmt(d.piutang_aktif)} color="#f59e0b" sub="Klik → menu Piutang" /></button>
            <Card icon={TrendingDown} label="Hutang Supplier" value={fmt(d.hutang_supplier)} color="#fb923c" />
            <Card icon={Building2} label="Hutang Bank" value={fmt(d.hutang_bank)} color="#ef4444" sub={`${d.pinjaman_aktif || 0} pinjaman aktif · cicilan ${fmt(d.cicilan_bank)}`} />
          </div>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Card icon={Wallet} label="Saldo Kas" value={fmt(d.saldo_kas)} color="#38BDF8" />
            <Card icon={Landmark} label="Saldo Rekening" value={fmt(d.saldo_rekening)} color="#38BDF8" />
            <Card icon={TrendingUp} label="Sudah Bayar (Piutang)" value={fmt(d.sudah_bayar)} color="#10d98a" />
            <Card icon={ShoppingCart} label="Persediaan" value={fmt(d.persediaan)} color="#a78bfa" />
          </div>

          {/* Neraca sederhana */}
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
          <div className="rounded-xl p-3 grid grid-cols-2 sm:grid-cols-3 gap-2" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
            <input type="date" value={expForm.date} onChange={e => setExpForm(p => ({ ...p, date: e.target.value }))} className="px-2 py-1.5 rounded-lg text-xs" style={{ ...inp, colorScheme: 'dark' }} />
            <select value={expForm.category} onChange={e => setExpForm(p => ({ ...p, category: e.target.value }))} className="px-2 py-1.5 rounded-lg text-xs" style={inp}>{EXP_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}</select>
            <MoneyInput value={expForm.amount} onChange={v => setExpForm(p => ({ ...p, amount: v }))} placeholder="Nominal" className="px-2 py-1.5 rounded-lg text-xs" style={inp} />
            <select value={expForm.method} onChange={e => setExpForm(p => ({ ...p, method: e.target.value }))} className="px-2 py-1.5 rounded-lg text-xs" style={inp}>{METHODS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}</select>
            <input value={expForm.note} onChange={e => setExpForm(p => ({ ...p, note: e.target.value }))} placeholder="Keterangan" className="px-2 py-1.5 rounded-lg text-xs sm:col-span-2" style={inp} />
            <Button variant="primary" size="sm" className="col-span-2 sm:col-span-3" onClick={submitExpense} disabled={saving}>{saving ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />} Catat Pengeluaran</Button>
          </div>
          <div className="space-y-2">{expenses.length === 0 && <p className="text-xs text-center py-4" style={{ color: 'var(--text-muted)' }}>Belum ada</p>}
            {expenses.map(x => <div key={x.id} className="flex items-center gap-3 p-2.5 rounded-xl" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}><div className="flex-1 min-w-0"><div className="text-xs font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{x.category} <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>· {x.note}</span></div><div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{dt(x.expense_date)} · {x.method}</div></div><div className="text-xs font-bold" style={{ color: '#ef4444' }}>{fmt(x.amount)}</div><button onClick={async () => { const r = await acc.deleteExpense(x.id); if (r.ok) { toast.success('Dihapus'); loadExpenses() } }} className="w-7 h-7 rounded-lg inline-flex items-center justify-center" style={{ background: 'rgba(255,77,106,0.08)', color: 'var(--red)' }}><Trash2 size={11} /></button></div>)}
          </div>
        </div>
      )}

      {/* ── PEMBELIAN ── */}
      {tab === 'pembelian' && !loading && (
        <div className="space-y-4">
          <div className="rounded-xl p-3 grid grid-cols-2 sm:grid-cols-4 gap-2" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
            <input type="date" value={purForm.date} onChange={e => setPurForm(p => ({ ...p, date: e.target.value }))} className="px-2 py-1.5 rounded-lg text-xs" style={{ ...inp, colorScheme: 'dark' }} />
            <select value={purForm.supplier} onChange={e => setPurForm(p => ({ ...p, supplier: e.target.value }))} className="px-2 py-1.5 rounded-lg text-xs" style={inp}>
              <option value="">— Pilih Supplier —</option>
              {suppliers.map(s => <option key={s.id} value={s.name}>{s.name}</option>)}
            </select>
            <button onClick={() => setTab('supplier')} className="px-2 py-1.5 rounded-lg text-xs font-semibold" style={{ background: 'rgba(139,92,246,0.1)', color: 'var(--accent-light)', border: '1px solid rgba(139,92,246,0.2)' }}>+ Supplier</button>
            <input value={purForm.item} onChange={e => setPurForm(p => ({ ...p, item: e.target.value }))} placeholder="Nama bahan" className="px-2 py-1.5 rounded-lg text-xs" style={inp} />
            <MoneyInput value={purForm.qty} onChange={v => setPurForm(p => ({ ...p, qty: v }))} placeholder="Jumlah" className="px-2 py-1.5 rounded-lg text-xs" style={inp} />
            <MoneyInput value={purForm.harga} onChange={v => setPurForm(p => ({ ...p, harga: v }))} placeholder="Harga satuan" className="px-2 py-1.5 rounded-lg text-xs" style={inp} />
            <select value={purForm.method} onChange={e => setPurForm(p => ({ ...p, method: e.target.value }))} className="px-2 py-1.5 rounded-lg text-xs" style={inp}>{METHODS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}<option value="hutang">Hutang Supplier</option></select>
            <MoneyInput value={purForm.paid} onChange={v => setPurForm(p => ({ ...p, paid: v }))} placeholder="Nominal dibayar" className="px-2 py-1.5 rounded-lg text-xs" style={inp} />
            <input value={purForm.note} onChange={e => setPurForm(p => ({ ...p, note: e.target.value }))} placeholder="Catatan" className="px-2 py-1.5 rounded-lg text-xs sm:col-span-2" style={inp} />
            <Button variant="primary" size="sm" className="col-span-2" onClick={submitPurchase} disabled={saving}>{saving ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />} Catat Pembelian</Button>
          </div>
          <div className="space-y-2">{purchases.length === 0 && <p className="text-xs text-center py-4" style={{ color: 'var(--text-muted)' }}>Belum ada</p>}
            {purchases.map(x => <div key={x.id} className="flex items-center gap-3 p-2.5 rounded-xl" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}><div className="flex-1 min-w-0"><div className="text-xs font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{x.item || '—'} <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>· {x.supplier}</span></div><div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{dt(x.purchase_date)} · {x.is_credit ? 'Kredit' : x.method}</div></div><div className="text-xs font-bold" style={{ color: '#f59e0b' }}>{fmt(x.amount)}</div><button onClick={async () => { const r = await acc.deletePurchase(x.id); if (r.ok) { toast.success('Dihapus'); loadPurchases() } }} className="w-7 h-7 rounded-lg inline-flex items-center justify-center" style={{ background: 'rgba(255,77,106,0.08)', color: 'var(--red)' }}><Trash2 size={11} /></button></div>)}
          </div>
        </div>
      )}

      {/* ── SUPPLIER MASTER ── */}
      {tab === 'supplier' && !loading && (
        <div className="space-y-4">
          <div className="rounded-xl p-3 grid grid-cols-2 sm:grid-cols-4 gap-2" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
            <input value={supForm.name} onChange={e => setSupForm(p => ({ ...p, name: e.target.value }))} placeholder="Nama supplier" className="px-2 py-1.5 rounded-lg text-xs" style={inp} />
            <input value={supForm.phone} onChange={e => setSupForm(p => ({ ...p, phone: e.target.value }))} placeholder="No. HP" className="px-2 py-1.5 rounded-lg text-xs" style={inp} />
            <input value={supForm.address} onChange={e => setSupForm(p => ({ ...p, address: e.target.value }))} placeholder="Alamat" className="px-2 py-1.5 rounded-lg text-xs" style={inp} />
            <input value={supForm.note} onChange={e => setSupForm(p => ({ ...p, note: e.target.value }))} placeholder="Catatan" className="px-2 py-1.5 rounded-lg text-xs" style={inp} />
            <Button variant="primary" size="sm" className="col-span-2" onClick={saveSupplier} disabled={saving}>{saving ? <Loader2 size={13} className="animate-spin" /> : (supForm.id ? <Check size={13} /> : <Plus size={13} />)} {supForm.id ? 'Simpan' : 'Tambah Supplier'}</Button>
            {supForm.id && <Button variant="secondary" size="sm" onClick={() => setSupForm({ id: null, name: '', phone: '', address: '', note: '' })}>Batal</Button>}
          </div>
          <div className="relative">
            <input value={supSearch} onChange={e => setSupSearch(e.target.value)} onKeyDown={e => e.key === 'Enter' && loadSuppliers()} placeholder="Cari supplier... (Enter)" className="w-full px-3 py-2 rounded-xl text-sm" style={inp} />
          </div>
          <div className="space-y-2">{suppliers.length === 0 && <p className="text-xs text-center py-4" style={{ color: 'var(--text-muted)' }}>Belum ada supplier</p>}
            {suppliers.map(s => <div key={s.id} className="flex items-center gap-3 p-2.5 rounded-xl" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}><div className="flex-1 min-w-0"><div className="text-xs font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{s.name}</div><div className="text-[11px] truncate" style={{ color: 'var(--text-muted)' }}>{s.phone} · {s.address}</div></div>
              <button onClick={() => setSupForm({ id: s.id, name: s.name, phone: s.phone || '', address: s.address || '', note: s.note || '' })} className="w-7 h-7 rounded-lg inline-flex items-center justify-center" style={{ background: 'rgba(139,92,246,0.1)', color: 'var(--accent-light)' }}><Pencil size={11} /></button>
              <button onClick={async () => { const r = await acc.deleteSupplier(s.id); if (r.ok) { toast.success('Supplier dihapus'); loadSuppliers() } }} className="w-7 h-7 rounded-lg inline-flex items-center justify-center" style={{ background: 'rgba(255,77,106,0.08)', color: 'var(--red)' }}><Trash2 size={11} /></button>
            </div>)}
          </div>
        </div>
      )}

      {/* ── HUTANG SUPPLIER ── */}
      {tab === 'hsupplier' && !loading && (
        <div className="space-y-4">
          <div className="rounded-xl p-3 grid grid-cols-2 sm:grid-cols-4 gap-2" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
            <input value={sdForm.supplier} onChange={e => setSdForm(p => ({ ...p, supplier: e.target.value }))} placeholder="Supplier" className="px-2 py-1.5 rounded-lg text-xs" style={inp} />
            <input value={sdForm.item} onChange={e => setSdForm(p => ({ ...p, item: e.target.value }))} placeholder="Barang" className="px-2 py-1.5 rounded-lg text-xs" style={inp} />
            <MoneyInput value={sdForm.total} onChange={v => setSdForm(p => ({ ...p, total: v }))} placeholder="Total hutang" className="px-2 py-1.5 rounded-lg text-xs" style={inp} />
            <Button variant="primary" size="sm" disabled={saving} onClick={async () => { if (!(parseCurrency(sdForm.total) > 0)) return toast.error('Total > 0'); setSaving(true); const r = await acc.addSupplierDebt({ ...sdForm, total: parseCurrency(sdForm.total) }); setSaving(false); if (r.ok) { toast.success('Dicatat'); setSdForm({ supplier: '', item: '', total: '', dueDate: '' }); loadSupDebts() } else toast.error(r.error) }}><Plus size={13} /> Catat</Button>
          </div>
          <div className="space-y-2">{supDebts.length === 0 && <p className="text-xs text-center py-4" style={{ color: 'var(--text-muted)' }}>Belum ada</p>}
            {supDebts.map(x => { const rem = Math.max(0, Math.round(x.total || 0) - Math.round(x.paid || 0)); return (
              <div key={x.id} className="rounded-xl p-3" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
                <div className="flex items-center gap-3"><div className="flex-1 min-w-0"><div className="text-xs font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{x.supplier || '—'} <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>· {x.item}</span></div><div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>Total {fmt(x.total)} · Bayar {fmt(x.paid)}</div></div>
                  <div className="text-right"><div className="text-[10px] uppercase" style={{ color: 'var(--text-muted)' }}>Sisa</div><div className="text-sm font-bold" style={{ color: rem > 0 ? '#ef4444' : '#10d98a' }}>{fmt(rem)}</div></div>
                  {rem > 0 && <button onClick={() => { setPayId(payId === x.id ? null : x.id); setPayVal(String(rem)); setPayMethod('cash') }} className="px-2.5 h-8 rounded-lg text-xs font-semibold" style={{ background: 'linear-gradient(135deg,#10d98a,#059669)', color: '#fff', fontFamily: 'Syne' }}>Bayar</button>}
                  <button onClick={async () => { const r = await acc.deleteSupplierDebt(x.id); if (r.ok) { toast.success('Dihapus'); loadSupDebts() } }} className="w-7 h-7 rounded-lg inline-flex items-center justify-center" style={{ background: 'rgba(255,77,106,0.08)', color: 'var(--red)' }}><Trash2 size={11} /></button>
                </div>
                {payId === x.id && <div className="flex items-center gap-2 mt-2 pt-2" style={{ borderTop: '1px dashed var(--border)' }}>
                  <MoneyInput value={payVal} onChange={setPayVal} placeholder="Nominal" className="px-2 py-1.5 rounded-lg text-xs flex-1" style={inp} />
                  <select value={payMethod} onChange={e => setPayMethod(e.target.value)} className="px-2 py-1.5 rounded-lg text-xs" style={inp}>{METHODS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}</select>
                  <Button variant="success" size="sm" onClick={async () => { const amt = parseCurrency(payVal); if (!(amt > 0)) return toast.error('Nominal > 0'); const r = await acc.paySupplierDebt(x.id, Math.min(amt, rem), payMethod, currentUser?.id); if (r.ok) { toast.success('Dibayar'); setPayId(null); loadSupDebts() } else toast.error(r.error) }}>Konfirmasi</Button>
                </div>}
              </div>
            )})}
          </div>
        </div>
      )}

      {/* ── HUTANG BANK ── */}
      {tab === 'hbank' && !loading && (
        <div className="space-y-4">
          <div className="rounded-xl p-3 grid grid-cols-2 sm:grid-cols-4 gap-2" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
            <input value={loanForm.namaBank} onChange={e => setLoanForm(p => ({ ...p, namaBank: e.target.value }))} placeholder="Nama Bank (BCA)" className="px-2 py-1.5 rounded-lg text-xs" style={inp} />
            <select value={loanForm.jenis} onChange={e => setLoanForm(p => ({ ...p, jenis: e.target.value }))} className="px-2 py-1.5 rounded-lg text-xs" style={inp}>{['KPR', 'Kredit Modal Kerja (KMK)', 'Pinjaman Investasi', 'Leasing Kendaraan', 'Leasing Mesin', 'Pinjaman Usaha Lainnya'].map(j => <option key={j} value={j}>{j}</option>)}</select>
            <MoneyInput value={loanForm.plafon} onChange={v => setLoanForm(p => ({ ...p, plafon: v, sisaPokok: p.sisaPokok || v }))} placeholder="Plafon" className="px-2 py-1.5 rounded-lg text-xs" style={inp} />
            <MoneyInput value={loanForm.sisaPokok} onChange={v => setLoanForm(p => ({ ...p, sisaPokok: v }))} placeholder="Sisa pokok" className="px-2 py-1.5 rounded-lg text-xs" style={inp} />
            <MoneyInput value={loanForm.cicilan} onChange={v => setLoanForm(p => ({ ...p, cicilan: v }))} placeholder="Cicilan/bln" className="px-2 py-1.5 rounded-lg text-xs" style={inp} />
            <input type="date" value={loanForm.mulai} onChange={e => setLoanForm(p => ({ ...p, mulai: e.target.value }))} className="px-2 py-1.5 rounded-lg text-xs" style={{ ...inp, colorScheme: 'dark' }} title="Tanggal mulai" />
            <input type="date" value={loanForm.jatuhTempo} onChange={e => setLoanForm(p => ({ ...p, jatuhTempo: e.target.value }))} className="px-2 py-1.5 rounded-lg text-xs" style={{ ...inp, colorScheme: 'dark' }} title="Jatuh tempo" />
            <Button variant="primary" size="sm" onClick={submitLoan} disabled={saving}>{saving ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />} Tambah Pinjaman</Button>
          </div>
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
                    {x.sisa_pokok > 0 && <button onClick={() => setBpay(bpay?.loanId === x.id ? null : { loanId: x.id, amount: String(Math.round(x.cicilan_bulanan || 0)), pokok: '', bunga: '', method: 'transfer' })} className="px-2.5 h-8 rounded-lg text-xs font-semibold" style={{ background: 'linear-gradient(135deg,#10d98a,#059669)', color: '#fff', fontFamily: 'Syne' }}>Bayar</button>}
                    <button onClick={async () => { const r = await acc.deleteBankLoan(x.id); if (r.ok) { toast.success('Dihapus'); loadBankLoans() } }} className="w-7 h-7 rounded-lg inline-flex items-center justify-center" style={{ background: 'rgba(255,77,106,0.08)', color: 'var(--red)' }}><Trash2 size={11} /></button>
                  </div>
                  {bpay?.loanId === x.id && (
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-2 pt-2" style={{ borderTop: '1px dashed var(--border)' }}>
                      <MoneyInput value={bpay.amount} onChange={v => setBpay(p => ({ ...p, amount: v }))} placeholder="Total bayar" className="px-2 py-1.5 rounded-lg text-xs" style={inp} />
                      <MoneyInput value={bpay.pokok} onChange={v => setBpay(p => ({ ...p, pokok: v }))} placeholder="Pokok" className="px-2 py-1.5 rounded-lg text-xs" style={inp} />
                      <MoneyInput value={bpay.bunga} onChange={v => setBpay(p => ({ ...p, bunga: v }))} placeholder="Bunga" className="px-2 py-1.5 rounded-lg text-xs" style={inp} />
                      <select value={bpay.method} onChange={e => setBpay(p => ({ ...p, method: e.target.value }))} className="px-2 py-1.5 rounded-lg text-xs" style={inp}>{METHODS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}</select>
                      <Button variant="success" size="sm" className="col-span-2 sm:col-span-4" onClick={async () => {
                        const amount = parseCurrency(bpay.amount); if (!(amount > 0)) return toast.error('Nominal > 0')
                        const r = await acc.payBankLoan(x.id, { amount, pokok: parseCurrency(bpay.pokok), bunga: parseCurrency(bpay.bunga), method: bpay.method, cashierId: currentUser?.id })
                        if (r.ok) { toast.success('Cicilan bank dibayar'); setBpay(null); loadBankLoans() } else toast.error(r.error)
                      }}>Konfirmasi Pembayaran</Button>
                      <p className="col-span-2 sm:col-span-4 text-[11px]" style={{ color: 'var(--text-muted)' }}>Pokok mengurangi hutang bank; bunga masuk beban. Kosongkan pokok/bunga → semua dianggap pokok.</p>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </Page>
  )
}

function Page({ children, right }) {
  return (
    <div className="flex-1 overflow-y-auto mesh-bg">
      <div className="p-4 sm:p-6 max-w-7xl mx-auto">
        <div className="flex items-start justify-between gap-3 mb-4 flex-wrap">
          <div><div className="text-sm" style={{ color: 'var(--text-secondary)' }}>Keuangan & Laporan</div><h2 className="text-xl sm:text-2xl font-bold mt-0.5" style={{ fontFamily: 'Syne', color: 'var(--text-primary)' }}>Accounting</h2></div>
          {right}
        </div>
        {children}
      </div>
    </div>
  )
}
