import React, { useMemo, useState } from 'react'
import {
  Search, Wallet, Trash2, AlertTriangle, CalendarDays, Crown,
  CheckCircle2, History, Loader2, TrendingDown, ChevronRight,
  Receipt, Layers,
} from 'lucide-react'
import { Button, Badge, EmptyState } from '../components/ui'
import Modal from '../components/Modal'
import WhatsAppButton from '../components/WhatsAppButton'
import WhatsAppReminder from '../components/WhatsAppReminder'
import { formatRupiah, formatDate, timeAgo, parseCurrency, toMoney } from '../utils/helpers'
import { TEMPLATES } from '../utils/whatsapp'
import { useToast } from '../components/Toast'

const STATUS_OPTIONS = [
  { id: 'all', label: 'Semua' },
  { id: 'aktif', label: 'Aktif' },
  { id: 'lunas', label: 'Lunas' },
]

const remOf = (d) => Math.max(0, toMoney(d.totalDebt) - toMoney(d.paid))

// Alokasi pembayaran FIFO: invoice paling lama (urut ASC) dilunasi dulu.
// Mengembalikan tiap invoice + { before, pay, after }.
function allocateFIFO(invoicesAsc, amount) {
  let left = Math.max(0, toMoney(amount))
  return invoicesAsc.map((inv) => {
    const before = remOf(inv)
    const pay = Math.min(left, before)
    left -= pay
    const after = before - pay
    return { inv, before, pay, after }
  })
}

