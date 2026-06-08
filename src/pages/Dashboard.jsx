import React, { useMemo, useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, BarChart, Bar, PieChart, Pie, Cell, Legend,
} from 'recharts'
import {
  TrendingUp, ShoppingBag, Users, Clock, Receipt,
  ArrowUpRight, Star, Zap, ArrowRight, Activity,
  Scale, Wallet, TrendingDown, PackageOpen, Banknote, CreditCard, Smartphone,
} from 'lucide-react'
import { formatRupiah, formatCompact, formatDateTime, timeAgo, STATUS_MAP, roleLabel, toMoney, formatQty } from '../utils/helpers'
import { Badge, ProductImage } from '../components/ui'
import { getCatLabel, useCategories } from '../hooks/useCategories'
import DashboardCardDetail from '../components/DashboardCardDetail'
import Logo from '../components/Logo'

const COLORS = ['#8b5cf6', '#10d98a', '#f59e0b', '#3b82f6', '#ff4d6a', '#a78bfa']

function StatCard({ icon: Icon, label, value, sub, color = 'accent', trend, delay = 0, onClick }) {
  const colors = {
    accent: { bg: 'rgba(139,92,246,0.12)', icon: '#a78bfa', glow: 'rgba(139,92,246,0.3)' },
    green: { bg: 'rgba(16,217,138,0.12)', icon: '#10d98a', glow: 'rgba(16,217,138,0.3)' },
    amber: { bg: 'rgba(245,158,11,0.12)', icon: '#f59e0b', glow: 'rgba(245,158,11,0.3)' },
    blue: { bg: 'rgba(59,130,246,0.12)', icon: '#3b82f6', glow: 'rgba(59,130,246,0.3)' },
  }
  const c = colors[color] || colors.accent
  return (
    <div
      onClick={onClick}
      className={`animate-slideUp rounded-2xl p-5 relative overflow-hidden ${onClick ? 'cursor-pointer hover:brightness-110 transition' : ''}`}
      style={{
        background: 'var(--bg-card)',
        border: '1px solid var(--border)',
        animationDelay: `${delay}ms`,
      }}
    >
      <div
        className="absolute -top-12 -right-12 w-32 h-32 rounded-full opacity-25"
        style={{ background: c.glow, filter: 'blur(28px)' }}
      />
      <div className="flex items-start justify-between mb-4 relative">
        <div
          className="flex items-center justify-center rounded-xl"
          style={{ width: 44, height: 44, background: c.bg, border: `1px solid ${c.glow}` }}
        >
          {Icon ? <Icon size={20} style={{ color: c.icon }} /> : null}
        </div>
        {trend && (
          <div
            className="flex items-center gap-1 text-xs font-semibold px-2 py-1 rounded-lg"
            style={{ background: 'rgba(16,217,138,0.1)', color: '#10d98a', fontFamily: 'Syne' }}
          >
            <ArrowUpRight size={11} />
            {trend}
          </div>
        )}
      </div>
      <div
        className="text-xl sm:text-2xl font-bold mb-1 relative truncate"
        style={{ fontFamily: 'Syne', color: 'var(--text-primary)' }}
      >
        {value}
      </div>
      <div className="text-xs font-semibold relative" style={{ color: 'var(--text-secondary)' }}>
        {label}
      </div>
      {sub && (
        <div className="text-xs mt-0.5 relative" style={{ color: 'var(--text-muted)' }}>
          {sub}
        </div>
      )}
    </div>
  )
}

const CustomTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null
  return (
    <div
      className="rounded-xl p-3 text-xs"
      style={{
        background: 'rgba(28, 28, 40, 0.95)',
        backdropFilter: 'blur(12px)',
        border: '1px solid var(--border-strong)',
        boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
      }}
    >
      <div
        className="font-semibold mb-2"
        style={{ color: 'var(--text-secondary)', fontFamily: 'Syne' }}
      >
        {label}
      </div>
      {payload.map((p, i) => (
        <div key={i} className="flex items-center gap-2 mb-0.5">
          <div className="w-2 h-2 rounded-full" style={{ background: p.color || p.payload?.fill }} />
          <span style={{ color: 'var(--text-primary)' }}>
            {p.dataKey === 'omzet' ? formatRupiah(p.value) : `${p.value} trx`}
          </span>
        </div>
      ))}
    </div>
  )
}

