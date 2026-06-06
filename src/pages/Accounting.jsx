import React, { useEffect, useMemo, useState } from 'react'
import {
  Loader2, TrendingUp, TrendingDown, Wallet, Landmark, Banknote, CreditCard,
  Smartphone, Repeat, Receipt, ShoppingCart, Users as UsersIcon, Truck, Scale,
  Plus, Trash2, AlertTriangle, RefreshCw, FileSpreadsheet, Pencil, Check, X, ChevronRight,
} from 'lucide-react'
import { formatRupiah, parseCurrency } from '../utils/helpers'
import { Button } from '../components/ui'
import Modal from '../components/Modal'
import { useToast } from '../components/Toast'
import { useAccounting } from '../hooks/useAccounting'

const fmt = (n) => formatRupiah(Math.round(Number(n) || 0))
const dt = (d) => (d ? new Date(d).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' }) : '—')
const PAY = { cash: 'Cash', transfer: 'Transfer', qris: 'QRIS', hutang: 'Hutang' }
const EXP_CATEGORIES = ['Pembelian Bahan', 'Gaji', 'Listrik', 'Internet', 'Transport', 'Sewa', 'Konsumsi', 'Perawatan Mesin', 'Pengeluaran Lainnya']

function Page({ children, right }) {
  return (
    <div className="flex-1 overflow-y-auto mesh-bg">
      <div className="p-4 sm:p-6 max-w-7xl mx-auto">
        <div className="flex items-start justify-between gap-3 mb-4 flex-wrap">
          <div>
            <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>Keuangan Sederhana</div>
            <h2 className="text-xl sm:text-2xl font-bold mt-0.5" style={{ fontFamily: 'Syne', color: 'var(--text-primary)' }}>Accounting</h2>
          </div>
          {right}
        </div>
        {children}
      </div>
    </div>
  )
}

function MoneyCard({ icon: Icon, label, value, color, onClick }) {
  return (
    <button onClick={onClick}
      className="text-left rounded-2xl p-4 relative overflow-hidden btn-press transition hover:brightness-110"
      style={{ background: 'var(--bg-card)', border: `1px solid ${color}33` }}>
      <div className="flex items-center gap-2 mb-2">
        <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: `${color}1f`, border: `1px solid ${color}44` }}>
          <Icon size={15} style={{ color }} />
        </div>
        <span className="text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>{label}</span>
        <ChevronRight size={13} className="ml-auto" style={{ color: 'var(--text-muted)' }} />
      </div>
      <div className="text-lg font-bold truncate" style={{ fontFamily: 'Syne', color, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
    </button>
  )
}

export default function Accounting({ admins = [], currentUser, editTransaction, deleteTransaction, setActivePage } = {}) {
  const toast = useToast()
  const acc = useAccounting()
  const [from, setFrom] = useState(acc.monthStartISO())
  const [to, setTo] = useState(acc.todayISO())
  const [loading, setLoading] = useState(false)
  const [setupNeeded, setSetupNeeded] = useState(false)
  const [d, setD] = useState(null) // dashboard data

  const adminName = (id) => admins.find(a => a.id === id)?.name || admins.find(a => a.id === id)?.username || '—'

  // detail modal
  const [detail, setDetail] = useState(null) // { key, title, kind }
  const [rows, setRows] = useState([])
  const [detailLoading, setDetailLoading] = useState(false)
  // expense modal
  const [expOpen, setExpOpen] = useState(false)
  const [expForm, setExpForm] = useState({ date: acc.todayISO(), category: 'Pembelian Bahan', amount: '', note: '', method: 'cash' })
  const [saving, setSaving] = useState(false)
  // edit transaction inline
  const [editId, setEditId] = useState(null)
  const [editForm, setEditForm] = useState(null)
  // supplier add/pay
  const [sdForm, setSdForm] = useState({ supplier: '', item: '', total: '', dueDate: '' })
  const [payId, setPayId] = useState(null)
  const [payVal, setPayVal] = useState('')

  const loadDashboard = async () => {
    setLoading(true)
    const res = await acc.getDashboard(from, to)
    if (!res.ok) {
      if (/function|relation|does not exist|schema cache|acc_dashboard/i.test(res.error || '')) setSetupNeeded(true)
      else toast.error(res.error || 'Gagal memuat')
    } else { setD(res.data); setSetupNeeded(false) }
    setLoading(false)
  }
  useEffect(() => { loadDashboard(); /* eslint-disable-next-line */ }, [from, to])

  const laba = useMemo(() => {
    if (!d) return 0
    return Math.round((d.penjualan || 0) - (d.modal_barang || 0) - (d.operasional || 0) - (d.gaji || 0))
  }, [d])

  // ── Detail loader per kartu ──
  const openDetail = async (cfg) => {
    if (cfg.key === 'piutang') { setActivePage?.('piutang'); return }
    setDetail(cfg); setRows([]); setEditId(null); setPayId(null); setDetailLoading(true)
    const r = await cfg.load()
    setRows(r.ok ? r.data : [])
    setDetailLoading(false)
  }
  const reloadDetail = async () => { if (detail) { const r = await detail.load(); setRows(r.ok ? r.data : []) }; loadDashboard() }

  const cards = d ? [
    { key: 'masuk', label: 'Total Uang Masuk', value: d.uang_masuk_total, color: '#10d98a', kind: 'tx', title: 'Uang Masuk', load: () => acc.listTransactions({ from, to }) },
    { key: 'cash', label: 'Cash', value: d.cash, color: '#10d98a', kind: 'tx', title: 'Cash', load: () => acc.listTransactions({ method: 'cash', from, to }) },
    { key: 'transfer', label: 'Transfer', value: d.transfer, color: '#10d98a', kind: 'tx', title: 'Transfer', load: () => acc.listTransactions({ method: 'transfer', from, to }) },
    { key: 'qris', label: 'QRIS', value: d.qris, color: '#10d98a', kind: 'tx', title: 'QRIS', load: () => acc.listTransactions({ method: 'qris', from, to }) },
    { key: 'cicilan', label: 'Pembayaran Cicilan Piutang', value: d.cicilan, color: '#10d98a', kind: 'cicilan', title: 'Pembayaran Cicilan', load: () => acc.listCicilan({ from, to }) },
    { key: 'keluar', label: 'Total Pengeluaran', value: d.pengeluaran_total, color: '#ef4444', kind: 'expense', title: 'Pengeluaran', load: () => acc.listExpensesByBucket({ from, to }) },
    { key: 'bahan', label: 'Pembelian Bahan', value: d.pembelian_bahan, color: '#ef4444', kind: 'expense', title: 'Pembelian Bahan', load: () => acc.listExpensesByBucket({ bucket: 'bahan', from, to }) },
    { key: 'gaji', label: 'Gaji Karyawan', value: d.gaji, color: '#ef4444', kind: 'expense', title: 'Gaji Karyawan', load: () => acc.listExpensesByBucket({ bucket: 'gaji', from, to }) },
    { key: 'operasional', label: 'Operasional', value: d.operasional, color: '#ef4444', kind: 'expense', title: 'Operasional', load: () => acc.listExpensesByBucket({ bucket: 'operasional', from, to }) },
    { key: 'piutang', label: 'Piutang Aktif', value: d.piutang_aktif, color: '#f59e0b', kind: 'nav', title: 'Piutang', load: async () => ({ ok: true, data: [] }) },
    { key: 'supplier', label: 'Hutang Supplier', value: d.hutang_supplier, color: '#fb923c', kind: 'supplier', title: 'Hutang Supplier', load: () => acc.listSupplierDebts() },
    { key: 'kas', label: 'Saldo Kas', value: d.saldo_kas, color: '#38BDF8', kind: 'cash', title: 'Mutasi Kas', load: () => acc.listCashMovements({ channel: 'kas', to }) },
    { key: 'rekening', label: 'Saldo Rekening', value: d.saldo_rekening, color: '#38BDF8', kind: 'cash', title: 'Mutasi Rekening', load: () => acc.listCashMovements({ channel: 'bank', to }) },
    { key: 'laba', label: 'Laba Bersih', value: laba, color: laba >= 0 ? '#a78bfa' : '#ef4444', kind: 'laba', title: 'Rincian Laba', load: async () => ({ ok: true, data: [] }) },
  ] : []

  const inp = { background: 'var(--bg-elevated)', border: '1px solid var(--border)', color: 'var(--text-primary)' }

  // Export Excel (dynamic import)
  const [exporting, setExporting] = useState(false)
  const exportExcel = async () => {
    if (exporting) return
    setExporting(true)
    try {
      const [mod, res] = await Promise.all([import('xlsx'), acc.listTransactions({ from, to, page: 0 })])
      const XLSX = mod.default || mod
      const wb = XLSX.utils.book_new()
      if (d) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(Object.entries(d).map(([k, v]) => ({ Pos: k, Nilai: Math.round(Number(v) || 0) })).concat([{ Pos: 'laba_bersih', Nilai: laba }])), 'Ringkasan')
      if (res.ok) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet((res.data || []).map(t => ({ Tanggal: dt(t.created_at), Invoice: t.invoice_no, Customer: t.customer, Metode: PAY[t.payment_method] || t.payment_method, Total: Math.round(t.total || 0), Dibayar: Math.round(t.paid || 0) }))), 'Transaksi')
      XLSX.writeFile(wb, `accounting-${from}_${to}.xlsx`)
    } catch (e) { toast.error('Export gagal: ' + (e?.message || e)) }
    finally { setExporting(false) }
  }

  if (setupNeeded) {
    return (
      <Page>
        <div className="rounded-2xl p-5" style={{ background: 'rgba(245,158,11,0.06)', border: '1px solid rgba(245,158,11,0.3)' }}>
          <div className="flex items-center gap-2 mb-2" style={{ color: '#f59e0b' }}>
            <AlertTriangle size={16} /> <span className="font-bold text-sm" style={{ fontFamily: 'Syne' }}>Modul Accounting belum aktif</span>
          </div>
          <p className="text-xs leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
            Jalankan migrasi accounting di Supabase → SQL Editor (urut): <code>accounting_module</code> → <code>accounting_suppliers</code> → <code>accounting_rls_fix</code> → <code>accounting_dashboard_rpc</code>.
          </p>
          <Button variant="secondary" className="mt-3" onClick={() => { setSetupNeeded(false); loadDashboard() }}><RefreshCw size={13} /> Coba lagi</Button>
        </div>
      </Page>
    )
  }

  const headerRight = (
    <div className="flex items-center gap-2 flex-wrap">
      <input type="date" value={from} onChange={e => setFrom(e.target.value)} className="px-2 py-1.5 rounded-lg text-xs" style={{ ...inp, colorScheme: 'dark' }} />
      <span style={{ color: 'var(--text-muted)' }}>—</span>
      <input type="date" value={to} onChange={e => setTo(e.target.value)} className="px-2 py-1.5 rounded-lg text-xs" style={{ ...inp, colorScheme: 'dark' }} />
      <Button variant="secondary" size="sm" onClick={() => setExpOpen(true)}><Plus size={13} /> Pengeluaran</Button>
      <button onClick={exportExcel} disabled={exporting} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold btn-press"
        style={{ background: 'rgba(16,217,138,0.12)', color: '#10d98a', border: '1px solid rgba(16,217,138,0.3)', fontFamily: 'Syne' }}>
        {exporting ? <Loader2 size={12} className="animate-spin" /> : <FileSpreadsheet size={12} />} Excel
      </button>
    </div>
  )

  const ICONS = { masuk: TrendingUp, cash: Banknote, transfer: CreditCard, qris: Smartphone, cicilan: Repeat, keluar: TrendingDown, bahan: ShoppingCart, gaji: UsersIcon, operasional: Receipt, piutang: TrendingUp, supplier: Truck, kas: Wallet, rekening: Landmark, laba: Scale }

  return (
    <Page right={headerRight}>
      {loading && !d ? (
        <div className="flex items-center justify-center py-12"><Loader2 size={22} className="animate-spin" style={{ color: 'var(--accent-light)' }} /></div>
      ) : d ? (
        <>
          {/* Laba bersih besar */}
          <div className="rounded-2xl p-4 mb-4" style={{ background: laba >= 0 ? 'rgba(167,139,250,0.10)' : 'rgba(239,68,68,0.10)', border: `1px solid ${laba >= 0 ? 'rgba(167,139,250,0.35)' : 'rgba(239,68,68,0.35)'}` }}>
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div>
                <div className="text-xs font-bold uppercase tracking-wider" style={{ color: 'var(--text-muted)', fontFamily: 'Syne' }}>Laba Bersih (periode)</div>
                <div className="text-2xl font-extrabold" style={{ fontFamily: 'Syne', color: laba >= 0 ? '#a78bfa' : '#ef4444', fontVariantNumeric: 'tabular-nums' }}>{fmt(laba)}</div>
              </div>
              <div className="text-xs text-right" style={{ color: 'var(--text-muted)' }}>
                Penjualan {fmt(d.penjualan)} − Modal {fmt(d.modal_barang)} − Operasional {fmt((d.operasional || 0) + (d.gaji || 0))}
              </div>
            </div>
          </div>

          {/* Kartu uang masuk */}
          <div className="text-xs font-bold uppercase tracking-wider mb-2" style={{ color: '#10d98a', fontFamily: 'Syne' }}>Uang Masuk</div>
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-5">
            {cards.filter(c => ['masuk', 'cash', 'transfer', 'qris', 'cicilan'].includes(c.key)).map(c => (
              <MoneyCard key={c.key} icon={ICONS[c.key]} label={c.label} value={fmt(c.value)} color={c.color} onClick={() => openDetail(c)} />
            ))}
          </div>

          {/* Kartu uang keluar */}
          <div className="text-xs font-bold uppercase tracking-wider mb-2" style={{ color: '#ef4444', fontFamily: 'Syne' }}>Uang Keluar</div>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
            {cards.filter(c => ['keluar', 'bahan', 'gaji', 'operasional'].includes(c.key)).map(c => (
              <MoneyCard key={c.key} icon={ICONS[c.key]} label={c.label} value={fmt(c.value)} color={c.color} onClick={() => openDetail(c)} />
            ))}
          </div>

          {/* Piutang / Hutang / Saldo / Laba */}
          <div className="text-xs font-bold uppercase tracking-wider mb-2" style={{ color: 'var(--accent-light)', fontFamily: 'Syne' }}>Piutang · Hutang · Saldo</div>
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
            {cards.filter(c => ['piutang', 'supplier', 'kas', 'rekening', 'laba'].includes(c.key)).map(c => (
              <MoneyCard key={c.key} icon={ICONS[c.key]} label={c.label} value={fmt(c.value)} color={c.color} onClick={() => openDetail(c)} />
            ))}
          </div>
        </>
      ) : null}

      {/* ── DETAIL MODAL ── */}
      <Modal open={!!detail} onClose={() => setDetail(null)} title={detail ? `Detail: ${detail.title}` : ''} size="xl">
        {detail && (
          <div>
            {detailLoading ? (
              <div className="flex items-center justify-center py-8"><Loader2 size={18} className="animate-spin" style={{ color: 'var(--accent-light)' }} /></div>
            ) : detail.kind === 'laba' ? (
              <div className="space-y-2 text-sm">
                {[['Penjualan', d.penjualan, 'var(--text-primary)'], ['Modal Barang (perkiraan)', -(d.modal_barang || 0), '#f59e0b'], ['Operasional + Gaji', -((d.operasional || 0) + (d.gaji || 0)), '#ef4444']].map(([k, v, c]) => (
                  <div key={k} className="flex justify-between py-1.5" style={{ borderBottom: '1px solid var(--border)' }}><span style={{ color: 'var(--text-muted)' }}>{k}</span><span style={{ color: c, fontVariantNumeric: 'tabular-nums' }}>{fmt(v)}</span></div>
                ))}
                <div className="flex justify-between py-2 font-bold"><span style={{ color: 'var(--text-primary)' }}>Laba Bersih</span><span style={{ color: laba >= 0 ? '#a78bfa' : '#ef4444', fontFamily: 'Syne' }}>{fmt(laba)}</span></div>
              </div>
            ) : (
              <DetailTable
                kind={detail.kind} rows={rows} adminName={adminName} acc={acc}
                editTransaction={editTransaction} deleteTransaction={deleteTransaction}
                editId={editId} setEditId={setEditId} editForm={editForm} setEditForm={setEditForm}
                toast={toast} reload={reloadDetail}
                payId={payId} setPayId={setPayId} payVal={payVal} setPayVal={setPayVal}
                cashierId={currentUser?.id} inp={inp}
              />
            )}
            {detail.kind === 'supplier' && (
              <div className="rounded-xl p-3 mt-4 grid grid-cols-2 sm:grid-cols-4 gap-2" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
                <input value={sdForm.supplier} onChange={e => setSdForm(p => ({ ...p, supplier: e.target.value }))} placeholder="Supplier" className="px-2 py-1.5 rounded-lg text-xs" style={inp} />
                <input value={sdForm.item} onChange={e => setSdForm(p => ({ ...p, item: e.target.value }))} placeholder="Barang" className="px-2 py-1.5 rounded-lg text-xs" style={inp} />
                <input value={sdForm.total} onChange={e => setSdForm(p => ({ ...p, total: e.target.value.replace(/[^\d]/g, '') }))} placeholder="Total hutang" inputMode="numeric" className="px-2 py-1.5 rounded-lg text-xs" style={inp} />
                <Button variant="primary" size="sm" disabled={saving} onClick={async () => {
                  if (!(Number(sdForm.total) > 0)) return toast.error('Total > 0')
                  setSaving(true); const r = await acc.addSupplierDebt(sdForm); setSaving(false)
                  if (r.ok) { toast.success('Hutang supplier dicatat'); setSdForm({ supplier: '', item: '', total: '', dueDate: '' }); reloadDetail() } else toast.error(r.error || 'Gagal')
                }}><Plus size={13} /> Catat</Button>
              </div>
            )}
          </div>
        )}
      </Modal>

      {/* ── TAMBAH PENGELUARAN ── */}
      <Modal open={expOpen} onClose={() => setExpOpen(false)} title="Tambah Pengeluaran" size="sm">
        <div className="space-y-3">
          <div>
            <label className="block text-xs font-semibold mb-1" style={{ color: 'var(--text-secondary)', fontFamily: 'Syne' }}>Tanggal</label>
            <input type="date" value={expForm.date} onChange={e => setExpForm(p => ({ ...p, date: e.target.value }))} className="w-full px-3 py-2 rounded-xl text-sm" style={{ ...inp, colorScheme: 'dark' }} />
          </div>
          <div>
            <label className="block text-xs font-semibold mb-1" style={{ color: 'var(--text-secondary)', fontFamily: 'Syne' }}>Kategori</label>
            <select value={expForm.category} onChange={e => setExpForm(p => ({ ...p, category: e.target.value }))} className="w-full px-3 py-2 rounded-xl text-sm" style={inp}>
              {EXP_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-semibold mb-1" style={{ color: 'var(--text-secondary)', fontFamily: 'Syne' }}>Nominal</label>
            <input value={expForm.amount} onChange={e => setExpForm(p => ({ ...p, amount: e.target.value.replace(/[^\d]/g, '') }))} inputMode="numeric" placeholder="0" className="w-full px-3 py-2 rounded-xl text-sm" style={inp} />
          </div>
          <div>
            <label className="block text-xs font-semibold mb-1" style={{ color: 'var(--text-secondary)', fontFamily: 'Syne' }}>Metode Pembayaran</label>
            <div className="grid grid-cols-2 gap-2">
              {[{ id: 'cash', label: 'Kas' }, { id: 'transfer', label: 'Transfer' }].map(m => (
                <button key={m.id} onClick={() => setExpForm(p => ({ ...p, method: m.id }))} className="py-2 rounded-xl text-xs font-semibold"
                  style={{ background: expForm.method === m.id ? 'rgba(139,92,246,0.15)' : 'var(--bg-card)', border: `1px solid ${expForm.method === m.id ? 'rgba(139,92,246,0.4)' : 'var(--border)'}`, color: expForm.method === m.id ? 'var(--accent-light)' : 'var(--text-muted)', fontFamily: 'Syne' }}>{m.label}</button>
              ))}
            </div>
          </div>
          <input value={expForm.note} onChange={e => setExpForm(p => ({ ...p, note: e.target.value }))} placeholder="Keterangan" className="w-full px-3 py-2 rounded-xl text-sm" style={inp} />
          <Button variant="primary" className="w-full" disabled={saving} onClick={async () => {
            if (!(Number(expForm.amount) > 0)) return toast.error('Nominal harus > 0')
            setSaving(true); const r = await acc.addExpense({ ...expForm, cashierId: currentUser?.id }); setSaving(false)
            if (r.ok) { toast.success('Pengeluaran dicatat'); setExpOpen(false); setExpForm({ date: acc.todayISO(), category: 'Pembelian Bahan', amount: '', note: '', method: 'cash' }); loadDashboard() }
            else toast.error(r.error || 'Gagal')
          }}>{saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Simpan Pengeluaran</Button>
        </div>
      </Modal>
    </Page>
  )
}

// ── Tabel detail generik ──
function DetailTable({ kind, rows, adminName, acc, editTransaction, deleteTransaction, editId, setEditId, editForm, setEditForm, toast, reload, payId, setPayId, payVal, setPayVal, cashierId, inp }) {
  const [busy, setBusy] = useState(false)
  if (!rows || rows.length === 0) return <p className="text-xs text-center py-6" style={{ color: 'var(--text-muted)' }}>Tidak ada data</p>

  const startEdit = (t) => { setEditId(t.id); setEditForm({ paymentMethod: t.payment_method || 'cash', paid: String(Math.round(t.paid || 0)), customer: t.customer || '' }) }
  const saveEdit = async (t) => {
    setBusy(true)
    const r = await editTransaction?.(t.id, { paymentMethod: editForm.paymentMethod, paid: parseCurrency(editForm.paid), customer: editForm.customer })
    setBusy(false)
    if (r?.ok) { toast.success('Transaksi diperbarui'); setEditId(null); reload() } else toast.error(r?.error || 'Gagal')
  }
  const delTx = async (t) => { setBusy(true); const r = await deleteTransaction?.(t.id); setBusy(false); if (r?.ok) { toast.success('Transaksi dihapus'); reload() } else toast.error(r?.error || 'Gagal') }
  const delExp = async (x) => { setBusy(true); const r = await acc.deleteExpense(x.id); setBusy(false); if (r.ok) { toast.success('Dihapus'); reload() } else toast.error(r.error || 'Gagal') }
  const delSup = async (x) => { setBusy(true); const r = await acc.deleteSupplierDebt(x.id); setBusy(false); if (r.ok) { toast.success('Dihapus'); reload() } else toast.error(r.error || 'Gagal') }

  const th = { color: 'var(--text-muted)', fontFamily: 'Syne', fontSize: 10 }

  if (kind === 'tx') {
    return (
      <div className="overflow-x-auto -mx-1">
        <table className="w-full text-xs" style={{ borderCollapse: 'collapse', minWidth: 620 }}>
          <thead><tr style={{ borderBottom: '1px solid var(--border)' }}>
            {['Tanggal', 'Invoice', 'Customer', 'Admin', 'Metode', 'Total', 'Dibayar', ''].map((h, i) => <th key={i} className={`px-2 py-2 ${i >= 5 && i <= 6 ? 'text-right' : 'text-left'}`} style={th}>{h}</th>)}
          </tr></thead>
          <tbody>
            {rows.map(t => editId === t.id ? (
              <tr key={t.id} style={{ background: 'rgba(139,92,246,0.05)', borderBottom: '1px solid var(--border)' }}>
                <td className="px-2 py-2" style={{ color: 'var(--text-muted)' }}>{dt(t.created_at)}</td>
                <td className="px-2 py-2" colSpan={5}>
                  <div className="grid grid-cols-3 gap-2">
                    <input value={editForm.customer} onChange={e => setEditForm(p => ({ ...p, customer: e.target.value }))} placeholder="Customer" className="px-2 py-1 rounded text-xs" style={inp} />
                    <select value={editForm.paymentMethod} onChange={e => setEditForm(p => ({ ...p, paymentMethod: e.target.value }))} className="px-2 py-1 rounded text-xs" style={inp}>{['cash', 'transfer', 'qris', 'hutang'].map(m => <option key={m} value={m}>{PAY[m]}</option>)}</select>
                    <input value={editForm.paid} onChange={e => setEditForm(p => ({ ...p, paid: e.target.value.replace(/[^\d]/g, '') }))} placeholder="Dibayar" className="px-2 py-1 rounded text-xs" style={inp} />
                  </div>
                </td>
                <td className="px-2 py-2 text-right whitespace-nowrap">
                  <button onClick={() => saveEdit(t)} disabled={busy} className="w-6 h-6 rounded inline-flex items-center justify-center mr-1" style={{ background: 'rgba(16,217,138,0.12)', color: '#10d98a' }}>{busy ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />}</button>
                  <button onClick={() => setEditId(null)} className="w-6 h-6 rounded inline-flex items-center justify-center" style={{ background: 'rgba(255,255,255,0.05)', color: 'var(--text-secondary)' }}><X size={11} /></button>
                </td>
              </tr>
            ) : (
              <tr key={t.id} style={{ borderBottom: '1px solid var(--border)' }}>
                <td className="px-2 py-2" style={{ color: 'var(--text-secondary)' }}>{dt(t.created_at)}</td>
                <td className="px-2 py-2 font-semibold" style={{ color: 'var(--text-primary)', fontFamily: 'Syne' }}>{t.invoice_no || '—'}</td>
                <td className="px-2 py-2" style={{ color: 'var(--text-secondary)' }}>{t.customer || '—'}</td>
                <td className="px-2 py-2" style={{ color: 'var(--text-muted)' }}>{adminName(t.cashier_id) !== '—' ? adminName(t.cashier_id) : (t.cashier || '—')}</td>
                <td className="px-2 py-2" style={{ color: 'var(--text-muted)' }}>{PAY[t.payment_method] || t.payment_method}</td>
                <td className="px-2 py-2 text-right" style={{ color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>{fmt(t.total)}</td>
                <td className="px-2 py-2 text-right" style={{ color: '#10d98a', fontVariantNumeric: 'tabular-nums' }}>{fmt(t.paid)}</td>
                <td className="px-2 py-2 text-right whitespace-nowrap">
                  {editTransaction && <button onClick={() => startEdit(t)} className="w-6 h-6 rounded inline-flex items-center justify-center mr-1" style={{ background: 'rgba(139,92,246,0.1)', color: 'var(--accent-light)' }}><Pencil size={11} /></button>}
                  {deleteTransaction && <button onClick={() => delTx(t)} disabled={busy} className="w-6 h-6 rounded inline-flex items-center justify-center" style={{ background: 'rgba(255,77,106,0.08)', color: 'var(--red)' }}><Trash2 size={11} /></button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  }

  if (kind === 'cicilan') {
    return (
      <div className="space-y-2">
        {rows.map(p => (
          <div key={p.id} className="flex items-center gap-3 p-2.5 rounded-xl" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
            <div className="flex-1 min-w-0"><div className="text-xs font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{p.invoice_no || '—'}</div><div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{dt(p.paid_at)} · {PAY[p.payment_method] || p.payment_method} · {adminName(p.cashier_id)}</div></div>
            <div className="text-xs font-bold" style={{ color: '#10d98a', fontVariantNumeric: 'tabular-nums' }}>{fmt(p.amount)}</div>
          </div>
        ))}
      </div>
    )
  }

  if (kind === 'cash') {
    return (
      <div className="space-y-2">
        {rows.map(m => (
          <div key={m.id} className="flex items-center gap-3 p-2.5 rounded-xl" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
            <div className="flex-1 min-w-0"><div className="text-xs font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{m.note || m.invoice_no || (m.direction === 'in' ? 'Masuk' : 'Keluar')}</div><div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{dt(m.moved_at)} · {PAY[m.method] || m.method}</div></div>
            <div className="text-xs font-bold" style={{ color: m.direction === 'in' ? '#10d98a' : '#ef4444', fontVariantNumeric: 'tabular-nums' }}>{m.direction === 'in' ? '+' : '−'}{fmt(m.amount)}</div>
          </div>
        ))}
      </div>
    )
  }

  if (kind === 'supplier') {
    return (
      <div className="space-y-2">
        {rows.map(x => {
          const rem = Math.max(0, Math.round(x.total || 0) - Math.round(x.paid || 0))
          return (
            <div key={x.id} className="rounded-xl p-3" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
              <div className="flex items-center gap-3">
                <div className="flex-1 min-w-0"><div className="text-xs font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{x.supplier || '—'} <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>· {x.item}</span></div><div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>Total {fmt(x.total)} · Bayar {fmt(x.paid)}</div></div>
                <div className="text-right"><div className="text-[10px] uppercase" style={{ color: 'var(--text-muted)' }}>Sisa</div><div className="text-sm font-bold" style={{ color: rem > 0 ? '#ef4444' : '#10d98a' }}>{fmt(rem)}</div></div>
                {rem > 0 && <button onClick={() => { setPayId(payId === x.id ? null : x.id); setPayVal(String(rem)) }} className="px-2.5 h-8 rounded-lg text-xs font-semibold" style={{ background: 'linear-gradient(135deg,#10d98a,#059669)', color: '#fff', fontFamily: 'Syne' }}>Bayar</button>}
                <button onClick={() => delSup(x)} disabled={busy} className="w-7 h-7 rounded-lg inline-flex items-center justify-center" style={{ background: 'rgba(255,77,106,0.08)', color: 'var(--red)' }}><Trash2 size={11} /></button>
              </div>
              {payId === x.id && (
                <div className="flex items-center gap-2 mt-2 pt-2" style={{ borderTop: '1px dashed var(--border)' }}>
                  <input value={payVal} onChange={e => setPayVal(e.target.value.replace(/[^\d]/g, ''))} inputMode="numeric" className="px-2 py-1.5 rounded-lg text-xs flex-1" style={inp} />
                  <Button variant="success" size="sm" disabled={busy} onClick={async () => {
                    const amt = Number(String(payVal).replace(/[^\d]/g, '')); if (!(amt > 0)) return toast.error('Nominal > 0')
                    setBusy(true); const r = await acc.paySupplierDebt(x.id, Math.min(amt, rem), 'cash', cashierId); setBusy(false)
                    if (r.ok) { toast.success('Pembayaran dicatat'); setPayId(null); reload() } else toast.error(r.error || 'Gagal')
                  }}>Konfirmasi</Button>
                </div>
              )}
            </div>
          )
        })}
      </div>
    )
  }

  // expense
  return (
    <div className="space-y-2">
      {rows.map(x => (
        <div key={x.id} className="flex items-center gap-3 p-2.5 rounded-xl" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
          <div className="flex-1 min-w-0"><div className="text-xs font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{x.category} <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>· {x.note}</span></div><div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{dt(x.expense_date)} · {PAY[x.method] || x.method}</div></div>
          <div className="text-xs font-bold" style={{ color: '#ef4444', fontVariantNumeric: 'tabular-nums' }}>{fmt(x.amount)}</div>
          <button onClick={() => delExp(x)} disabled={busy} className="w-7 h-7 rounded-lg inline-flex items-center justify-center" style={{ background: 'rgba(255,77,106,0.08)', color: 'var(--red)' }}><Trash2 size={11} /></button>
        </div>
      ))}
    </div>
  )
}