export default function Piutang({
  debts, customers, transactions, admins = [], currentUser,
  payDebt, payCustomerDebtsFIFO, deleteDebt, getDebtPayments,
}) {
  const toast = useToast()
  const isOwner = currentUser?.role === 'owner'
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('aktif')
  // Owner bisa filter per admin/kasir. Staff: debts sudah di-scope di App
  // (hanya transaksi miliknya), jadi filter ini disembunyikan.
  const [adminFilter, setAdminFilter] = useState('all')
  const [detailTarget, setDetailTarget] = useState(null)  // group
  const [payTarget, setPayTarget] = useState(null)        // group (Bayar Gabungan)
  const [payAmount, setPayAmount] = useState('')
  const [payMethod, setPayMethod] = useState('cash')
  const [paying, setPaying] = useState(false)
  const [delTarget, setDelTarget] = useState(null)        // single debt
  const [historyTarget, setHistoryTarget] = useState(null) // group
  const [history, setHistory] = useState([])
  const [loadingHistory, setLoadingHistory] = useState(false)

  // Peta debt → cashierId (lewat transaksi terkait) untuk filter per-admin owner.
  const cashierOf = useMemo(() => {
    const byId = new Map((transactions || []).map(t => [t.id, t.cashierId]))
    return (d) => byId.get(d.transactionId)
  }, [transactions])

  // ── Enrich tiap hutang dengan customer + sisa yang diderivasi ──
  const enriched = useMemo(() => debts.map(d => ({
    ...d,
    remaining: remOf(d),
    cashierId: cashierOf(d),
    customer: customers.find(c => c.id === d.customerId)
      || { name: 'Customer dihapus', phone: '', whatsapp: '' },
  })), [debts, customers, cashierOf])

  // Owner filter per admin (staff: tidak ada efek karena data sudah di-scope).
  const scopedEnriched = useMemo(() => (
    adminFilter === 'all' ? enriched : enriched.filter(d => d.cashierId === adminFilter)
  ), [enriched, adminFilter])

  // ── Ringkasan piutang (dari data yang SUDAH di-scope) ──
  //   Piutang Aktif = Σ sisa (remaining > 0)
  //   Sudah Bayar   = Σ paid  (DP + cicilan + pelunasan) — bukan hanya invoice lunas
  const summary = useMemo(() => {
    let piutangAktif = 0, sudahBayar = 0, totalTagihan = 0
    const activeCust = new Set()
    scopedEnriched.forEach(d => {
      const rem = remOf(d)
      piutangAktif += rem
      sudahBayar += toMoney(d.paid)
      totalTagihan += toMoney(d.totalDebt)
      if (rem > 0 && d.customerId) activeCust.add(d.customerId)
    })
    // Top debtors (per customer, sisa terbesar)
    const map = new Map()
    scopedEnriched.forEach(d => {
      const rem = remOf(d)
      if (rem <= 0) return
      const cur = map.get(d.customer.name) || { name: d.customer.name, totalRemaining: 0 }
      cur.totalRemaining += rem
      map.set(d.customer.name, cur)
    })
    const topDebtors = [...map.values()].sort((a, b) => b.totalRemaining - a.totalRemaining).slice(0, 5)
    return { piutangAktif, sudahBayar, totalTagihan, activeCount: activeCust.size, topDebtors }
  }, [scopedEnriched])

  // ── Grouping per customer (fallback ke nama kalau customerId kosong) ──
  const groups = useMemo(() => {
    const map = new Map()
    scopedEnriched.forEach(d => {
      const key = d.customerId || `name:${(d.customer.name || '').toLowerCase()}`
      if (!map.has(key)) {
        map.set(key, { key, customerId: d.customerId, customer: d.customer, invoices: [] })
      }
      map.get(key).invoices.push(d)
    })
    return [...map.values()].map(g => {
      const invoices = g.invoices.slice()
        .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
      const totalDebt = invoices.reduce((s, d) => s + toMoney(d.totalDebt), 0)
      const totalPaid = invoices.reduce((s, d) => s + toMoney(d.paid), 0)
      const totalRemaining = invoices.reduce((s, d) => s + remOf(d), 0)
      const activeInvoices = invoices.filter(d => remOf(d) > 0)
      const dueList = activeInvoices.map(d => d.dueDate).filter(Boolean).sort()
      const nearestDue = dueList[0] || null
      const status = totalRemaining > 0 ? 'aktif' : 'lunas'
      const overdue = nearestDue && new Date(nearestDue) < new Date() && totalRemaining > 0
      return {
        ...g, invoices, activeInvoices,
        count: invoices.length, activeCount: activeInvoices.length,
        totalDebt, totalPaid, totalRemaining, nearestDue, status, overdue,
      }
    }).sort((a, b) => b.totalRemaining - a.totalRemaining || b.totalDebt - a.totalDebt)
  }, [scopedEnriched])

  const filteredGroups = useMemo(() => {
    const q = search.toLowerCase()
    return groups.filter(g => {
      const matchQ = !q
        || (g.customer.name || '').toLowerCase().includes(q)
        || g.invoices.some(d => (d.invoiceNo || '').toLowerCase().includes(q))
      const matchFilter = filter === 'all' ? true : g.status === filter
      return matchQ && matchFilter
    })
  }, [groups, search, filter])

  // Keep detail/pay modal data fresh after a payment (groups recomputes).
  const liveGroup = (g) => groups.find(x => x.key === g?.key) || g

  // ── Bayar Gabungan ──
  const openPay = (g) => {
    setPayTarget(g)
    setPayAmount(String(g.totalRemaining))  // prefill full (integer)
    setPayMethod('cash')
  }

  const handlePayCombined = async () => {
    if (paying || !payTarget) return
    const g = liveGroup(payTarget)
    if (!payAmount || String(payAmount).trim() === '') return toast.error('Masukkan nominal pembayaran')
    let amount = parseCurrency(payAmount)
    if (amount <= 0) return toast.error('Nominal pembayaran harus lebih dari 0')
    if (amount > g.totalRemaining) amount = g.totalRemaining   // clamp
    if (amount <= 0) return toast.error('Tidak ada sisa hutang untuk dibayar')

    setPaying(true)
    try {
      let res
      if (g.customerId && payCustomerDebtsFIFO) {
        res = await payCustomerDebtsFIFO({ customerId: g.customerId, amount, paymentMethod: payMethod })
      } else {
        // Fallback (customerId kosong): loop payDebt sesuai alokasi FIFO
        const alloc = allocateFIFO(g.activeInvoices, amount).filter(a => a.pay > 0)
        let okAny = false
        for (const a of alloc) {
          const r = await payDebt(a.inv.id, a.pay, payMethod, 'Pembayaran gabungan (FIFO)')
          okAny = okAny || r.ok
        }
        res = { ok: okAny }
      }
      if (res.ok) {
        toast.success('Pembayaran gabungan tercatat')
        setPayTarget(null); setPayAmount('')
      } else {
        toast.error(res.error || 'Gagal memproses pembayaran')
      }
    } finally { setPaying(false) }
  }

  const handleDelete = async () => {
    if (!delTarget) return
    const res = await deleteDebt(delTarget.id)
    if (res.ok) { toast.success('Hutang dihapus'); setDelTarget(null) }
    else toast.error(res.error || 'Gagal')
  }

  const openHistory = async (g) => {
    setHistoryTarget(g)
    setLoadingHistory(true)
    const all = []
    for (const inv of g.invoices) {
      const res = await getDebtPayments(inv.id)
      ;(res.data || []).forEach(p => all.push({ ...p, _invoiceNo: inv.invoiceNo }))
    }
    all.sort((a, b) => new Date(b.paid_at).getTime() - new Date(a.paid_at).getTime())
    setHistory(all)
    setLoadingHistory(false)
  }

  return (
    <div className="flex-1 overflow-y-auto mesh-bg">
      <div className="p-4 sm:p-6 max-w-7xl mx-auto">
        {/* Header */}
        <div className="mb-5">
          <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>Piutang Pelanggan</div>
          <h2 className="text-xl sm:text-2xl font-bold mt-0.5"
            style={{ fontFamily: 'Syne', color: 'var(--text-primary)' }}>
            {groups.length} customer · {debts.length} nota hutang
          </h2>
        </div>

        {/* Stat strips */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4 mb-5">
          <div className="rounded-2xl p-4" style={{
            background: 'linear-gradient(135deg, rgba(245,158,11,0.08), rgba(234,88,12,0.04))',
            border: '1px solid rgba(245,158,11,0.25)',
          }}>
            <div className="flex items-center gap-2 mb-1">
              <TrendingDown size={13} style={{ color: '#f59e0b' }} />
              <p className="text-xs font-semibold" style={{ color: '#f59e0b', fontFamily: 'Syne' }}>
                Piutang Aktif
              </p>
            </div>
            <p className="text-base sm:text-lg font-bold truncate"
              style={{ color: '#f59e0b', fontFamily: 'Syne' }}>
              {formatRupiah(summary.piutangAktif)}
            </p>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
              {summary.activeCount} customer aktif
            </p>
          </div>
          <div className="rounded-2xl p-4" style={{
            background: 'linear-gradient(135deg, rgba(16,217,138,0.08), rgba(5,150,105,0.04))',
            border: '1px solid rgba(16,217,138,0.25)',
          }}>
            <div className="flex items-center gap-2 mb-1">
              <CheckCircle2 size={13} style={{ color: '#10d98a' }} />
              <p className="text-xs font-semibold" style={{ color: '#10d98a', fontFamily: 'Syne' }}>
                Sudah Bayar
              </p>
            </div>
            <p className="text-base sm:text-lg font-bold truncate"
              style={{ color: '#10d98a', fontFamily: 'Syne' }}>
              {formatRupiah(summary.sudahBayar)}
            </p>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
              Total uang yang sudah dibayar customer
            </p>
          </div>
          <div className="rounded-2xl p-4"
            style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
            <div className="flex items-center gap-2 mb-1">
              <Crown size={13} style={{ color: 'var(--accent-light)' }} />
              <p className="text-xs font-semibold" style={{ color: 'var(--accent-light)', fontFamily: 'Syne' }}>
                Top Debtors
              </p>
            </div>
            <div className="space-y-1">
              {summary.topDebtors.slice(0, 2).map(d => (
                <div key={d.name} className="flex justify-between text-xs">
                  <span className="truncate" style={{ color: 'var(--text-secondary)' }}>{d.name}</span>
                  <span className="font-bold ml-2" style={{ color: '#f59e0b', fontFamily: 'Syne' }}>
                    {formatRupiah(d.totalRemaining)}
                  </span>
                </div>
              ))}
              {summary.topDebtors.length === 0 && (
                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Belum ada</p>
              )}
            </div>
          </div>
        </div>

        {/* Search + Filter */}
        <div className="flex gap-3 mb-5 flex-wrap">
          <div className="relative flex-1 min-w-48">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
            <input value={search} onChange={(e) => setSearch(e.target.value)}
              placeholder="Cari customer atau invoice..."
              className="w-full pl-9 pr-4 py-2.5 rounded-xl text-sm"
              style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', color: 'var(--text-primary)' }} />
          </div>
          {/* Owner: filter per admin/kasir */}
          {isOwner && admins.length > 0 && (
            <select
              value={adminFilter}
              onChange={(e) => setAdminFilter(e.target.value)}
              className="px-3 py-2 rounded-xl text-xs font-semibold"
              style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', color: 'var(--text-primary)', fontFamily: 'Syne', minWidth: 150 }}
            >
              <option value="all">Semua Admin</option>
              {admins.map(a => (
                <option key={a.id} value={a.id}>{a.name || a.username}</option>
              ))}
            </select>
          )}
          <div className="flex gap-2">
            {STATUS_OPTIONS.map(s => (
              <button key={s.id} onClick={() => setFilter(s.id)}
                className="px-3 py-2 rounded-xl text-xs font-semibold transition-all"
                style={{
                  background: filter === s.id
                    ? 'linear-gradient(135deg, var(--accent), #6366f1)' : 'var(--bg-card)',
                  color: filter === s.id ? '#fff' : 'var(--text-secondary)',
                  border: `1px solid ${filter === s.id ? 'transparent' : 'var(--border)'}`,
                  fontFamily: 'Syne',
                }}>
                {s.label}
              </button>
            ))}
          </div>
        </div>

        {/* Grouped customer list */}
        {filteredGroups.length === 0 ? (
          <EmptyState icon={Wallet} title="Tidak ada piutang"
            description="Tidak ada data yang sesuai dengan filter saat ini" />
        ) : (
          <div className="space-y-3">
            {filteredGroups.map((g, idx) => {
              const phoneForWA = g.customer.whatsapp || g.customer.phone
              return (
                <div key={g.key}
                  className="rounded-2xl p-4 animate-fadeIn"
                  style={{
                    background: 'var(--bg-card)',
                    border: `1px solid ${g.overdue ? 'rgba(255,77,106,0.35)' : 'var(--border)'}`,
                    animationDelay: `${idx * 30}ms`,
                  }}>
                  <div className="flex flex-col sm:flex-row sm:items-center gap-3">
                    {/* Avatar + name */}
                    <button onClick={() => setDetailTarget(g)}
                      className="flex items-center gap-3 flex-1 min-w-0 text-left">
                      <div className="w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0 text-sm font-bold"
                        style={{
                          background: g.status === 'lunas'
                            ? 'linear-gradient(135deg, #10d98a, #059669)'
                            : g.overdue
                            ? 'linear-gradient(135deg, #ff4d6a, #c2185b)'
                            : 'linear-gradient(135deg, #f59e0b, #ea580c)',
                          color: '#fff', fontFamily: 'Syne',
                        }}>
                        {g.customer.name[0]?.toUpperCase() || '?'}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5 flex-wrap mb-0.5">
                          <p className="text-sm font-bold truncate"
                            style={{ color: 'var(--text-primary)', fontFamily: 'Syne' }}>
                            {g.customer.name}
                          </p>
                          {g.status === 'lunas'
                            ? <Badge color="green">LUNAS</Badge>
                            : <Badge color="amber">AKTIF</Badge>}
                          {g.overdue && <Badge color="red">JATUH TEMPO</Badge>}
                        </div>
                        <p className="text-xs flex items-center gap-1 flex-wrap" style={{ color: 'var(--text-muted)' }}>
                          <Receipt size={10} /> {g.count} nota
                          {g.activeCount > 0 && <> · {g.activeCount} aktif</>}
                          {g.nearestDue && <> · <CalendarDays size={9} className="inline" /> Tempo {formatDate(g.nearestDue)}</>}
                        </p>
                      </div>
                      <ChevronRight size={16} style={{ color: 'var(--text-muted)', flexShrink: 0 }} className="hidden sm:block" />
                    </button>

                    {/* Totals — responsif: desktop 3 kolom, iPhone portrait vertikal */}
                    <div className="debt-summary-grid gap-3 sm:gap-4 flex-shrink-0">
                      <div className="debt-cell text-right">
                        <p className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--text-muted)', letterSpacing: '0.08em' }}>Total</p>
                        <p className="text-xs font-bold" style={{ color: 'var(--text-primary)', fontFamily: 'Syne', fontVariantNumeric: 'tabular-nums' }}>
                          {formatRupiah(g.totalDebt)}
                        </p>
                      </div>
                      <div className="debt-cell text-right">
                        <p className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--text-muted)', letterSpacing: '0.08em' }}>Dibayar</p>
                        <p className="text-xs font-bold" style={{ color: '#10d98a', fontFamily: 'Syne', fontVariantNumeric: 'tabular-nums' }}>
                          {formatRupiah(g.totalPaid)}
                        </p>
                      </div>
                      <div className="debt-remaining-card text-right rounded-xl px-3 py-2"
                        style={{
                          minWidth: 0,
                          background: g.totalRemaining > 0 ? 'rgba(239,68,68,0.10)' : 'rgba(16,217,138,0.10)',
                          border: `1px solid ${g.totalRemaining > 0 ? 'rgba(239,68,68,0.35)' : 'rgba(16,217,138,0.35)'}`,
                        }}>
                        <p className="text-[10px] uppercase tracking-widest font-bold"
                          style={{ color: g.totalRemaining > 0 ? '#ef4444' : '#10d98a', fontFamily: 'Syne', letterSpacing: '0.12em' }}>
                          {g.totalRemaining > 0 ? 'Sisa Hutang' : 'Lunas'}
                        </p>
                        <p className="debt-remaining-amount text-base font-extrabold"
                          style={{
                            color: g.totalRemaining > 0 ? '#ef4444' : '#10d98a',
                            fontFamily: '"Space Grotesk", "Syne", sans-serif',
                          }}>
                          {formatRupiah(g.totalRemaining)}
                        </p>
                      </div>
                    </div>
                  </div>

                  {/* Action buttons — mobile 2 kolom rapi */}
                  <div className="debt-actions flex gap-2 mt-3 flex-wrap">
                    <button onClick={() => setDetailTarget(g)}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold btn-press"
                      style={{
                        background: 'rgba(139,92,246,0.1)', color: 'var(--accent-light)',
                        border: '1px solid rgba(139,92,246,0.2)', fontFamily: 'Syne',
                      }}>
                      <Layers size={11} /> Lihat Rincian
                    </button>
                    {g.totalRemaining > 0 && (
                      <button onClick={() => openPay(g)}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold btn-press"
                        style={{
                          background: 'linear-gradient(135deg, #10d98a, #059669)',
                          color: '#fff', boxShadow: '0 2px 12px rgba(16,217,138,0.3)', fontFamily: 'Syne',
                        }}>
                        <Wallet size={11} /> Bayar Gabungan
                      </button>
                    )}
                    {g.totalRemaining > 0 && (
                      <WhatsAppReminder
                        customer={g.customer}
                        remaining={g.totalRemaining}
                        invoiceNo={`${g.activeCount} nota`}
                        dueDate={g.nearestDue ? formatDate(g.nearestDue) : null}
                        size="sm"
                        label="Kirim Reminder"
                      />
                    )}
                    <WhatsAppButton
                      phone={phoneForWA}
                      text={TEMPLATES.chat({ name: g.customer.name })}
                      size="sm" variant="icon" tooltip="Chat Customer"
                    />
                    <button onClick={() => openHistory(g)}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold btn-press"
                      style={{
                        background: 'rgba(139,92,246,0.1)', color: 'var(--accent-light)',
                        border: '1px solid rgba(139,92,246,0.2)', fontFamily: 'Syne',
                      }}>
                      <History size={11} /> Riwayat
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* ─── DETAIL MODAL — daftar invoice hutang customer ─── */}
      <Modal open={!!detailTarget} onClose={() => setDetailTarget(null)}
        title={detailTarget?.customer?.name || 'Rincian Hutang'}
        subtitle={detailTarget ? `${detailTarget.count} nota hutang` : ''} size="lg">
        {detailTarget && (() => {
          const g = liveGroup(detailTarget)
          return (
            <div className="space-y-4">
              <div className="overflow-x-auto -mx-1">
                <table className="w-full text-xs" style={{ borderCollapse: 'collapse', minWidth: 560 }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--border)' }}>
                      {['Invoice', 'Tanggal', 'Total', 'Dibayar', 'Sisa', 'Status', ''].map((h, i) => (
                        <th key={i}
                          className={`px-2 py-2 font-bold uppercase tracking-wider ${i >= 2 && i <= 4 ? 'text-right' : 'text-left'}`}
                          style={{ color: 'var(--text-muted)', fontFamily: 'Syne', fontSize: 10, letterSpacing: '0.06em' }}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {g.invoices.map(d => {
                      const rem = remOf(d)
                      const lunas = rem <= 0
                      return (
                        <tr key={d.id} style={{ borderBottom: '1px solid var(--border)' }}>
                          <td className="px-2 py-2.5 font-semibold" style={{ color: 'var(--text-primary)', fontFamily: 'Syne' }}>
                            {d.invoiceNo || '—'}
                          </td>
                          <td className="px-2 py-2.5" style={{ color: 'var(--text-secondary)' }}>
                            {formatDate(d.createdAt)}
                          </td>
                          <td className="px-2 py-2.5 text-right" style={{ color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>
                            {formatRupiah(toMoney(d.totalDebt))}
                          </td>
                          <td className="px-2 py-2.5 text-right" style={{ color: '#10d98a', fontVariantNumeric: 'tabular-nums' }}>
                            {formatRupiah(toMoney(d.paid))}
                          </td>
                          <td className="px-2 py-2.5 text-right font-bold" style={{ color: lunas ? '#10d98a' : '#ef4444', fontVariantNumeric: 'tabular-nums' }}>
                            {formatRupiah(rem)}
                          </td>
                          <td className="px-2 py-2.5">
                            <Badge color={lunas ? 'green' : 'amber'}>{lunas ? 'Lunas' : 'Aktif'}</Badge>
                          </td>
                          <td className="px-2 py-2.5 text-right">
                            <button onClick={() => setDelTarget(d)}
                              className="w-7 h-7 rounded-lg inline-flex items-center justify-center btn-press"
                              style={{ background: 'rgba(255,77,106,0.08)', color: 'var(--red)', border: '1px solid rgba(255,77,106,0.15)' }}
                              title="Hapus nota">
                              <Trash2 size={11} />
                            </button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>

              {/* Footer totals */}
              <div className="rounded-xl p-4 grid grid-cols-3 gap-3"
                style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
                <div>
                  <p className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Total Hutang</p>
                  <p className="text-sm font-bold" style={{ color: 'var(--text-primary)', fontFamily: 'Syne' }}>{formatRupiah(g.totalDebt)}</p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Sudah Dibayar</p>
                  <p className="text-sm font-bold" style={{ color: '#10d98a', fontFamily: 'Syne' }}>{formatRupiah(g.totalPaid)}</p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Sisa Hutang</p>
                  <p className="text-sm font-bold" style={{ color: g.totalRemaining > 0 ? '#ef4444' : '#10d98a', fontFamily: 'Syne' }}>{formatRupiah(g.totalRemaining)}</p>
                </div>
              </div>

              {g.totalRemaining > 0 && (
                <Button variant="success" className="w-full"
                  onClick={() => { setDetailTarget(null); openPay(g) }}>
                  <Wallet size={14} /> Bayar Gabungan
                </Button>
              )}
            </div>
          )
        })()}
      </Modal>

      {/* ─── BAYAR GABUNGAN MODAL — FIFO simulation ─── */}
      <Modal open={!!payTarget} onClose={() => !paying && setPayTarget(null)}
        title="Bayar Hutang Customer"
        subtitle={payTarget?.customer?.name} size="md">
        {payTarget && (() => {
          const g = liveGroup(payTarget)
          const totalRemaining = g.totalRemaining
          const currentPayment = parseCurrency(payAmount)
          const effective = Math.min(currentPayment, totalRemaining)
          const exceeds = currentPayment > totalRemaining
          const isEmpty = !payAmount || String(payAmount).trim() === ''
          const isZero = !isEmpty && currentPayment === 0
          const alloc = allocateFIFO(g.activeInvoices, effective)
          const totalPay = alloc.reduce((s, a) => s + a.pay, 0)
          const remainingAfter = Math.max(0, totalRemaining - totalPay)
          const formattedAmt = currentPayment > 0 ? new Intl.NumberFormat('id-ID').format(currentPayment) : ''
          const canSubmit = !paying && currentPayment > 0 && !isEmpty

          return (
            <div className="space-y-4">
              {/* Total sisa */}
              <div className="rounded-xl p-4 flex justify-between items-center"
                style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
                <span className="text-xs uppercase tracking-wider font-bold"
                  style={{ color: '#ef4444', fontFamily: 'Syne', letterSpacing: '0.08em' }}>
                  Total Sisa Hutang
                </span>
                <span style={{ color: '#ef4444', fontWeight: 800, fontFamily: 'Syne', fontSize: 18, fontVariantNumeric: 'tabular-nums' }}>
                  {formatRupiah(totalRemaining)}
                </span>
              </div>

              {/* Input */}
              <div>
                <label className="block text-xs font-semibold mb-2" style={{ color: 'var(--text-secondary)', fontFamily: 'Syne' }}>
                  Jumlah Bayar <span style={{ color: '#ef4444' }}>*</span>
                </label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm font-semibold"
                    style={{ color: 'var(--text-muted)', fontFamily: 'Syne' }}>Rp</span>
                  <input
                    type="text" inputMode="numeric" autoFocus
                    value={formattedAmt}
                    onChange={(e) => setPayAmount(e.target.value.replace(/[^\d]/g, ''))}
                    onKeyDown={(e) => { if (e.key === 'Enter' && canSubmit) { e.preventDefault(); handlePayCombined() } }}
                    placeholder="0"
                    className="w-full pl-10 pr-3 py-3 rounded-xl text-lg font-bold"
                    style={{
                      background: 'var(--bg-card)',
                      border: `1px solid ${exceeds ? 'rgba(245,158,11,0.5)' : 'var(--border)'}`,
                      color: 'var(--text-primary)', fontFamily: 'Syne',
                      fontVariantNumeric: 'tabular-nums', outline: 'none',
                    }} />
                </div>
                {exceeds && (
                  <p className="text-xs mt-1.5" style={{ color: '#f59e0b' }}>
                    Nominal melebihi total sisa — otomatis dipotong ke {formatRupiah(totalRemaining)}.
                  </p>
                )}
                {isZero && (
                  <p className="text-xs mt-1.5" style={{ color: '#ef4444' }}>Nominal pembayaran harus lebih dari 0</p>
                )}
              </div>

              {/* FIFO simulation */}
              <div className="rounded-2xl overflow-hidden"
                style={{ background: 'linear-gradient(180deg, rgba(139,92,246,0.06), rgba(99,102,241,0.04))', border: '1px solid rgba(139,92,246,0.25)' }}>
                <div className="px-4 py-2 text-[10px] uppercase tracking-widest font-bold text-center"
                  style={{ color: 'var(--accent-light)', fontFamily: 'Syne', letterSpacing: '0.16em', borderBottom: '1px solid rgba(139,92,246,0.18)', background: 'rgba(139,92,246,0.08)' }}>
                  Simulasi Pembayaran FIFO (nota terlama dulu)
                </div>
                <div className="p-3 space-y-2 max-h-60 overflow-y-auto">
                  {alloc.map(({ inv, before, pay, after }) => {
                    const willLunas = after <= 0
                    const label = pay <= 0 ? 'Belum Dibayar' : willLunas ? 'Akan Lunas' : 'Cicilan'
                    const color = pay <= 0 ? 'var(--text-muted)' : willLunas ? '#10d98a' : '#f59e0b'
                    return (
                      <div key={inv.id} className="rounded-xl p-2.5"
                        style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
                        <div className="flex justify-between items-center mb-1">
                          <span className="text-xs font-bold" style={{ color: 'var(--text-primary)', fontFamily: 'Syne' }}>
                            {inv.invoiceNo || '—'}
                          </span>
                          <span className="text-[10px] font-bold px-2 py-0.5 rounded-lg"
                            style={{ color, background: 'rgba(255,255,255,0.04)', border: `1px solid ${color}`, fontFamily: 'Syne' }}>
                            {label}
                          </span>
                        </div>
                        <div className="grid grid-cols-3 gap-2 text-[11px]" style={{ fontVariantNumeric: 'tabular-nums' }}>
                          <div><span style={{ color: 'var(--text-muted)' }}>Sebelum</span><br /><span style={{ color: 'var(--text-secondary)' }}>{formatRupiah(before)}</span></div>
                          <div><span style={{ color: 'var(--text-muted)' }}>Dibayar</span><br /><span style={{ color: '#10d98a', fontWeight: 700 }}>{formatRupiah(pay)}</span></div>
                          <div className="text-right"><span style={{ color: 'var(--text-muted)' }}>Setelah</span><br /><span style={{ color: after <= 0 ? '#10d98a' : '#ef4444', fontWeight: 700 }}>{formatRupiah(after)}</span></div>
                        </div>
                      </div>
                    )
                  })}
                </div>
                <div className="px-4 py-3 space-y-1" style={{ borderTop: '1px solid rgba(139,92,246,0.18)' }}>
                  <div className="flex justify-between text-xs">
                    <span style={{ color: 'var(--text-muted)' }}>Total Bayar</span>
                    <span style={{ color: '#10d98a', fontWeight: 700, fontFamily: 'Syne', fontVariantNumeric: 'tabular-nums' }}>{formatRupiah(totalPay)}</span>
                  </div>
                  <div className="flex justify-between items-baseline">
                    <span className="text-xs uppercase tracking-wider font-bold" style={{ color: '#f59e0b', fontFamily: 'Syne' }}>Sisa Hutang Setelah</span>
                    <span style={{ color: remainingAfter <= 0 ? '#10d98a' : '#f59e0b', fontWeight: 800, fontFamily: 'Syne', fontSize: 18, fontVariantNumeric: 'tabular-nums' }}>
                      {formatRupiah(remainingAfter)}
                    </span>
                  </div>
                </div>
              </div>

              {/* Payment method */}
              <div>
                <label className="block text-xs font-semibold mb-2" style={{ color: 'var(--text-secondary)', fontFamily: 'Syne' }}>
                  Metode Pembayaran
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {[{ id: 'cash', label: 'Cash', icon: '💵' }, { id: 'transfer', label: 'Transfer', icon: '🏦' }, { id: 'qris', label: 'QRIS', icon: '📱' }].map(m => (
                    <button key={m.id} onClick={() => setPayMethod(m.id)}
                      className="flex flex-col items-center gap-1 py-2 rounded-xl text-xs font-medium"
                      style={{
                        background: payMethod === m.id ? 'rgba(139,92,246,0.15)' : 'var(--bg-card)',
                        border: `1px solid ${payMethod === m.id ? 'rgba(139,92,246,0.4)' : 'var(--border)'}`,
                        color: payMethod === m.id ? 'var(--accent-light)' : 'var(--text-muted)', fontFamily: 'Syne',
                      }}>
                      <span>{m.icon}</span> {m.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Actions */}
              <div className="flex gap-2">
                <Button variant="secondary" className="flex-1" onClick={() => setPayTarget(null)} disabled={paying}>Batal</Button>
                <Button variant="success" className="flex-1" onClick={handlePayCombined} disabled={!canSubmit}>
                  {paying ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
                  {paying ? 'Memproses pembayaran...' : 'Konfirmasi'}
                </Button>
              </div>
            </div>
          )
        })()}
      </Modal>

      {/* History modal — gabungan semua nota customer */}
      <Modal open={!!historyTarget} onClose={() => setHistoryTarget(null)}
        title="Riwayat Pembayaran" subtitle={historyTarget?.customer?.name} size="md">
        {loadingHistory ? (
          <div className="flex items-center justify-center py-10">
            <Loader2 size={20} className="animate-spin" style={{ color: 'var(--accent-light)' }} />
          </div>
        ) : history.length === 0 ? (
          <p className="text-xs text-center py-6" style={{ color: 'var(--text-muted)' }}>Belum ada pembayaran</p>
        ) : (
          <div className="space-y-2">
            {history.map(p => (
              <div key={p.id} className="flex items-center gap-3 p-3 rounded-xl"
                style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
                <CheckCircle2 size={14} style={{ color: '#10d98a' }} />
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>
                    {formatRupiah(p.amount)} <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>· {p._invoiceNo || '—'}</span>
                  </p>
                  <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    {timeAgo(p.paid_at)} · {p.payment_method} · oleh {p.cashier || '-'}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </Modal>

      {/* Delete confirm — single nota */}
      <Modal open={!!delTarget} onClose={() => setDelTarget(null)} title="Hapus Catatan Hutang" size="sm">
        <div className="text-center py-2">
          <div className="w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4"
            style={{ background: 'rgba(255,77,106,0.12)', border: '2px solid rgba(255,77,106,0.3)' }}>
            <AlertTriangle size={24} style={{ color: 'var(--red)' }} />
          </div>
          <p className="text-sm mb-4" style={{ color: 'var(--text-secondary)' }}>
            Hapus catatan hutang <strong>{delTarget?.invoiceNo}</strong>? Riwayat pembayaran juga akan terhapus.
          </p>
          <div className="flex gap-3">
            <Button variant="secondary" className="flex-1" onClick={() => setDelTarget(null)}>Batal</Button>
            <Button variant="danger" className="flex-1" onClick={handleDelete}>Ya, Hapus</Button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