export default function Dashboard({ stats, transactions, products = [], debts = [], debtPayments = [], admins = [], setActivePage, storeInfo, currentUser, deleteTransaction, editTransaction, editDebtPayment, deleteDebtPayment }) {
  const isOwner = currentUser?.role === 'owner'

  // ─── Owner-only: Total Uang Masuk (uang yang BENAR-BENAR diterima) ───
  // Total  = Σ paid transaksi valid (sudah termasuk DP + cicilan, karena
  //          paid di-update tiap pembayaran). Bukan total invoice.
  // Cash/Transfer/QRIS = pembayaran langsung (non-hutang) per metode
  //          + pembayaran cicilan (debt_payments) per metode.
  // Cicilan = Σ debt_payments.amount.
  // Transaksi 'dibatalkan' & nota terhapus tidak ikut (sudah lenyap dari data).
  const uangMasuk = useMemo(() => {
    const valid = (transactions || []).filter(t => (t.orderStatus || '') !== 'dibatalkan')
    const total = valid.reduce((s, t) => s + toMoney(t.paid), 0)
    const m = { cash: 0, transfer: 0, qris: 0 }
    valid.forEach(t => {
      if (t.paymentMethod && m[t.paymentMethod] !== undefined) {
        m[t.paymentMethod] += toMoney(t.paid)
      }
    })
    let cicilan = 0
    ;(debtPayments || []).forEach(p => {
      const amt = toMoney(p.amount)
      cicilan += amt
      const pm = p.payment_method
      if (m[pm] !== undefined) m[pm] += amt
    })
    return { total, cash: m.cash, transfer: m.transfer, qris: m.qris, cicilan }
  }, [transactions, debtPayments])

  // ─── Owner-only Laba-Rugi: rentang tanggal terpisah ───
  // Laba = total penjualan (transaksi lunas) − modal barang (qty × modal produk).
  const [labaFrom, setLabaFrom] = useState('')
  const [labaTo, setLabaTo] = useState('')

  const modalById = useMemo(() => {
    const m = {}
    ;(products || []).forEach(p => { m[p.id] = Number(p.modal) || 0 })
    return m
  }, [products])

  // Pengeluaran Accounting (deleted_at IS NULL) untuk periode laba-rugi.
  // Diambil dari RPC acc_dashboard.pengeluaran_total — mencakup pengeluaran
  // harian, belanja bahan, pembelian supplier, cicilan/bayar hutang bank,
  // bayar hutang supplier, gaji, operasional, listrik, internet, sewa, dll.
  // OPTIMASI EGRESS: bukan realtime. Refresh saat buka dashboard / ganti
  // tanggal, lalu auto tiap 60 detik HANYA saat tab browser aktif. Tidak
  // re-fetch tiap ada transaksi (pengeluaran tak bergantung transaksi).
  const [pengeluaranAcc, setPengeluaranAcc] = useState(0)
  useEffect(() => {
    if (!isOwner) return
    let alive = true, id = null
    const load = async () => {
      const from = labaFrom || '2000-01-01'
      const to = labaTo || new Date().toISOString().slice(0, 10)
      const { data, error } = await supabase.rpc('acc_dashboard', { p_from: from, p_to: to })
      if (!alive || error || !data) return
      const row = Array.isArray(data) ? data[0] : data
      setPengeluaranAcc(toMoney(row?.pengeluaran_total) || 0)
    }
    const start = () => { if (!id) id = setInterval(load, 60000) }
    const stop = () => { if (id) { clearInterval(id); id = null } }
    const onVis = () => { if (document.visibilityState === 'visible') { load(); start() } else stop() }
    load()
    if (document.visibilityState === 'visible') start()
    document.addEventListener('visibilitychange', onVis)
    return () => { alive = false; stop(); document.removeEventListener('visibilitychange', onVis) }
  }, [isOwner, labaFrom, labaTo])

  const labaRugi = useMemo(() => {
    // Omset = total seluruh invoice/transaksi VALID (non-dibatalkan) dalam rentang.
    let list = (transactions || []).filter(t => (t.orderStatus || '') !== 'dibatalkan')
    if (labaFrom) {
      const f = new Date(labaFrom + 'T00:00:00').getTime()
      list = list.filter(t => new Date(t.date).getTime() >= f)
    }
    if (labaTo) {
      const tt = new Date(labaTo + 'T23:59:59').getTime()
      list = list.filter(t => new Date(t.date).getTime() <= tt)
    }
    let revenue = 0, modal = 0
    list.forEach(t => {
      revenue += toMoney(t.total)
      ;(t.items || []).forEach(i => {
        modal += (Number(i.qty) || 0) * (modalById[i.productId] || 0)
      })
    })
    const pengeluaran = pengeluaranAcc
    // Modal Barang  = Σ(qty × modal produk)  → sudah dihitung di atas (modal)
    // Profit Bruto  = Omset − Modal Barang   (TANPA pengeluaran)
    // Laba Bersih   = Omset − Total Pengeluaran
    const profitBruto = revenue - modal
    const profit = revenue - pengeluaran
    return { revenue, modal, pengeluaran, profitBruto, profit, count: list.length }
  }, [transactions, modalById, labaFrom, labaTo, pengeluaranAcc])

  // ─── Owner-only filter: admin dropdown + date range ───
  // - 'all'      → semua admin gabungan
  // - <adminId>  → hanya transaksi cashier_id == adminId
  const [adminFilter, setAdminFilter] = useState('all')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')

  // Apply filter to a copy of transactions (kecualikan transaksi batal).
  const filteredTrx = useMemo(() => {
    let list = (transactions || []).filter(t => (t.orderStatus || '') !== 'dibatalkan')
    if (adminFilter !== 'all') {
      list = list.filter(t => t.cashierId === adminFilter)
    }
    if (dateFrom) {
      const from = new Date(dateFrom + 'T00:00:00').getTime()
      list = list.filter(t => new Date(t.date).getTime() >= from)
    }
    if (dateTo) {
      const to = new Date(dateTo + 'T23:59:59').getTime()
      list = list.filter(t => new Date(t.date).getTime() <= to)
    }
    return list
  }, [transactions, adminFilter, dateFrom, dateTo])

  // ─── Piutang Aktif (mengikuti filter admin + tanggal dashboard) ───
  // Sumber: debts dengan sisa > 0. Admin via kasir transaksi terkait;
  // tanggal pakai createdAt debt. Nota terhapus sudah lenyap dari data.
  const piutangData = useMemo(() => {
    const cashierByTrx = new Map((transactions || []).map(t => [t.id, t.cashierId]))
    let list = (debts || []).filter(d => Math.max(0, toMoney(d.totalDebt) - toMoney(d.paid)) > 0)
    if (adminFilter !== 'all') list = list.filter(d => cashierByTrx.get(d.transactionId) === adminFilter)
    if (dateFrom) { const f = new Date(dateFrom + 'T00:00:00').getTime(); list = list.filter(d => new Date(d.createdAt).getTime() >= f) }
    if (dateTo) { const tt = new Date(dateTo + 'T23:59:59').getTime(); list = list.filter(d => new Date(d.createdAt).getTime() <= tt) }
    const value = list.reduce((s, d) => s + Math.max(0, toMoney(d.totalDebt) - toMoney(d.paid)), 0)
    const custCount = new Set(list.map(d => d.customerId).filter(Boolean)).size
    return { list, value, custCount, cashierByTrx }
  }, [debts, transactions, adminFilter, dateFrom, dateTo])

  // Per-admin performance rows (calculated on every render — small list)
  const adminPerformance = useMemo(() => {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1).getTime()
    const startOfDay = today.getTime()

    return admins.map(admin => {
      // Hanya transaksi valid (bukan 'dibatalkan'); nota terhapus sudah lenyap dari data.
      const own = (transactions || []).filter(t => t.cashierId === admin.id && (t.orderStatus || '') !== 'dibatalkan')
      const totalOmzet = own.reduce((s, t) => s + (+t.total || 0), 0)
      const omzetToday = own
        .filter(t => new Date(t.date).getTime() >= startOfDay)
        .reduce((s, t) => s + (+t.total || 0), 0)
      const omzetMonth = own
        .filter(t => new Date(t.date).getTime() >= monthStart)
        .reduce((s, t) => s + (+t.total || 0), 0)
      const ownDebts = (debts || []).filter(d => {
        const linked = (transactions || []).find(t => t.id === d.transactionId)
        return linked && linked.cashierId === admin.id
      })
      const debtCreated = ownDebts.reduce((s, d) => s + (+d.totalDebt || 0), 0)
      const debtLunas = ownDebts
        .filter(d => d.status === 'lunas')
        .reduce((s, d) => s + (+d.totalDebt || 0), 0)
      return {
        id: admin.id,
        name: admin.name || admin.username || '—',
        role: admin.role || 'cashier',
        trxCount: own.length,
        totalOmzet,
        omzetToday,
        omzetMonth,
        debtCreated,
        debtLunas,
      }
    }).sort((a, b) => b.totalOmzet - a.totalOmzet)
  }, [admins, transactions, debts])
  const recentTrx = transactions.slice(0, 6)

  // ── Distribusi Kategori — sumber data = kategori produk asli (bukan hardcode) ──
  const { categories } = useCategories() // reaktif: edit/tambah/hapus kategori → recompute
  const [catMode, setCatMode] = useState('penjualan') // 'penjualan' | 'produk'
  const prodCatById = useMemo(() => {
    const m = {}
    ;(products || []).forEach(p => { m[p.id] = p.category })
    return m
  }, [products])
  const pieData = useMemo(() => {
    const agg = {}
    const add = (cat, n) => { const label = getCatLabel(cat) || 'Lainnya'; agg[label] = (agg[label] || 0) + n }
    if (catMode === 'produk') {
      ;(products || []).filter(p => !p.deleted_at).forEach(p => add(p.category, 1))
    } else {
      ;(transactions || []).filter(t => (t.orderStatus || '') !== 'dibatalkan' && (t.status || '') !== 'dibatalkan')
        .forEach(t => (t.items || []).forEach(i => add(prodCatById[i.productId], Number(i.qty) || 0)))
    }
    return Object.entries(agg).map(([name, value]) => ({ name, value })).filter(d => d.value > 0).sort((a, b) => b.value - a.value)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catMode, products, transactions, prodCatById, categories])

  // ─── Owner: detail sumber data tiap kartu (klik untuk audit + edit/hapus) ───
  const [detailKey, setDetailKey] = useState(null)
  const adminName = (id) => admins.find(a => a.id === id)?.name || admins.find(a => a.id === id)?.username || '—'
  const txRow = (t) => ({
    kind: 'transaction',
    id: t.id, invoiceNo: t.invoiceNo, date: t.date, customer: t.customer,
    cashierName: adminName(t.cashierId) !== '—' ? adminName(t.cashierId) : (t.cashier || '—'),
    cashierId: t.cashierId,
    paymentMethod: t.paymentMethod, total: toMoney(t.total), discount: toMoney(t.discount),
    paid: toMoney(t.paid), remaining: toMoney(t.remaining), status: t.status, dueDate: t.dueDate,
    editable: true,
  })
  // Baris pembayaran cicilan (debt_payments) → kind 'payment'
  const custByInvoice = new Map((transactions || []).map(t => [t.invoiceNo, t.customer]))
  const payRow = (p) => ({
    kind: 'payment',
    id: 'dp-' + p.id, paymentId: p.id, invoiceNo: p.invoice_no, date: p.paid_at, paidAt: p.paid_at,
    customer: custByInvoice.get(p.invoice_no) || '(cicilan hutang)',
    cashierName: adminName(p.cashier_id), cashierId: p.cashier_id,
    paymentMethod: p.payment_method,
    total: toMoney(p.amount), paid: toMoney(p.amount), amount: toMoney(p.amount), remaining: 0,
    notes: p.notes || '', status: 'lunas', editable: true,
  })
  const validTx = (transactions || []).filter(t => (t.orderStatus || '') !== 'dibatalkan')
  const today = new Date().toDateString()
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime()
  const sum = (arr, f) => arr.reduce((s, x) => s + f(x), 0)

  const buildCard = (key) => {
    switch (key) {
      case 'omzet': {
        // Omzet = total NILAI semua invoice valid (bukan hanya lunas, bukan paid).
        const base = (adminFilter !== 'all' || dateFrom || dateTo) ? filteredTrx : validTx
        const rows = base.map(txRow)
        return { title: 'Total Omzet', rows, total: sum(rows, r => r.total) }
      }
      case 'omzetToday': {
        const rows = validTx.filter(t => new Date(t.date).toDateString() === today).map(txRow)
        return { title: 'Omzet Hari Ini', rows, total: sum(rows, r => r.total) }
      }
      case 'omzetMonth': {
        const rows = validTx.filter(t => new Date(t.date).getTime() >= monthStart).map(txRow)
        return { title: 'Omzet Bulan Ini', rows, total: sum(rows, r => r.total) }
      }

      case 'orderToday': {
        const rows = validTx.filter(t => new Date(t.date).toDateString() === today).map(txRow)
        return { title: 'Order Hari Ini', rows, total: rows.length, isCount: true }
      }
      case 'orderMonth': {
        const rows = validTx.filter(t => new Date(t.date).getTime() >= monthStart).map(txRow)
        return { title: 'Order Bulan Ini', rows, total: rows.length, isCount: true }
      }
      case 'pending': {
        const rows = validTx.filter(t => t.status === 'pending').map(txRow)
        return { title: 'Pending Order', rows, total: rows.length, isCount: true }
      }
      case 'uangMasuk': {
        const rows = validTx.filter(t => toMoney(t.paid) > 0).map(txRow)
        return { title: 'Total Uang Masuk', rows, total: uangMasuk.total }
      }
      case 'cash': case 'transfer': case 'qris': {
        const direct = validTx.filter(t => t.paymentMethod === key && toMoney(t.paid) > 0).map(txRow)
        const fromCicilan = (debtPayments || []).filter(p => p.payment_method === key).map(payRow)
        const rows = [...direct, ...fromCicilan]
        return { title: key.toUpperCase(), rows, total: uangMasuk[key], payment: true }
      }
      case 'cicilan': {
        const rows = (debtPayments || []).map(payRow)
        return { title: 'Cicilan Hutang', rows, total: uangMasuk.cicilan, payment: true }
      }
      case 'piutang': {
        const rows = piutangData.list.map(d => ({
          id: d.transactionId || d.id, invoiceNo: d.invoiceNo, date: d.createdAt,
          customer: customers.find(c => c.id === d.customerId)?.name || '—',
          cashierName: adminName(piutangData.cashierByTrx.get(d.transactionId)),
          paymentMethod: 'hutang',
          total: toMoney(d.totalDebt), paid: toMoney(d.paid),
          remaining: Math.max(0, toMoney(d.totalDebt) - toMoney(d.paid)),
          dueDate: d.dueDate,
          status: 'pending', editable: !!d.transactionId,
        }))
        // total cocok PERSIS dengan card Piutang Aktif (piutangData.value)
        return { title: 'Piutang Aktif', rows, total: piutangData.value, manage: true }
      }
      case 'penjualan': case 'laba': case 'modal': {
        // Omset = semua transaksi valid (non-dibatalkan), selaras labaRugi.revenue
        let base = validTx.filter(t => (t.orderStatus || '') !== 'dibatalkan')
        if (labaFrom) { const f = new Date(labaFrom + 'T00:00:00').getTime(); base = base.filter(t => new Date(t.date).getTime() >= f) }
        if (labaTo) { const tt = new Date(labaTo + 'T23:59:59').getTime(); base = base.filter(t => new Date(t.date).getTime() <= tt) }
        const rows = base.map(txRow)
        const titles = { penjualan: 'Total Penjualan', laba: 'Profit Bruto', modal: 'Modal Barang' }
        // 'laba' = kartu hijau "Profit Bruto" = Omset − Modal Barang
        const total = key === 'penjualan' ? labaRugi.revenue : key === 'modal' ? labaRugi.modal : labaRugi.profitBruto
        return { title: titles[key], rows, total }
      }
      case 'pelanggan': {
        const rows = (customers || []).map(c => ({
          id: c.id, invoiceNo: '—', date: c.createdAt, customer: c.name, cashierName: '—',
          paymentMethod: '—', total: 0, paid: 0, remaining: 0, status: '-', editable: false,
        }))
        return { title: 'Total Pelanggan', rows, total: rows.length, isCount: true }
      }
      default:
        return { title: key, rows: [], total: 0 }
    }
  }
  const openCard = (key) => { if (isOwner) setDetailKey(key) }
  // Dihitung ulang tiap render → setelah edit/hapus (store refresh) modal
  // langsung menampilkan angka terbaru tanpa reload manual.
  const detailCard = detailKey ? buildCard(detailKey) : null

  return (
    <div className="flex-1 overflow-y-auto mesh-bg" style={{ minHeight: 0, WebkitOverflowScrolling: 'touch' }}>
      <div className="p-4 sm:p-6 max-w-7xl mx-auto" style={{ paddingBottom: 'calc(120px + env(safe-area-inset-bottom))' }}>
        {/* Hero Banner with Logo */}
        <div
          className="relative rounded-2xl overflow-hidden mb-5 animate-fadeIn"
          style={{
            background: 'linear-gradient(135deg, #0a0a0f 0%, #1a0a2e 50%, #0a0a0f 100%)',
            border: '1px solid rgba(139,92,246,0.2)',
          }}
        >
          {/* Decorative glows */}
          <div
            className="absolute -top-20 -right-20 w-72 h-72 rounded-full pointer-events-none"
            style={{ background: 'radial-gradient(circle, rgba(163,255,58,0.18), transparent 70%)', filter: 'blur(20px)' }}
          />
          <div
            className="absolute -bottom-20 -left-20 w-72 h-72 rounded-full pointer-events-none"
            style={{ background: 'radial-gradient(circle, rgba(255,45,190,0.16), transparent 70%)', filter: 'blur(20px)' }}
          />
          <div className="relative flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 p-5 sm:p-6">
            <div className="flex items-center gap-4">
              <div className="hidden sm:block">
                <Logo variant={storeInfo?.frontLogo ? 'icon' : 'full'} size={storeInfo?.frontLogo ? 64 : 64} customSrc={storeInfo?.frontLogo} />
              </div>
              <div className="sm:hidden">
                <Logo size={48} customSrc={storeInfo?.frontLogo} />
              </div>
              <div>
                <div className="text-xs sm:text-sm" style={{ color: 'var(--text-secondary)' }}>
                  Halo, {currentUser?.name || currentUser?.username || 'Admin'} 👋
                </div>
                <h2 className="text-xl sm:text-2xl font-bold mt-0.5"
                  style={{ fontFamily: 'Syne', color: 'var(--text-primary)' }}>
                  {storeInfo?.name || 'Skupy POS'}
                </h2>
              </div>
            </div>
            <button
              onClick={() => setActivePage('kasir')}
              className="flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold btn-press flex-shrink-0"
              style={{
                background: 'linear-gradient(135deg, #a3ff3a 0%, #fff200 100%)',
                color: '#0a0a0f',
                boxShadow: '0 4px 18px rgba(163,255,58,0.35)',
                fontFamily: 'Syne',
              }}
            >
              <Zap size={15} />
              Mulai Transaksi
              <ArrowRight size={14} />
            </button>
          </div>
        </div>

        {/* Filter Bar — Admin & Date Range (owner only) */}
        <div className="rounded-2xl p-3 sm:p-4 mb-5 animate-slideUp"
          style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
          <div className="flex flex-wrap items-center gap-2 sm:gap-3">
            <span className="text-xs font-bold uppercase tracking-wider flex-shrink-0"
              style={{ color: 'var(--text-muted)', fontFamily: 'Syne', letterSpacing: '0.08em' }}>
              Filter
            </span>
            <select
              value={adminFilter}
              onChange={(e) => setAdminFilter(e.target.value)}
              className="px-3 py-2 rounded-xl text-xs font-semibold"
              style={{
                background: 'var(--bg-elevated)',
                border: '1px solid var(--border)',
                color: 'var(--text-primary)',
                fontFamily: 'Syne',
                minWidth: 160,
              }}
            >
              <option value="all">Semua Admin</option>
              {admins.map(a => (
                <option key={a.id} value={a.id}>
                  {(a.name || a.username || '—')} ({roleLabel(a.role)})
                </option>
              ))}
            </select>
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="px-3 py-2 rounded-xl text-xs"
              style={{
                background: 'var(--bg-elevated)',
                border: '1px solid var(--border)',
                color: 'var(--text-primary)',
                colorScheme: 'dark',
              }}
              placeholder="Dari"
              title="Dari tanggal"
            />
            <span style={{ color: 'var(--text-muted)' }}>—</span>
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="px-3 py-2 rounded-xl text-xs"
              style={{
                background: 'var(--bg-elevated)',
                border: '1px solid var(--border)',
                color: 'var(--text-primary)',
                colorScheme: 'dark',
              }}
              placeholder="Sampai"
              title="Sampai tanggal"
            />
            {(adminFilter !== 'all' || dateFrom || dateTo) && (
              <button
                onClick={() => { setAdminFilter('all'); setDateFrom(''); setDateTo('') }}
                className="px-3 py-2 rounded-xl text-xs font-semibold"
                style={{
                  background: 'rgba(139,92,246,0.12)',
                  border: '1px solid rgba(139,92,246,0.3)',
                  color: 'var(--accent-light)',
                  fontFamily: 'Syne',
                }}
              >
                Reset
              </button>
            )}
            <span className="ml-auto text-xs" style={{ color: 'var(--text-muted)', fontFamily: 'DM Sans' }}>
              {filteredTrx.length} transaksi
            </span>
          </div>
        </div>

        {/* Stat Cards — gunakan filteredTrx ketika filter aktif */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 mb-5">
          <StatCard
            icon={TrendingUp}
            label="Total Omzet"
            value={formatRupiah(
              (adminFilter !== 'all' || dateFrom || dateTo)
                ? filteredTrx.reduce((s, t) => s + (+t.total || 0), 0)
                : stats.totalOmzet
            )}
            sub={(adminFilter !== 'all' || dateFrom || dateTo) ? 'Sesuai filter' : 'Semua waktu'}
            color="accent"
            trend="+12%"
            delay={0}
            onClick={isOwner ? () => openCard('omzet') : undefined}
          />
          <StatCard
            icon={ShoppingBag}
            label="Omzet Hari Ini"
            value={formatRupiah(stats.todayOmzet)}
            sub={`${stats.todayTrx.length} transaksi`}
            color="green"
            trend="+8%"
            delay={60}
            onClick={isOwner ? () => openCard('omzetToday') : undefined}
          />
          <StatCard
            icon={Clock}
            label="Pending Order"
            value={stats.pendingCount}
            sub={`+${stats.procesCount} sedang proses`}
            color="amber"
            delay={120}
            onClick={isOwner ? () => openCard('pending') : undefined}
          />
          <StatCard
            icon={Users}
            label="Total Pelanggan"
            value={stats.customers}
            sub={`${stats.totalTransactions} transaksi total`}
            color="blue"
            delay={180}
            onClick={isOwner ? () => openCard('pelanggan') : undefined}
          />
        </div>

        {/* Secondary stat row */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 mb-5">
          <StatCard
            icon={TrendingUp}
            label="Omzet Bulan Ini"
            value={formatRupiah(stats.monthOmzet)}
            sub={new Date().toLocaleDateString('id-ID', { month: 'long' })}
            color="accent"
            delay={0}
            onClick={isOwner ? () => openCard('omzetMonth') : undefined}
          />
          <StatCard
            icon={Receipt}
            label="Order Hari Ini"
            value={stats.todayOrders}
            sub="Transaksi"
            color="green"
            delay={60}
            onClick={isOwner ? () => openCard('orderToday') : undefined}
          />
          <StatCard
            icon={Receipt}
            label="Order Bulan Ini"
            value={stats.monthOrders}
            sub={new Date().toLocaleDateString('id-ID', { month: 'long' })}
            color="blue"
            delay={120}
            onClick={isOwner ? () => openCard('orderMonth') : undefined}
          />
          <StatCard
            icon={Star}
            label="Piutang Aktif"
            value={formatRupiah(piutangData.value)}
            sub={`${piutangData.custCount} customer`}
            color="amber"
            delay={180}
            onClick={isOwner ? () => openCard('piutang') : undefined}
          />
        </div>

        {/* Total Uang Masuk — OWNER ONLY (uang yang benar-benar diterima) */}
        {isOwner && (
          <div className="mb-5">
            <div className="flex items-center gap-2 mb-3">
              <Banknote size={15} style={{ color: '#38BDF8' }} />
              <h2 className="font-bold text-sm" style={{ fontFamily: 'Syne', color: 'var(--text-primary)' }}>
                Total Uang Masuk
              </h2>
              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wider"
                style={{ background: 'rgba(245,158,11,0.15)', color: '#f59e0b', fontFamily: 'Syne' }}>
                Owner
              </span>
            </div>
            <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 sm:gap-4">
              {[
                { key: 'uangMasuk', label: 'Total Uang Masuk', value: uangMasuk.total, icon: Banknote, hint: 'Cash + Transfer + QRIS + Cicilan' },
                { key: 'cash', label: 'Cash', value: uangMasuk.cash, icon: Banknote, hint: 'Pembayaran tunai' },
                { key: 'transfer', label: 'Transfer', value: uangMasuk.transfer, icon: CreditCard, hint: 'Pembayaran transfer' },
                { key: 'qris', label: 'QRIS', value: uangMasuk.qris, icon: Smartphone, hint: 'Pembayaran QRIS' },
              ].map((c, i) => {
                const Icon = c.icon
                const primary = i === 0
                return (
                  <div key={c.label}
                    onClick={() => openCard(c.key)}
                    className="rounded-2xl p-4 relative overflow-hidden animate-slideUp cursor-pointer hover:brightness-110 transition"
                    style={{
                      background: primary
                        ? 'linear-gradient(135deg, rgba(14,165,233,0.14), rgba(56,189,248,0.06))'
                        : 'var(--bg-card)',
                      border: `1px solid ${primary ? 'rgba(56,189,248,0.35)' : 'var(--border)'}`,
                      animationDelay: `${i * 50}ms`,
                    }}>
                    <div className="flex items-center gap-2 mb-2">
                      <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
                        style={{ background: 'rgba(56,189,248,0.12)', border: '1px solid rgba(56,189,248,0.3)' }}>
                        <Icon size={15} style={{ color: '#38BDF8' }} />
                      </div>
                      <span className="text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>{c.label}</span>
                    </div>
                    <div className="text-lg sm:text-xl font-bold truncate"
                      style={{ fontFamily: 'Syne', color: '#38BDF8' }}>
                      {formatRupiah(c.value)}
                    </div>
                    <div className="text-[11px] mt-0.5 truncate" style={{ color: 'var(--text-muted)' }}>{c.hint}</div>
                  </div>
                )
              })}
            </div>
            <p className="text-[11px] mt-2" style={{ color: 'var(--text-muted)' }}>
              Uang yang benar-benar diterima (DP + cicilan), bukan total invoice. Sisa hutang tidak dihitung.
            </p>
          </div>
        )}

        {/* Laba-Rugi — OWNER ONLY (penjualan − modal barang, rentang tanggal sendiri) */}
        {isOwner && (
          <div className="rounded-2xl p-5 mb-5 animate-slideUp relative overflow-hidden"
            style={{
              background: 'linear-gradient(135deg, rgba(16,217,138,0.06), rgba(139,92,246,0.05))',
              border: '1px solid var(--border-strong)',
            }}>
            <div className="absolute -top-16 -right-16 w-48 h-48 rounded-full pointer-events-none"
              style={{ background: 'radial-gradient(circle, rgba(16,217,138,0.18), transparent 70%)', filter: 'blur(30px)' }} />

            <div className="relative flex items-center justify-between flex-wrap gap-3 mb-4">
              <div className="flex items-center gap-2">
                <Scale size={15} style={{ color: '#10d98a' }} />
                <h2 className="font-bold text-sm" style={{ fontFamily: 'Syne', color: 'var(--text-primary)' }}>
                  Laba / Rugi
                </h2>
                <span className="text-[10px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wider"
                  style={{ background: 'rgba(245,158,11,0.15)', color: '#f59e0b', fontFamily: 'Syne' }}>
                  Owner
                </span>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <input
                  type="date"
                  value={labaFrom}
                  onChange={(e) => setLabaFrom(e.target.value)}
                  className="px-3 py-2 rounded-xl text-xs"
                  style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', color: 'var(--text-primary)', colorScheme: 'dark' }}
                  title="Dari tanggal"
                />
                <span style={{ color: 'var(--text-muted)' }}>—</span>
                <input
                  type="date"
                  value={labaTo}
                  onChange={(e) => setLabaTo(e.target.value)}
                  className="px-3 py-2 rounded-xl text-xs"
                  style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', color: 'var(--text-primary)', colorScheme: 'dark' }}
                  title="Sampai tanggal"
                />
                {(labaFrom || labaTo) && (
                  <button
                    onClick={() => { setLabaFrom(''); setLabaTo('') }}
                    className="px-3 py-2 rounded-xl text-xs font-semibold"
                    style={{ background: 'rgba(139,92,246,0.12)', border: '1px solid rgba(139,92,246,0.3)', color: 'var(--accent-light)', fontFamily: 'Syne' }}
                  >
                    Reset
                  </button>
                )}
              </div>
            </div>

            <div className="relative grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {/* Total Omset */}
              <div onClick={() => openCard('penjualan')}
                className="rounded-xl p-4 cursor-pointer hover:brightness-110 transition"
                style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
                <div className="flex items-center gap-2 mb-2">
                  <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
                    style={{ background: 'rgba(139,92,246,0.12)', border: '1px solid rgba(139,92,246,0.3)' }}>
                    <Wallet size={15} style={{ color: '#a78bfa' }} />
                  </div>
                  <span className="text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>Total Omset</span>
                </div>
                <div className="text-lg sm:text-xl font-bold" style={{ fontFamily: 'Syne', color: 'var(--text-primary)' }}>
                  {formatRupiah(labaRugi.revenue)}
                </div>
                <div className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                  {labaRugi.count} transaksi valid
                </div>
              </div>

              {/* Total Pengeluaran (Accounting) */}
              <div
                className="rounded-xl p-4"
                style={{ background: 'rgba(255,77,106,0.06)', border: '1px solid rgba(255,77,106,0.25)' }}>
                <div className="flex items-center gap-2 mb-2">
                  <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
                    style={{ background: 'rgba(255,77,106,0.12)', border: '1px solid rgba(255,77,106,0.3)' }}>
                    <TrendingDown size={15} style={{ color: '#ff4d6a' }} />
                  </div>
                  <span className="text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>Total Pengeluaran</span>
                </div>
                <div className="text-lg sm:text-xl font-bold" style={{ fontFamily: 'Syne', color: '#ff4d6a' }}>
                  {formatRupiah(labaRugi.pengeluaran)}
                </div>
                <div className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                  Dari modul Accounting
                </div>
              </div>

              {/* LABA BERSIH = Omset − Pengeluaran (kartu biru) */}
              <div
                className="rounded-xl p-4"
                style={{
                  background: labaRugi.profit >= 0 ? 'rgba(59,130,246,0.08)' : 'rgba(255,77,106,0.08)',
                  border: `1px solid ${labaRugi.profit >= 0 ? 'rgba(59,130,246,0.3)' : 'rgba(255,77,106,0.3)'}`,
                }}>
                <div className="flex items-center gap-2 mb-2">
                  <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
                    style={{ background: 'rgba(59,130,246,0.15)', border: '1px solid rgba(59,130,246,0.4)' }}>
                    <Scale size={15} style={{ color: '#3b82f6' }} />
                  </div>
                  <span className="text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>Laba Bersih</span>
                </div>
                <div className="text-lg sm:text-xl font-bold"
                  style={{ fontFamily: 'Syne', color: labaRugi.profit >= 0 ? '#3b82f6' : '#ff4d6a' }}>
                  {formatRupiah(labaRugi.profit)}
                </div>
                <div className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                  Omset − Pengeluaran
                </div>
              </div>

              {/* Modal Barang */}
              <div onClick={() => openCard('modal')}
                className="rounded-xl p-4 cursor-pointer hover:brightness-110 transition"
                style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
                <div className="flex items-center gap-2 mb-2">
                  <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
                    style={{ background: 'rgba(245,158,11,0.12)', border: '1px solid rgba(245,158,11,0.3)' }}>
                    <PackageOpen size={15} style={{ color: '#f59e0b' }} />
                  </div>
                  <span className="text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>Modal Barang</span>
                </div>
                <div className="text-lg sm:text-xl font-bold" style={{ fontFamily: 'Syne', color: '#f59e0b' }}>
                  {formatRupiah(labaRugi.modal)}
                </div>
                <div className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                  Harga modal terjual
                </div>
              </div>

              {/* PROFIT BRUTO = Omset − Modal Barang (kartu hijau) */}
              <div onClick={() => openCard('laba')}
                className="rounded-xl p-4 cursor-pointer hover:brightness-110 transition lg:col-span-2"
                style={{
                  background: labaRugi.profitBruto >= 0 ? 'rgba(16,217,138,0.08)' : 'rgba(255,77,106,0.08)',
                  border: `1px solid ${labaRugi.profitBruto >= 0 ? 'rgba(16,217,138,0.3)' : 'rgba(255,77,106,0.3)'}`,
                }}>
                <div className="flex items-center gap-2 mb-2">
                  <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
                    style={{
                      background: labaRugi.profitBruto >= 0 ? 'rgba(16,217,138,0.15)' : 'rgba(255,77,106,0.15)',
                      border: `1px solid ${labaRugi.profitBruto >= 0 ? 'rgba(16,217,138,0.4)' : 'rgba(255,77,106,0.4)'}`,
                    }}>
                    {labaRugi.profitBruto >= 0
                      ? <TrendingUp size={15} style={{ color: '#10d98a' }} />
                      : <TrendingDown size={15} style={{ color: '#ff4d6a' }} />}
                  </div>
                  <span className="text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>
                    {labaRugi.profitBruto >= 0 ? 'Profit Bruto' : 'Rugi Kotor'}
                  </span>
                </div>
                <div className="text-lg sm:text-xl font-bold"
                  style={{ fontFamily: 'Syne', color: labaRugi.profitBruto >= 0 ? '#10d98a' : '#ff4d6a' }}>
                  {formatRupiah(labaRugi.profitBruto)}
                </div>
                <div className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                  Omset − Modal Barang{labaRugi.revenue > 0 ? ` · Margin ${Math.round((labaRugi.profitBruto / labaRugi.revenue) * 100)}%` : ''}
                </div>
              </div>
            </div>

            <p className="relative text-[11px] mt-3" style={{ color: 'var(--text-muted)' }}>
              {(labaFrom || labaTo)
                ? `Periode: ${labaFrom || '…'} s/d ${labaTo || '…'}`
                : 'Periode: semua waktu (atur tanggal untuk memfilter)'}
            </p>
          </div>
        )}

        {/* Performa per Admin — OWNER ONLY (staff admin tidak melihat ini) */}
        {isOwner && adminPerformance.length > 0 && (
          <div className="rounded-2xl p-5 mb-5 animate-slideUp"
            style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
            <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
              <div className="flex items-center gap-2">
                <Star size={14} style={{ color: 'var(--accent-light)' }} />
                <h2 className="font-bold text-sm" style={{ fontFamily: 'Syne', color: 'var(--text-primary)' }}>
                  Performa per Admin
                </h2>
              </div>
              <span className="text-xs" style={{ color: 'var(--text-muted)', fontFamily: 'DM Sans' }}>
                Gabungan: {formatRupiah(adminPerformance.reduce((s, a) => s + a.totalOmzet, 0))}
              </span>
            </div>
            <div className="overflow-x-auto -mx-1">
              <table className="w-full text-xs" style={{ borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border)' }}>
                    <th className="px-2 py-2 text-left font-bold uppercase tracking-wider"
                      style={{ color: 'var(--text-muted)', fontFamily: 'Syne', fontSize: 10, letterSpacing: '0.08em' }}>
                      Admin
                    </th>
                    <th className="px-2 py-2 text-center font-bold uppercase tracking-wider"
                      style={{ color: 'var(--text-muted)', fontFamily: 'Syne', fontSize: 10 }}>
                      Total Trx
                    </th>
                    <th className="px-2 py-2 text-right font-bold uppercase tracking-wider"
                      style={{ color: 'var(--text-muted)', fontFamily: 'Syne', fontSize: 10 }}>
                      Hari Ini
                    </th>
                    <th className="px-2 py-2 text-right font-bold uppercase tracking-wider"
                      style={{ color: 'var(--text-muted)', fontFamily: 'Syne', fontSize: 10 }}>
                      Bulan Ini
                    </th>
                    <th className="px-2 py-2 text-right font-bold uppercase tracking-wider"
                      style={{ color: 'var(--text-muted)', fontFamily: 'Syne', fontSize: 10 }}>
                      Total Omzet
                    </th>
                    <th className="px-2 py-2 text-right font-bold uppercase tracking-wider"
                      style={{ color: 'var(--text-muted)', fontFamily: 'Syne', fontSize: 10 }}>
                      Piutang
                    </th>
                    <th className="px-2 py-2 text-right font-bold uppercase tracking-wider"
                      style={{ color: 'var(--text-muted)', fontFamily: 'Syne', fontSize: 10 }}>
                      Lunas
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {adminPerformance.map(a => (
                    <tr key={a.id} style={{ borderBottom: '1px solid var(--border)' }}>
                      <td className="px-2 py-3" style={{ color: 'var(--text-primary)' }}>
                        <div className="flex items-center gap-2">
                          <div className="w-7 h-7 rounded-lg flex items-center justify-center text-xs font-bold flex-shrink-0"
                            style={{
                              background: a.role === 'owner'
                                ? 'linear-gradient(135deg, #f59e0b, #ea580c)'
                                : 'linear-gradient(135deg, #8b5cf6, #6366f1)',
                              color: '#fff', fontFamily: 'Syne',
                            }}>
                            {(a.name || '?')[0].toUpperCase()}
                          </div>
                          <div className="min-w-0">
                            <div className="font-semibold leading-tight truncate" style={{ fontFamily: 'Syne' }}>{a.name}</div>
                            <div className="text-[10px] truncate" style={{ color: 'var(--text-muted)' }}>{roleLabel(a.role)}</div>
                          </div>
                        </div>
                      </td>
                      <td className="px-2 py-3 text-center font-bold" style={{ color: 'var(--text-primary)', fontFamily: 'Syne', fontVariantNumeric: 'tabular-nums' }}>
                        {a.trxCount}
                      </td>
                      <td className="px-2 py-3 text-right" style={{ color: 'var(--text-secondary)', fontFamily: 'Syne', fontVariantNumeric: 'tabular-nums' }}>
                        {formatRupiah(a.omzetToday)}
                      </td>
                      <td className="px-2 py-3 text-right" style={{ color: 'var(--text-secondary)', fontFamily: 'Syne', fontVariantNumeric: 'tabular-nums' }}>
                        {formatRupiah(a.omzetMonth)}
                      </td>
                      <td className="px-2 py-3 text-right font-bold" style={{ color: 'var(--accent-light)', fontFamily: 'Syne', fontVariantNumeric: 'tabular-nums' }}>
                        {formatRupiah(a.totalOmzet)}
                      </td>
                      <td className="px-2 py-3 text-right" style={{ color: '#f59e0b', fontFamily: 'Syne', fontVariantNumeric: 'tabular-nums' }}>
                        {formatRupiah(a.debtCreated)}
                      </td>
                      <td className="px-2 py-3 text-right" style={{ color: '#10d98a', fontFamily: 'Syne', fontVariantNumeric: 'tabular-nums' }}>
                        {formatRupiah(a.debtLunas)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Top customers strip */}
        {stats.topCustomers?.length > 0 && (
          <div className="rounded-2xl p-5 mb-5 animate-slideUp"
            style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Users size={14} style={{ color: 'var(--accent-light)' }} />
                <h2 className="font-bold text-sm" style={{ fontFamily: 'Syne', color: 'var(--text-primary)' }}>
                  Pelanggan Teraktif
                </h2>
              </div>
              <button onClick={() => setActivePage('customers')}
                className="text-xs font-semibold hover:underline"
                style={{ color: 'var(--accent-light)', fontFamily: 'Syne' }}>
                Lihat semua →
              </button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2">
              {stats.topCustomers.slice(0, 5).map((c, i) => (
                <div key={c.id}
                  className="flex items-center gap-2 p-2.5 rounded-xl"
                  style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}>
                  <div className="w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold flex-shrink-0"
                    style={{
                      background: i === 0
                        ? 'linear-gradient(135deg, #f59e0b, #ea580c)'
                        : 'linear-gradient(135deg, var(--accent), #6366f1)',
                      color: '#fff', fontFamily: 'Syne',
                    }}>
                    {(c.name || '?')[0].toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-semibold truncate"
                      style={{ color: 'var(--text-primary)' }}>
                      {c.name}
                    </p>
                    <p className="text-xs truncate" style={{ color: 'var(--accent-light)', fontFamily: 'Syne' }}>
                      {formatRupiah(c.totalSpent)}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Charts row */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-4">
          {/* Sales chart */}
          <div className="lg:col-span-2 rounded-2xl p-5 animate-slideUp"
            style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', animationDelay: '240ms' }}>
            <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
              <div>
                <h2 className="font-bold text-sm" style={{ fontFamily: 'Syne', color: 'var(--text-primary)' }}>
                  Grafik Penjualan
                </h2>
                <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                  7 hari terakhir
                </p>
              </div>
              <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                <span className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full" style={{ background: '#8b5cf6' }} />
                  Omzet
                </span>
              </div>
            </div>
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={stats.chartData} margin={{ left: -8, right: 0, top: 8, bottom: 0 }}>
                <defs>
                  <linearGradient id="omzetGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#8b5cf6" stopOpacity={0.4} />
                    <stop offset="100%" stopColor="#8b5cf6" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" vertical={false} />
                <XAxis
                  dataKey="day"
                  tick={{ fill: 'var(--text-muted)', fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fill: 'var(--text-muted)', fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={(v) => formatCompact(v)}
                />
                <Tooltip content={<CustomTooltip />} cursor={{ stroke: 'rgba(139,92,246,0.2)' }} />
                <Area
                  type="monotone"
                  dataKey="omzet"
                  stroke="#8b5cf6"
                  strokeWidth={2.5}
                  fill="url(#omzetGrad)"
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>

          {/* Top Products */}
          <div className="rounded-2xl p-5 animate-slideUp"
            style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', animationDelay: '300ms' }}>
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Star size={14} style={{ color: 'var(--accent-light)' }} />
                <h2 className="font-bold text-sm" style={{ fontFamily: 'Syne', color: 'var(--text-primary)' }}>
                  Produk Terlaris
                </h2>
              </div>
            </div>
            <div className="space-y-3">
              {stats.topProducts.map((p, i) => (
                <div key={p.id} className="flex items-center gap-3">
                  <div
                    className="flex-shrink-0 font-bold text-xs w-6 text-center"
                    style={{
                      color: i === 0 ? '#f59e0b' : i === 1 ? '#c0c0c0' : 'var(--text-muted)',
                      fontFamily: 'Syne',
                    }}
                  >
                    #{i + 1}
                  </div>
                  <ProductImage
                    src={p.image}
                    alt={p.name}
                    className="w-10 h-10 rounded-lg object-cover flex-shrink-0"
                    fallbackSize={40}
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                      {p.name}
                    </p>
                    <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                      {formatQty(p.sold, p.unit)} terjual
                    </p>
                  </div>
                  <div className="text-xs font-bold" style={{ color: 'var(--accent-light)', fontFamily: 'Syne' }}>
                    {formatRupiah(Math.round(p.price * p.sold))}
                  </div>
                </div>
              ))}
              {stats.topProducts.length === 0 && (
                <p className="text-xs text-center py-6" style={{ color: 'var(--text-muted)' }}>
                  Belum ada data
                </p>
              )}
            </div>
          </div>
        </div>

        {/* Bar + Pie + Recent */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="rounded-2xl p-5 animate-slideUp"
            style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', animationDelay: '360ms' }}>
            <div className="flex items-center gap-2 mb-3">
              <Activity size={14} style={{ color: '#10d98a' }} />
              <h2 className="font-bold text-sm" style={{ fontFamily: 'Syne', color: 'var(--text-primary)' }}>
                Jumlah Transaksi
              </h2>
            </div>
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={stats.chartData} margin={{ left: -10, right: 0, top: 8, bottom: 0 }}>
                <defs>
                  <linearGradient id="barGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#10d98a" stopOpacity={1} />
                    <stop offset="100%" stopColor="#10d98a" stopOpacity={0.4} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" vertical={false} />
                <XAxis
                  dataKey="day"
                  tick={{ fill: 'var(--text-muted)', fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fill: 'var(--text-muted)', fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                  allowDecimals={false}
                />
                <Tooltip content={<CustomTooltip />} cursor={{ fill: 'rgba(255,255,255,0.02)' }} />
                <Bar dataKey="transaksi" fill="url(#barGrad)" radius={[6, 6, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Pie chart - distribusi kategori (kategori produk asli) */}
          <div className="rounded-2xl p-5 animate-slideUp"
            style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', animationDelay: '420ms' }}>
            <div className="flex items-center justify-between gap-2 mb-3 flex-wrap">
              <h2 className="font-bold text-sm" style={{ fontFamily: 'Syne', color: 'var(--text-primary)' }}>
                Distribusi Kategori
              </h2>
              <div className="flex rounded-lg p-0.5" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}>
                {[['penjualan', 'Penjualan'], ['produk', 'Produk']].map(([k, label]) => (
                  <button key={k} onClick={() => setCatMode(k)}
                    className="px-2.5 py-1 rounded-md text-[11px] font-semibold transition"
                    style={{ background: catMode === k ? 'linear-gradient(135deg, var(--accent), #6366f1)' : 'transparent', color: catMode === k ? '#fff' : 'var(--text-muted)', fontFamily: 'Syne' }}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
            {pieData.length === 0 ? (
              <div className="flex items-center justify-center" style={{ height: 180 }}>
                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Belum ada data kategori</p>
              </div>
            ) : (
              <>
                <ResponsiveContainer width="100%" height={180}>
                  <PieChart>
                    <Pie data={pieData} cx="50%" cy="50%" innerRadius={40} outerRadius={70} paddingAngle={3} dataKey="value" stroke="none">
                      {pieData.map((_, i) => (<Cell key={i} fill={COLORS[i % COLORS.length]} />))}
                    </Pie>
                    <Tooltip
                      contentStyle={{ background: 'rgba(28,28,40,0.95)', border: '1px solid var(--border-strong)', borderRadius: 12, fontSize: 11 }}
                      formatter={(v) => catMode === 'produk' ? `${v} produk` : `${formatQty(v)} terjual`}
                    />
                  </PieChart>
                </ResponsiveContainer>
                <div className="flex flex-wrap gap-x-3 gap-y-1.5 mt-2 max-h-20 overflow-y-auto">
                  {pieData.map((p, i) => (
                    <div key={p.name} className="flex items-center gap-1.5 text-xs min-w-0" style={{ color: 'var(--text-secondary)', maxWidth: '48%' }}>
                      <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: COLORS[i % COLORS.length] }} />
                      <span className="truncate">{p.name}</span>
                      <span className="flex-shrink-0" style={{ color: 'var(--text-muted)' }}>· {p.value}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* Recent Transactions */}
          <div className="rounded-2xl p-5 animate-slideUp"
            style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', animationDelay: '480ms' }}>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Receipt size={14} style={{ color: 'var(--accent-light)' }} />
                <h2 className="font-bold text-sm"
                  style={{ fontFamily: 'Syne', color: 'var(--text-primary)' }}>
                  Transaksi Terbaru
                </h2>
              </div>
              <button
                onClick={() => setActivePage('order')}
                className="text-xs font-semibold hover:underline"
                style={{ color: 'var(--accent-light)', fontFamily: 'Syne' }}
              >
                Lihat semua →
              </button>
            </div>
            <div className="space-y-2">
              {recentTrx.slice(0, 4).map((t) => {
                if (!t) return null
                const s = STATUS_MAP[t.status] || { label: t.status || 'Pending', color: 'gray', hex: '#8888a8' }
                return (
                  <div
                    key={t.id}
                    className="flex items-center gap-2.5 p-2.5 rounded-xl"
                    style={{ background: 'rgba(255,255,255,0.02)' }}
                  >
                    <div
                      className="flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold"
                      style={{
                        background: 'linear-gradient(135deg, rgba(139,92,246,0.18), rgba(99,102,241,0.08))',
                        color: 'var(--accent-light)',
                        fontFamily: 'Syne',
                        border: '1px solid rgba(139,92,246,0.15)',
                      }}
                    >
                      {(t.customer || '?')[0]}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                        {t.customer}
                      </p>
                      <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                        {timeAgo(t.date)}
                      </p>
                    </div>
                    <div className="text-right flex-shrink-0">
                      <p className="text-xs font-bold" style={{ color: 'var(--text-primary)' }}>
                        {formatRupiah(t.total)}
                      </p>
                      <Badge color={s.color}>{s.label}</Badge>
                    </div>
                  </div>
                )
              })}
              {recentTrx.length === 0 && (
                <p className="text-xs text-center py-6" style={{ color: 'var(--text-muted)' }}>
                  Belum ada transaksi
                </p>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Detail sumber data tiap kartu — OWNER ONLY */}
      {isOwner && detailCard && (
        <DashboardCardDetail
          open
          onClose={() => setDetailKey(null)}
          title={detailCard.title}
          rows={detailCard.rows}
          total={detailCard.total}
          isCount={detailCard.isCount}
          showDue={detailCard.manage}
          paymentMode={!!detailCard.payment}
          admins={admins}
          onManage={detailCard.manage ? () => { setDetailKey(null); setActivePage('piutang') } : undefined}
          manageLabel="Bayar / Kelola di Piutang"
          onEdit={async (id, fields) => editTransaction?.(id, fields)}
          onDelete={async (id) => deleteTransaction?.(id)}
          onSavePaymentRow={async (row, f) => (
            // Edit pembayaran: cicilan → editDebtPayment; transaksi langsung → editTransaction
            row.kind === 'payment'
              ? editDebtPayment?.(row.paymentId, {
                  paymentMethod: f.paymentMethod, amount: f.amount,
                  paidAt: f.date, cashierId: f.cashierId, notes: f.customer,
                })
              : editTransaction?.(row.id, {
                  paymentMethod: f.paymentMethod, paid: f.amount, date: f.date, customer: f.customer,
                })
          )}
          onDeletePaymentRow={async (row) => (
            row.kind === 'payment' ? deleteDebtPayment?.(row.paymentId) : deleteTransaction?.(row.id)
          )}
        />
      )}
    </div>
  )
}
