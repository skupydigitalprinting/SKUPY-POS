import React, { useEffect, useMemo, useState } from 'react'
import {
  Loader2, TrendingUp, TrendingDown, Wallet, Landmark, Scale,
  Receipt, ShoppingCart, BookOpen, Plus, Trash2, AlertTriangle, RefreshCw,
  Truck, FileSpreadsheet, Users,
} from 'lucide-react'
import { formatRupiah } from '../utils/helpers'
import { Button } from '../components/ui'
import { useToast } from '../components/Toast'
import { useAccounting } from '../hooks/useAccounting'

const TABS = [
  { id: 'ringkasan', label: 'Ringkasan', icon: Scale },
  { id: 'jurnal', label: 'Jurnal', icon: BookOpen },
  { id: 'pengeluaran', label: 'Pengeluaran', icon: Receipt },
  { id: 'pembelian', label: 'Pembelian', icon: ShoppingCart },
  { id: 'supplier', label: 'Hutang Supplier', icon: Truck },
]
const METHODS = [{ id: 'cash', label: 'Cash' }, { id: 'transfer', label: 'Transfer' }, { id: 'qris', label: 'QRIS' }]
const fmt = (n) => formatRupiah(Math.round(Number(n) || 0))
const dt = (d) => (d ? new Date(d).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' }) : '—')

function Card({ icon: Icon, label, value, color = '#38BDF8', sub }) {
  return (
    <div className="rounded-2xl p-4" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
      <div className="flex items-center gap-2 mb-2">
        <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
          style={{ background: 'rgba(56,189,248,0.10)', border: '1px solid rgba(56,189,248,0.25)' }}>
          <Icon size={15} style={{ color }} />
        </div>
        <span className="text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>{label}</span>
      </div>
      <div className="text-lg font-bold truncate" style={{ fontFamily: 'Syne', color, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      {sub && <div className="text-[11px] mt-0.5 truncate" style={{ color: 'var(--text-muted)' }}>{sub}</div>}
    </div>
  )
}

function Page({ children }) {
  return (
    <div className="flex-1 overflow-y-auto mesh-bg">
      <div className="p-4 sm:p-6 max-w-7xl mx-auto">
        <div className="mb-4">
          <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>Keuangan & Laporan</div>
          <h2 className="text-xl sm:text-2xl font-bold mt-0.5" style={{ fontFamily: 'Syne', color: 'var(--text-primary)' }}>Accounting</h2>
        </div>
        {children}
      </div>
    </div>
  )
}

export default function Accounting({ admins = [], currentUser } = {}) {
  const toast = useToast()
  const acc = useAccounting()
  const [tab, setTab] = useState('ringkasan')
  const [from, setFrom] = useState(acc.monthStartISO())
  const [to, setTo] = useState(acc.todayISO())

  const [loading, setLoading] = useState(false)
  const [setupNeeded, setSetupNeeded] = useState(false)
  const [summary, setSummary] = useState(null)

  // Jurnal
  const [entries, setEntries] = useState([]); const [entPage, setEntPage] = useState(0); const [entCount, setEntCount] = useState(0)
  // Pengeluaran / Pembelian
  const [expenses, setExpenses] = useState([]); const [purchases, setPurchases] = useState([])
  const [expForm, setExpForm] = useState({ date: acc.todayISO(), category: 'Operasional', amount: '', method: 'cash', note: '' })
  const [purForm, setPurForm] = useState({ date: acc.todayISO(), supplier: '', item: '', qty: '', amount: '', method: 'cash', isCredit: false, note: '' })
  const [saving, setSaving] = useState(false)
  // Supplier debts + rekap admin + export
  const [supDebts, setSupDebts] = useState([])
  const [sdForm, setSdForm] = useState({ supplier: '', item: '', total: '', dueDate: '', note: '' })
  const [payDebtId, setPayDebtId] = useState(null)
  const [payVal, setPayVal] = useState('')
  const [payMethod, setPayMethod] = useState('cash')
  const [recap, setRecap] = useState([])
  const [exporting, setExporting] = useState(false)
  const adminName = (id) => admins.find(a => a.id === id)?.name || admins.find(a => a.id === id)?.username || '—'

  const loadSummary = async () => {
    setLoading(true)
    const res = await acc.getSummary(from, to)
    if (!res.ok) {
      // Kemungkinan migrasi belum dijalankan
      if (/function|relation|does not exist|schema cache|acc_summary/i.test(res.error || '')) setSetupNeeded(true)
      else toast.error(res.error || 'Gagal memuat ringkasan')
    } else { setSummary(res.data); setSetupNeeded(false) }
    setLoading(false)
  }
  const loadEntries = async (page = 0) => {
    const res = await acc.listEntries({ page, from, to })
    if (res.ok) { setEntries(res.data); setEntCount(res.count); setEntPage(page) }
    else if (/relation|does not exist/i.test(res.error || '')) setSetupNeeded(true)
  }
  const loadExpenses = async () => { const r = await acc.listExpenses({}); if (r.ok) setExpenses(r.data) }
  const loadPurchases = async () => { const r = await acc.listPurchases({}); if (r.ok) setPurchases(r.data) }
  const loadSupplierDebts = async () => { const r = await acc.listSupplierDebts(); if (r.ok) setSupDebts(r.data) }
  const loadRecap = async () => { const r = await acc.getRecapAdmin(from, to); if (r.ok) setRecap(r.data) }

  // Fetch saat tab/rentang berubah — HANYA setelah modul dibuka.
  useEffect(() => {
    if (tab === 'ringkasan') { loadSummary(); loadRecap() }
    if (tab === 'jurnal') loadEntries(0)
    if (tab === 'pengeluaran') loadExpenses()
    if (tab === 'pembelian') loadPurchases()
    if (tab === 'supplier') loadSupplierDebts()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, from, to])

  // Export Excel — dynamic import xlsx supaya tidak menambah chunk awal.
  const exportExcel = async () => {
    if (exporting) return
    setExporting(true)
    try {
      const [{ default: XLSX }, res] = await Promise.all([
        import('xlsx'),
        acc.fetchEntriesForExport(from, to),
      ])
      if (!res.ok) { toast.error(res.error || 'Gagal ambil data'); return }
      const rows = (res.data || []).map(e => ({
        Tanggal: e.entry_date, Sumber: e.source_type, Invoice: e.invoice_no || '',
        Akun: e.account_code, Debit: Math.round(e.debit || 0), Kredit: Math.round(e.credit || 0),
        Keterangan: e.description || '',
      }))
      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Jurnal')
      if (summary) {
        const sRows = Object.entries(summary).map(([k, v]) => ({ Pos: k, Nilai: Math.round(Number(v) || 0) }))
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sRows), 'Ringkasan')
      }
      XLSX.writeFile(wb, `accounting-${from}_${to}.xlsx`)
    } catch (e) {
      toast.error('Export gagal: ' + (e?.message || e))
    } finally { setExporting(false) }
  }

  const laba = useMemo(() => {
    if (!summary) return 0
    return Math.round((summary.revenue || 0) - (summary.hpp || 0) - (summary.expense || 0))
  }, [summary])
  const totalAset = useMemo(() => {
    if (!summary) return 0
    return Math.round((summary.kas || 0) + (summary.bank || 0) + (summary.piutang || 0) + (summary.persediaan || 0))
  }, [summary])

  const submitExpense = async () => {
    if (saving) return
    if (!(Number(expForm.amount) > 0)) return toast.error('Nominal harus > 0')
    setSaving(true)
    const r = await acc.addExpense(expForm)
    setSaving(false)
    if (r.ok) { toast.success('Pengeluaran dicatat'); setExpForm({ date: acc.todayISO(), category: 'Operasional', amount: '', method: 'cash', note: '' }); loadExpenses() }
    else toast.error(r.error || 'Gagal')
  }
  const submitPurchase = async () => {
    if (saving) return
    if (!(Number(purForm.amount) > 0)) return toast.error('Nominal harus > 0')
    setSaving(true)
    const r = await acc.addPurchase(purForm)
    setSaving(false)
    if (r.ok) { toast.success('Pembelian dicatat'); setPurForm({ date: acc.todayISO(), supplier: '', item: '', qty: '', amount: '', method: 'cash', isCredit: false, note: '' }); loadPurchases() }
    else toast.error(r.error || 'Gagal')
  }

  const inp = { background: 'var(--bg-elevated)', border: '1px solid var(--border)', color: 'var(--text-primary)' }
  const lastPage = Math.max(0, Math.ceil(entCount / acc.PAGE_SIZE) - 1)

  if (setupNeeded) {
    return (
      <Page>
        <div className="rounded-2xl p-5" style={{ background: 'rgba(245,158,11,0.06)', border: '1px solid rgba(245,158,11,0.3)' }}>
          <div className="flex items-center gap-2 mb-2" style={{ color: '#f59e0b' }}>
            <AlertTriangle size={16} /> <span className="font-bold text-sm" style={{ fontFamily: 'Syne' }}>Modul Accounting belum aktif</span>
          </div>
          <p className="text-xs leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
            Jalankan migrasi <code>supabase/migrations/2026_06_accounting_module.sql</code> di Supabase → SQL Editor,
            lalu buka lagi modul ini. Migrasi membuat tabel akuntansi + jurnal otomatis dari transaksi POS.
          </p>
          <Button variant="secondary" className="mt-3" onClick={() => { setSetupNeeded(false); loadSummary() }}>
            <RefreshCw size={13} /> Coba lagi
          </Button>
        </div>
      </Page>
    )
  }

  return (
    <Page>
    <div className="rounded-2xl overflow-hidden" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-strong)' }}>
      {/* Header + date range */}
      <div className="flex flex-wrap items-center gap-2 px-4 py-3" style={{ borderBottom: '1px solid var(--border)' }}>
        <Landmark size={15} style={{ color: 'var(--accent-light)' }} />
        <span className="font-bold text-sm" style={{ fontFamily: 'Syne', color: 'var(--text-primary)' }}>Accounting</span>
        <span className="ml-auto flex items-center gap-2 flex-wrap">
          <input type="date" value={from} onChange={e => setFrom(e.target.value)} className="px-2 py-1.5 rounded-lg text-xs" style={{ ...inp, colorScheme: 'dark' }} />
          <span style={{ color: 'var(--text-muted)' }}>—</span>
          <input type="date" value={to} onChange={e => setTo(e.target.value)} className="px-2 py-1.5 rounded-lg text-xs" style={{ ...inp, colorScheme: 'dark' }} />
          <button onClick={exportExcel} disabled={exporting}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold btn-press"
            style={{ background: 'rgba(16,217,138,0.12)', color: '#10d98a', border: '1px solid rgba(16,217,138,0.3)', fontFamily: 'Syne' }}>
            {exporting ? <Loader2 size={12} className="animate-spin" /> : <FileSpreadsheet size={12} />} Excel
          </button>
        </span>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 px-3 pt-3 flex-wrap">
        {TABS.map(t => {
          const Icon = t.icon; const active = tab === t.id
          return (
            <button key={t.id} onClick={() => setTab(t.id)}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold transition-all"
              style={{
                background: active ? 'linear-gradient(135deg, var(--accent), #6366f1)' : 'var(--bg-card)',
                color: active ? '#fff' : 'var(--text-secondary)',
                border: `1px solid ${active ? 'transparent' : 'var(--border)'}`, fontFamily: 'Syne',
              }}>
              <Icon size={12} /> {t.label}
            </button>
          )
        })}
      </div>

      <div className="p-4">
        {loading && <div className="flex items-center justify-center py-8"><Loader2 size={20} className="animate-spin" style={{ color: 'var(--accent-light)' }} /></div>}

        {/* ── RINGKASAN ── */}
        {tab === 'ringkasan' && !loading && summary && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <Card icon={TrendingUp} label="Uang Masuk" value={fmt(summary.cash_in)} color="#10d98a" sub="Rentang dipilih" />
              <Card icon={TrendingDown} label="Uang Keluar" value={fmt(summary.cash_out)} color="#ef4444" sub="Rentang dipilih" />
              <Card icon={Wallet} label="Pendapatan" value={fmt(summary.revenue)} color="#38BDF8" />
              <Card icon={Receipt} label="Beban" value={fmt(summary.expense)} color="#f59e0b" />
            </div>

            {/* Laba Rugi */}
            <div className="rounded-2xl p-4" style={{ background: laba >= 0 ? 'rgba(16,217,138,0.08)' : 'rgba(239,68,68,0.08)', border: `1px solid ${laba >= 0 ? 'rgba(16,217,138,0.3)' : 'rgba(239,68,68,0.3)'}` }}>
              <div className="text-xs font-bold uppercase tracking-wider mb-2" style={{ color: 'var(--text-muted)', fontFamily: 'Syne' }}>Laba Rugi (rentang)</div>
              <div className="grid grid-cols-3 gap-2 text-xs">
                <div><div style={{ color: 'var(--text-muted)' }}>Pendapatan</div><div className="font-bold" style={{ color: 'var(--text-primary)' }}>{fmt(summary.revenue)}</div></div>
                <div><div style={{ color: 'var(--text-muted)' }}>Beban + HPP</div><div className="font-bold" style={{ color: '#f59e0b' }}>{fmt((summary.expense || 0) + (summary.hpp || 0))}</div></div>
                <div className="text-right"><div style={{ color: 'var(--text-muted)' }}>Laba Bersih</div><div className="font-extrabold" style={{ color: laba >= 0 ? '#10d98a' : '#ef4444', fontFamily: 'Syne' }}>{fmt(laba)}</div></div>
              </div>
            </div>

            {/* Arus kas + Piutang/Hutang */}
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
              <Card icon={Scale} label="Arus Kas Bersih" value={fmt((summary.cash_in || 0) - (summary.cash_out || 0))} color={(summary.cash_in - summary.cash_out) >= 0 ? '#10d98a' : '#ef4444'} />
              <Card icon={TrendingUp} label="Piutang Usaha" value={fmt(summary.piutang)} color="#f59e0b" sub="Saldo s/d tanggal" />
              <Card icon={TrendingDown} label="Hutang Usaha" value={fmt(summary.hutang)} color="#ef4444" sub="Saldo s/d tanggal" />
            </div>

            {/* Neraca sederhana */}
            <div className="rounded-2xl p-4" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
              <div className="text-xs font-bold uppercase tracking-wider mb-3" style={{ color: 'var(--accent-light)', fontFamily: 'Syne' }}>Neraca Sederhana (s/d {dt(to)})</div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
                <div>
                  <div className="font-bold mb-1" style={{ color: 'var(--text-secondary)' }}>Aset</div>
                  {[['Kas', summary.kas], ['Bank', summary.bank], ['Piutang Usaha', summary.piutang], ['Persediaan', summary.persediaan]].map(([k, v]) => (
                    <div key={k} className="flex justify-between py-0.5" style={{ color: 'var(--text-muted)' }}><span>{k}</span><span style={{ color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>{fmt(v)}</span></div>
                  ))}
                  <div className="flex justify-between py-1 mt-1 font-bold" style={{ borderTop: '1px solid var(--border)', color: 'var(--text-primary)' }}><span>Total Aset</span><span>{fmt(totalAset)}</span></div>
                </div>
                <div>
                  <div className="font-bold mb-1" style={{ color: 'var(--text-secondary)' }}>Kewajiban & Ekuitas</div>
                  <div className="flex justify-between py-0.5" style={{ color: 'var(--text-muted)' }}><span>Hutang Usaha</span><span style={{ color: 'var(--text-primary)' }}>{fmt(summary.hutang)}</span></div>
                  <div className="flex justify-between py-0.5" style={{ color: 'var(--text-muted)' }}><span>Ekuitas (penyeimbang)</span><span style={{ color: 'var(--text-primary)' }}>{fmt(totalAset - (summary.hutang || 0))}</span></div>
                  <div className="flex justify-between py-1 mt-1 font-bold" style={{ borderTop: '1px solid var(--border)', color: 'var(--text-primary)' }}><span>Total</span><span>{fmt(totalAset)}</span></div>
                </div>
              </div>
            </div>

            {/* Rekap per Admin */}
            {recap.length > 0 && (
              <div className="rounded-2xl p-4" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
                <div className="flex items-center gap-2 mb-3"><Users size={14} style={{ color: 'var(--accent-light)' }} />
                  <span className="text-xs font-bold uppercase tracking-wider" style={{ color: 'var(--accent-light)', fontFamily: 'Syne' }}>Rekap per Admin (rentang)</span></div>
                <table className="w-full text-xs">
                  <thead><tr style={{ borderBottom: '1px solid var(--border)' }}>
                    {['Admin', 'Penjualan', 'Penerimaan Kas/Bank'].map((h, i) => (
                      <th key={i} className={`px-2 py-1.5 ${i === 0 ? 'text-left' : 'text-right'}`} style={{ color: 'var(--text-muted)', fontFamily: 'Syne', fontSize: 10 }}>{h}</th>
                    ))}
                  </tr></thead>
                  <tbody>
                    {recap.map((r, i) => (
                      <tr key={i} style={{ borderBottom: '1px solid var(--border)' }}>
                        <td className="px-2 py-2" style={{ color: 'var(--text-primary)' }}>{adminName(r.cashier_id)}</td>
                        <td className="px-2 py-2 text-right" style={{ color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>{fmt(r.revenue)}</td>
                        <td className="px-2 py-2 text-right" style={{ color: '#10d98a', fontVariantNumeric: 'tabular-nums' }}>{fmt(r.cash_in)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* ── JURNAL ── */}
        {tab === 'jurnal' && (
          <div>
            <div className="overflow-x-auto -mx-1">
              <table className="w-full text-xs" style={{ borderCollapse: 'collapse', minWidth: 560 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border)' }}>
                    {['Tanggal', 'Sumber', 'Invoice', 'Akun', 'Debit', 'Kredit', 'Keterangan'].map((h, i) => (
                      <th key={i} className={`px-2 py-2 font-bold uppercase ${i >= 4 && i <= 5 ? 'text-right' : 'text-left'}`} style={{ color: 'var(--text-muted)', fontFamily: 'Syne', fontSize: 10 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {entries.length === 0 && <tr><td colSpan={7} className="px-2 py-6 text-center" style={{ color: 'var(--text-muted)' }}>Belum ada jurnal</td></tr>}
                  {entries.map(e => (
                    <tr key={e.id} style={{ borderBottom: '1px solid var(--border)' }}>
                      <td className="px-2 py-2" style={{ color: 'var(--text-secondary)' }}>{dt(e.entry_date)}</td>
                      <td className="px-2 py-2" style={{ color: 'var(--text-muted)' }}>{e.source_type}</td>
                      <td className="px-2 py-2" style={{ color: 'var(--text-muted)' }}>{e.invoice_no || '—'}</td>
                      <td className="px-2 py-2 font-semibold" style={{ color: 'var(--text-primary)', fontFamily: 'Syne' }}>{e.account_code}</td>
                      <td className="px-2 py-2 text-right" style={{ color: '#10d98a', fontVariantNumeric: 'tabular-nums' }}>{e.debit > 0 ? fmt(e.debit) : '—'}</td>
                      <td className="px-2 py-2 text-right" style={{ color: '#ef4444', fontVariantNumeric: 'tabular-nums' }}>{e.credit > 0 ? fmt(e.credit) : '—'}</td>
                      <td className="px-2 py-2 truncate" style={{ color: 'var(--text-muted)', maxWidth: 200 }}>{e.description}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {entCount > acc.PAGE_SIZE && (
              <div className="flex items-center justify-center gap-3 mt-3">
                <Button variant="secondary" size="sm" disabled={entPage <= 0} onClick={() => loadEntries(entPage - 1)}>Prev</Button>
                <span className="text-xs" style={{ color: 'var(--text-muted)' }}>Hal {entPage + 1} / {lastPage + 1} · {entCount} baris</span>
                <Button variant="secondary" size="sm" disabled={entPage >= lastPage} onClick={() => loadEntries(entPage + 1)}>Next</Button>
              </div>
            )}
          </div>
        )}

        {/* ── PENGELUARAN ── */}
        {tab === 'pengeluaran' && (
          <div className="space-y-4">
            <div className="rounded-xl p-3 grid grid-cols-2 sm:grid-cols-3 gap-2" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
              <input type="date" value={expForm.date} onChange={e => setExpForm(p => ({ ...p, date: e.target.value }))} className="px-2 py-1.5 rounded-lg text-xs" style={{ ...inp, colorScheme: 'dark' }} />
              <input value={expForm.category} onChange={e => setExpForm(p => ({ ...p, category: e.target.value }))} placeholder="Kategori" className="px-2 py-1.5 rounded-lg text-xs" style={inp} />
              <input value={expForm.amount} onChange={e => setExpForm(p => ({ ...p, amount: e.target.value.replace(/[^\d]/g, '') }))} placeholder="Nominal" inputMode="numeric" className="px-2 py-1.5 rounded-lg text-xs" style={inp} />
              <select value={expForm.method} onChange={e => setExpForm(p => ({ ...p, method: e.target.value }))} className="px-2 py-1.5 rounded-lg text-xs" style={inp}>{METHODS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}</select>
              <input value={expForm.note} onChange={e => setExpForm(p => ({ ...p, note: e.target.value }))} placeholder="Keterangan" className="px-2 py-1.5 rounded-lg text-xs sm:col-span-2" style={inp} />
              <Button variant="primary" size="sm" className="col-span-2 sm:col-span-3" onClick={submitExpense} disabled={saving}>
                {saving ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />} Catat Pengeluaran
              </Button>
            </div>
            <div className="space-y-2">
              {expenses.length === 0 && <p className="text-xs text-center py-4" style={{ color: 'var(--text-muted)' }}>Belum ada pengeluaran</p>}
              {expenses.map(x => (
                <div key={x.id} className="flex items-center gap-3 p-2.5 rounded-xl" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{x.category} <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>· {x.note}</span></div>
                    <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{dt(x.expense_date)} · {x.method}</div>
                  </div>
                  <div className="text-xs font-bold" style={{ color: '#ef4444', fontVariantNumeric: 'tabular-nums' }}>{fmt(x.amount)}</div>
                  <button onClick={async () => { const r = await acc.deleteExpense(x.id); if (r.ok) { toast.success('Dihapus'); loadExpenses() } }}
                    className="w-7 h-7 rounded-lg inline-flex items-center justify-center" style={{ background: 'rgba(255,77,106,0.08)', color: 'var(--red)', border: '1px solid rgba(255,77,106,0.15)' }}>
                    <Trash2 size={11} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── PEMBELIAN ── */}
        {tab === 'pembelian' && (
          <div className="space-y-4">
            <div className="rounded-xl p-3 grid grid-cols-2 sm:grid-cols-3 gap-2" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
              <input type="date" value={purForm.date} onChange={e => setPurForm(p => ({ ...p, date: e.target.value }))} className="px-2 py-1.5 rounded-lg text-xs" style={{ ...inp, colorScheme: 'dark' }} />
              <input value={purForm.supplier} onChange={e => setPurForm(p => ({ ...p, supplier: e.target.value }))} placeholder="Supplier" className="px-2 py-1.5 rounded-lg text-xs" style={inp} />
              <input value={purForm.item} onChange={e => setPurForm(p => ({ ...p, item: e.target.value }))} placeholder="Barang" className="px-2 py-1.5 rounded-lg text-xs" style={inp} />
              <input value={purForm.qty} onChange={e => setPurForm(p => ({ ...p, qty: e.target.value.replace(/[^\d.]/g, '') }))} placeholder="Qty" inputMode="decimal" className="px-2 py-1.5 rounded-lg text-xs" style={inp} />
              <input value={purForm.amount} onChange={e => setPurForm(p => ({ ...p, amount: e.target.value.replace(/[^\d]/g, '') }))} placeholder="Nominal" inputMode="numeric" className="px-2 py-1.5 rounded-lg text-xs" style={inp} />
              <select value={purForm.method} onChange={e => setPurForm(p => ({ ...p, method: e.target.value }))} className="px-2 py-1.5 rounded-lg text-xs" style={inp}>{METHODS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}</select>
              <label className="flex items-center gap-2 text-xs px-1" style={{ color: 'var(--text-secondary)' }}>
                <input type="checkbox" checked={purForm.isCredit} onChange={e => setPurForm(p => ({ ...p, isCredit: e.target.checked }))} /> Beli kredit (hutang)
              </label>
              <Button variant="primary" size="sm" className="col-span-2 sm:col-span-2" onClick={submitPurchase} disabled={saving}>
                {saving ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />} Catat Pembelian
              </Button>
            </div>
            <div className="space-y-2">
              {purchases.length === 0 && <p className="text-xs text-center py-4" style={{ color: 'var(--text-muted)' }}>Belum ada pembelian</p>}
              {purchases.map(x => (
                <div key={x.id} className="flex items-center gap-3 p-2.5 rounded-xl" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{x.item || '—'} <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>· {x.supplier}</span></div>
                    <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{dt(x.purchase_date)} · {x.is_credit ? 'Kredit' : x.method}</div>
                  </div>
                  <div className="text-xs font-bold" style={{ color: '#f59e0b', fontVariantNumeric: 'tabular-nums' }}>{fmt(x.amount)}</div>
                  <button onClick={async () => { const r = await acc.deletePurchase(x.id); if (r.ok) { toast.success('Dihapus'); loadPurchases() } }}
                    className="w-7 h-7 rounded-lg inline-flex items-center justify-center" style={{ background: 'rgba(255,77,106,0.08)', color: 'var(--red)', border: '1px solid rgba(255,77,106,0.15)' }}>
                    <Trash2 size={11} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── HUTANG SUPPLIER ── */}
        {tab === 'supplier' && (
          <div className="space-y-4">
            <div className="rounded-xl p-3 grid grid-cols-2 sm:grid-cols-3 gap-2" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
              <input value={sdForm.supplier} onChange={e => setSdForm(p => ({ ...p, supplier: e.target.value }))} placeholder="Supplier" className="px-2 py-1.5 rounded-lg text-xs" style={inp} />
              <input value={sdForm.item} onChange={e => setSdForm(p => ({ ...p, item: e.target.value }))} placeholder="Barang/keterangan" className="px-2 py-1.5 rounded-lg text-xs" style={inp} />
              <input value={sdForm.total} onChange={e => setSdForm(p => ({ ...p, total: e.target.value.replace(/[^\d]/g, '') }))} placeholder="Total hutang" inputMode="numeric" className="px-2 py-1.5 rounded-lg text-xs" style={inp} />
              <input type="date" value={sdForm.dueDate} onChange={e => setSdForm(p => ({ ...p, dueDate: e.target.value }))} className="px-2 py-1.5 rounded-lg text-xs" style={{ ...inp, colorScheme: 'dark' }} title="Jatuh tempo" />
              <Button variant="primary" size="sm" className="col-span-2 sm:col-span-1" disabled={saving}
                onClick={async () => {
                  if (!(Number(sdForm.total) > 0)) return toast.error('Total harus > 0')
                  setSaving(true); const r = await acc.addSupplierDebt(sdForm); setSaving(false)
                  if (r.ok) { toast.success('Hutang supplier dicatat'); setSdForm({ supplier: '', item: '', total: '', dueDate: '', note: '' }); loadSupplierDebts() }
                  else toast.error(r.error || 'Gagal')
                }}>
                <Plus size={13} /> Catat Hutang
              </Button>
            </div>
            <div className="space-y-2">
              {supDebts.length === 0 && <p className="text-xs text-center py-4" style={{ color: 'var(--text-muted)' }}>Belum ada hutang supplier</p>}
              {supDebts.map(d => {
                const rem = Math.max(0, Math.round(d.total || 0) - Math.round(d.paid || 0))
                return (
                  <div key={d.id} className="rounded-xl p-3" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
                    <div className="flex items-center gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{d.supplier || '—'} <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>· {d.item}</span></div>
                        <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                          Total {fmt(d.total)} · Bayar {fmt(d.paid)} · {d.due_date ? `Tempo ${dt(d.due_date)}` : 'tanpa tempo'}
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-[10px] uppercase" style={{ color: 'var(--text-muted)' }}>Sisa</div>
                        <div className="text-sm font-bold" style={{ color: rem > 0 ? '#ef4444' : '#10d98a', fontVariantNumeric: 'tabular-nums' }}>{fmt(rem)}</div>
                      </div>
                      {rem > 0 && (
                        <button onClick={() => { setPayDebtId(payDebtId === d.id ? null : d.id); setPayVal(String(rem)); setPayMethod('cash') }}
                          className="px-2.5 h-8 rounded-lg text-xs font-semibold" style={{ background: 'linear-gradient(135deg,#10d98a,#059669)', color: '#fff', fontFamily: 'Syne' }}>Bayar</button>
                      )}
                      <button onClick={async () => { const r = await acc.deleteSupplierDebt(d.id); if (r.ok) { toast.success('Dihapus'); loadSupplierDebts() } }}
                        className="w-7 h-7 rounded-lg inline-flex items-center justify-center" style={{ background: 'rgba(255,77,106,0.08)', color: 'var(--red)', border: '1px solid rgba(255,77,106,0.15)' }}>
                        <Trash2 size={11} />
                      </button>
                    </div>
                    {payDebtId === d.id && (
                      <div className="flex items-center gap-2 mt-2 pt-2" style={{ borderTop: '1px dashed var(--border)' }}>
                        <input value={payVal} onChange={e => setPayVal(e.target.value.replace(/[^\d]/g, ''))} inputMode="numeric" placeholder="Nominal" className="px-2 py-1.5 rounded-lg text-xs flex-1" style={inp} />
                        <select value={payMethod} onChange={e => setPayMethod(e.target.value)} className="px-2 py-1.5 rounded-lg text-xs" style={inp}>{METHODS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}</select>
                        <Button variant="success" size="sm" disabled={saving}
                          onClick={async () => {
                            const amt = Number(String(payVal).replace(/[^\d]/g, ''))
                            if (!(amt > 0)) return toast.error('Nominal harus > 0')
                            setSaving(true); const r = await acc.paySupplierDebt(d.id, Math.min(amt, rem), payMethod, currentUser?.id); setSaving(false)
                            if (r.ok) { toast.success('Pembayaran dicatat'); setPayDebtId(null); setPayVal(''); loadSupplierDebts() }
                            else toast.error(r.error || 'Gagal')
                          }}>Konfirmasi</Button>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>
    </div>
    </Page>
  )
}
