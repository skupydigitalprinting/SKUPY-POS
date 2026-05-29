import React, { useState, useMemo } from 'react'
import {
  Search, Eye, Printer, Trash2, ChevronDown, Wallet, CheckCircle2,
  Download, FileSpreadsheet, Calendar, X, MessageCircle,
} from 'lucide-react'
import { buildWaLink, isValidWA, TEMPLATES } from '../utils/whatsapp'
import {
  formatRupiah, formatDateTime, timeAgo, STATUS_MAP,
  toDateInputValue, monthRange, monthLabel,
} from '../utils/helpers'
import { exportTransactionsXLSX } from '../utils/excelExport'
import { Badge, Button, Input, ProductImage, EmptyState } from '../components/ui'
import Modal from '../components/Modal'
import Invoice from '../components/Invoice'
import { ORDER_STATUS } from '../data/dummyData'

const ORDER_WORKFLOW = [
  'menunggu', 'diproses', 'produksi', 'selesai', 'diambil', 'dikirim', 'dibatalkan',
]

// ─── SAFE GETTERS ───────────────────────────────────────────────────
// Plain functions only. No Proxy. No object spread. Every getter
// ALWAYS returns a real config object, never undefined.

const WORKFLOW_CONFIG = {
  menunggu:   { label: 'Menunggu',   color: '#8888a8' },
  baru:       { label: 'Baru',       color: '#8888a8' },
  diproses:   { label: 'Diproses',   color: '#3b82f6' },
  produksi:   { label: 'Produksi',   color: '#a78bfa' },
  selesai:    { label: 'Selesai',    color: '#10d98a' },
  diambil:    { label: 'Diambil',    color: '#06d6f5' },
  dikirim:    { label: 'Dikirim',    color: '#f59e0b' },
  dibatalkan: { label: 'Dibatalkan', color: '#ff4d6a' },
}
const WORKFLOW_FALLBACK = { label: 'Menunggu', color: '#8888a8' }
function getWorkflow(key) {
  if (key == null) return WORKFLOW_FALLBACK
  return WORKFLOW_CONFIG[key] || WORKFLOW_FALLBACK
}

const PAYMENT_CONFIG = {
  cash:     { label: 'Cash',         icon: '💵' },
  transfer: { label: 'Transfer',     icon: '🏦' },
  qris:     { label: 'QRIS',         icon: '📱' },
  hutang:   { label: 'Hutang/Tempo', icon: '📒' },
}
const PAYMENT_FALLBACK = { label: '—', icon: '💳' }
function getPayment(key) {
  if (key == null) return PAYMENT_FALLBACK
  return PAYMENT_CONFIG[key] || PAYMENT_FALLBACK
}

const STATUS_FALLBACK = { label: 'Pending', color: 'amber', hex: '#f59e0b' }
function getStatus(key) {
  if (key == null) return STATUS_FALLBACK
  return STATUS_MAP[key] || STATUS_FALLBACK
}

export default function Order({
  transactions, storeInfo, busy, products = [], customers = [],
  updateTransactionStatus, updateTransactionPayment, deleteTransaction,
  updateOrderStatus,
}) {
  const [search, setSearch] = useState('')
  const [filterStatus, setFilterStatus] = useState('all')
  const [filterWorkflow, setFilterWorkflow] = useState('all')
  const [viewTrx, setViewTrx] = useState(null)
  const [printTrx, setPrintTrx] = useState(null)
  const [payTrx, setPayTrx] = useState(null)
  const [payAmount, setPayAmount] = useState('')
  const [delConfirm, setDelConfirm] = useState(null)

  // --- Export to Excel state ---
  const [exportOpen, setExportOpen] = useState(false)
  const [exportMode, setExportMode] = useState('range') // 'range' | 'month' | 'all'
  const [exportFrom, setExportFrom] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() - 30)
    return toDateInputValue(d)
  })
  const [exportTo, setExportTo] = useState(() => toDateInputValue(new Date()))
  const [exportMonth, setExportMonth] = useState(() => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  })
  const [exportStatusFilter, setExportStatusFilter] = useState('lunas') // 'all' | 'lunas'
  const [exportCustomerId, setExportCustomerId] = useState('all') // 'all' | customerId

  // Resolve transactions matching export filter
  const exportData = useMemo(() => {
    let start, end
    if (exportMode === 'range') {
      start = exportFrom ? new Date(exportFrom + 'T00:00:00') : null
      end = exportTo ? new Date(exportTo + 'T23:59:59') : null
    } else if (exportMode === 'month') {
      [start, end] = monthRange(exportMonth)
    }
    return transactions
      .filter(t => {
        if (exportStatusFilter === 'lunas' && t.status !== 'lunas') return false
        if (exportCustomerId !== 'all' && t.customerId !== exportCustomerId) return false
        if (!start && !end) return true
        const d = new Date(t.date)
        if (start && d < start) return false
        if (end && d > end) return false
        return true
      })
      .sort((a, b) => new Date(a.date) - new Date(b.date))
  }, [transactions, exportMode, exportFrom, exportTo, exportMonth, exportStatusFilter, exportCustomerId])

  const exportSummary = useMemo(() => {
    const totalOmzet = exportData.reduce((s, t) => s + t.total, 0)
    const totalPaid = exportData.reduce((s, t) => s + t.paid, 0)
    const totalRem = exportData.reduce((s, t) => s + t.remaining, 0)
    return { count: exportData.length, totalOmzet, totalPaid, totalRem }
  }, [exportData])

  const handleExport = () => {
    if (exportData.length === 0) return
    const label =
      exportMode === 'month' ? monthLabel(exportMonth).replace(/\s/g, '_')
      : exportMode === 'range' ? `${exportFrom}_sd_${exportTo}`
      : 'semua'
    const periodLabel =
      exportMode === 'month' ? monthLabel(exportMonth)
      : exportMode === 'range' ? `${exportFrom} s/d ${exportTo}`
      : 'Semua waktu'
    const customerLabel = exportCustomerId !== 'all'
      ? `_${(customers.find(c => c.id === exportCustomerId)?.name || 'cust').replace(/\s/g, '_')}`
      : ''
    const datePart = new Date().toISOString().slice(0, 10)
    const fname = `Rekap-Order-${datePart}${customerLabel ? customerLabel : '_' + label}.xlsx`
    exportTransactionsXLSX(exportData, storeInfo, {
      products, customers, periodLabel, filename: fname,
    })
    setExportOpen(false)
  }

  const filtered = useMemo(() => {
    return (transactions || []).filter((t) => {
      if (!t) return false
      const matchStatus = filterStatus === 'all' || t.status === filterStatus
      const matchWorkflow = filterWorkflow === 'all' || (t.orderStatus || 'menunggu') === filterWorkflow
      const q = (search || '').toLowerCase()
      const matchSearch =
        (t.customer || '').toLowerCase().includes(q) ||
        (t.invoiceNo || '').toLowerCase().includes(q) ||
        (t.orderNo || '').toLowerCase().includes(q)
      return matchStatus && matchWorkflow && matchSearch
    })
  }, [transactions, search, filterStatus, filterWorkflow])

  const totalFiltered = filtered.reduce((s, t) => s + t.total, 0)
  const totalLunas = filtered
    .filter((t) => t.status === 'lunas')
    .reduce((s, t) => s + t.total, 0)
  const totalRemaining = filtered.reduce((s, t) => s + t.remaining, 0)

  const openPay = (t) => {
    setPayTrx(t)
    setPayAmount(String(t.remaining))
  }

  const handlePay = () => {
    if (!payTrx) return
    const amount = Number(payAmount)
    if (amount > 0) {
      updateTransactionPayment(payTrx.id, amount)
    }
    setPayTrx(null)
    setPayAmount('')
  }

  return (
    <div className="flex-1 overflow-y-auto mesh-bg">
      <div className="p-4 sm:p-6 max-w-7xl mx-auto">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-5">
          <div>
            <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              Daftar Pesanan
            </div>
            <h2 className="text-xl sm:text-2xl font-bold mt-0.5"
              style={{ fontFamily: 'Syne', color: 'var(--text-primary)' }}>
              {transactions.length} total transaksi
            </h2>
          </div>
          <button
            onClick={() => setExportOpen(true)}
            className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold btn-press flex-shrink-0"
            style={{
              background: 'linear-gradient(135deg, #10d98a 0%, #059669 100%)',
              color: '#fff',
              boxShadow: '0 4px 16px rgba(16,217,138,0.35)',
              fontFamily: 'Syne',
            }}
          >
            <FileSpreadsheet size={15} />
            Export Excel
          </button>
        </div>

        {/* Summary Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4 mb-5">
          {[
            { label: 'Total Nilai', value: formatRupiah(totalFiltered), color: 'accent' },
            { label: 'Sudah Lunas', value: formatRupiah(totalLunas), color: 'green' },
            { label: 'Sisa Tagihan', value: formatRupiah(totalRemaining), color: 'amber' },
          ].map((s, i) => (
            <div
              key={i}
              className="rounded-2xl p-4 relative overflow-hidden animate-slideUp"
              style={{
                background: 'var(--bg-card)',
                border: '1px solid var(--border)',
                animationDelay: `${i * 60}ms`,
              }}
            >
              <p className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>
                {s.label}
              </p>
              <p className="font-bold text-sm sm:text-base truncate"
                style={{
                  fontFamily: 'Syne',
                  color:
                    s.color === 'accent' ? 'var(--accent-light)'
                      : s.color === 'green' ? '#10d98a' : '#f59e0b',
                }}>
                {s.value}
              </p>
            </div>
          ))}
        </div>

        {/* Filters */}
        <div className="flex gap-3 mb-5 flex-wrap">
          <div className="relative flex-1 min-w-48">
            <Search size={14}
              className="absolute left-3 top-1/2 -translate-y-1/2"
              style={{ color: 'var(--text-muted)' }} />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Cari customer atau invoice..."
              className="w-full pl-9 pr-4 py-2.5 rounded-xl text-sm"
              style={{
                background: 'var(--bg-card)',
                border: '1px solid var(--border)',
                color: 'var(--text-primary)',
              }}
            />
          </div>
          <div className="flex gap-2 flex-wrap">
            {['all', ...ORDER_STATUS].map((s) => {
              const m = getStatus(s)
              const active = filterStatus === s
              return (
                <button
                  key={s}
                  onClick={() => setFilterStatus(s)}
                  className="px-3 py-2 rounded-xl text-xs font-semibold transition-all"
                  style={{
                    background: active
                      ? 'linear-gradient(135deg, var(--accent), #6366f1)'
                      : 'var(--bg-card)',
                    color: active ? '#fff' : 'var(--text-secondary)',
                    border: `1px solid ${active ? 'transparent' : 'var(--border)'}`,
                    fontFamily: 'Syne',
                    boxShadow: active ? '0 2px 12px rgba(139,92,246,0.3)' : 'none',
                  }}
                >
                  {s === 'all' ? 'Semua' : m.label}
                </button>
              )
            })}
          </div>
        </div>

        {/* Workflow filter */}
        <div className="flex gap-2 mb-5 flex-wrap items-center">
          <span className="text-xs font-semibold pr-2"
            style={{ color: 'var(--text-muted)', fontFamily: 'Syne', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            Workflow:
          </span>
          {['all', ...ORDER_WORKFLOW].map((w) => {
            const active = filterWorkflow === w
            const wf = w === 'all' ? null : getWorkflow(w)
            const color = w === 'all' ? '#a78bfa' : wf.color
            const label = w === 'all' ? 'Semua' : wf.label
            return (
              <button key={w} onClick={() => setFilterWorkflow(w)}
                className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-all"
                style={{
                  background: active ? `${color}25` : 'var(--bg-card)',
                  color: active ? color : 'var(--text-secondary)',
                  border: `1px solid ${active ? color + '50' : 'var(--border)'}`,
                  fontFamily: 'Syne',
                }}>
                {label}
              </button>
            )
          })}
        </div>

        {/* Desktop Table */}
        <div className="hidden md:block rounded-2xl overflow-hidden"
          style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
          <div className="grid gap-2 px-4 py-3 text-xs font-semibold uppercase tracking-wider"
            style={{
              gridTemplateColumns: '1.2fr 1.4fr 1fr 1fr 1fr 0.9fr 0.9fr auto',
              color: 'var(--text-muted)',
              fontFamily: 'Syne',
              borderBottom: '1px solid var(--border)',
              background: 'var(--bg-elevated)',
            }}>
            <span>Invoice</span>
            <span>Customer</span>
            <span>Total</span>
            <span>Sisa</span>
            <span>Bayar</span>
            <span>Pembayaran</span>
            <span>Workflow</span>
            <span className="text-right">Aksi</span>
          </div>

          {filtered.length === 0 ? (
            <div className="py-16 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
              Tidak ada transaksi
            </div>
          ) : (
            filtered.map((t) => {
              if (!t) return null
              const s = getStatus(t.status)
              const pm = getPayment(t.paymentMethod)
              const wf = getWorkflow(t.orderStatus || 'menunggu')
              return (
                <div
                  key={t.id}
                  className="grid gap-2 px-4 py-3 items-center hover:bg-white/[0.02] transition-all"
                  style={{
                    gridTemplateColumns: '1.2fr 1.4fr 1fr 1fr 1fr 0.9fr 0.9fr auto',
                    borderBottom: '1px solid var(--border)',
                  }}
                >
                  <div className="min-w-0">
                    <p className="text-xs font-bold truncate"
                      style={{ color: 'var(--accent-light)', fontFamily: 'Syne' }}>
                      {t.invoiceNo}
                    </p>
                    {t.orderNo && (
                      <p className="text-xs" style={{ color: 'var(--text-secondary)', fontFamily: 'Syne' }}>
                        {t.orderNo}
                      </p>
                    )}
                    <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                      {timeAgo(t.date)}
                    </p>
                  </div>
                  <div className="min-w-0">
                    <p className="text-xs font-semibold truncate"
                      style={{ color: 'var(--text-primary)' }}>
                      {t.customer}
                    </p>
                    <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                      {(t.items || []).length} item
                    </p>
                  </div>
                  <p className="text-xs font-bold"
                    style={{ color: 'var(--text-primary)', fontFamily: 'Syne' }}>
                    {formatRupiah(t.total)}
                  </p>
                  <p className="text-xs font-semibold"
                    style={{ color: t.remaining > 0 ? 'var(--red)' : '#10d98a' }}>
                    {formatRupiah(t.remaining)}
                  </p>
                  <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                    {pm.icon} {pm.label}
                  </p>
                  <div>
                    <select
                      value={t.status}
                      onChange={(e) => updateTransactionStatus(t.id, e.target.value)}
                      className="text-xs px-2 py-1 rounded-lg border-0 outline-none cursor-pointer"
                      style={{
                        background: 'transparent',
                        color: s.hex,
                        fontWeight: 700,
                        fontFamily: 'Syne',
                      }}
                    >
                      {ORDER_STATUS.map((st) => (
                        <option key={st} value={st}
                          style={{ background: 'var(--bg-elevated)', color: 'var(--text-primary)' }}>
                          {getStatus(st).label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    {updateOrderStatus ? (
                      <select
                        value={t.orderStatus || 'menunggu'}
                        onChange={(e) => updateOrderStatus(t.id, e.target.value)}
                        className="text-xs px-2 py-1 rounded-lg border-0 outline-none cursor-pointer"
                        style={{
                          background: 'transparent',
                          color: wf.color,
                          fontWeight: 700,
                          fontFamily: 'Syne',
                        }}
                      >
                        {ORDER_WORKFLOW.map((st) => (
                          <option key={st} value={st}
                            style={{ background: 'var(--bg-elevated)', color: 'var(--text-primary)' }}>
                            {getWorkflow(st).label}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className="text-xs font-semibold"
                        style={{ color: wf.color, fontFamily: 'Syne' }}>
                        {wf.label}
                      </span>
                    )}
                  </div>
                  <div className="flex gap-1.5 justify-end">
                    {t.remaining > 0 && (
                      <button
                        onClick={() => openPay(t)}
                        className="w-7 h-7 rounded-lg flex items-center justify-center btn-press"
                        style={{
                          background: 'rgba(16,217,138,0.1)',
                          color: '#10d98a',
                          border: '1px solid rgba(16,217,138,0.2)',
                        }}
                        title="Bayar"
                      >
                        <Wallet size={12} />
                      </button>
                    )}
                    <button
                      onClick={() => setViewTrx(t)}
                      className="w-7 h-7 rounded-lg flex items-center justify-center btn-press"
                      style={{
                        background: 'rgba(139,92,246,0.1)',
                        color: 'var(--accent-light)',
                        border: '1px solid rgba(139,92,246,0.2)',
                      }}
                      title="Detail"
                    >
                      <Eye size={13} />
                    </button>
                    {(() => {
                      const cust = customers.find(c => c.id === t.customerId)
                      const phone = cust?.whatsapp || cust?.phone || ''
                      const statusLabel = (getStatus(t.status).label || 'Pending').toString().toUpperCase()
                      const text = `Halo ${t.customer || 'Customer'},\nTerima kasih telah melakukan transaksi.\n\nNomor Invoice: *${t.invoiceNo || '-'}*\nTotal: *${formatRupiah(t.total || 0)}*\nStatus: *${statusLabel}*\n\nTerima kasih.\n${storeInfo?.name || ''}`
                      return (
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            window.open(buildWaLink(phone, text), '_blank', 'noopener,noreferrer')
                          }}
                          className="w-7 h-7 rounded-lg flex items-center justify-center btn-press"
                          style={{
                            background: 'rgba(37,211,102,0.12)',
                            color: '#25d366',
                            border: '1px solid rgba(37,211,102,0.3)',
                          }}
                          title={isValidWA(phone) ? `Chat ${cust?.name || t.customer}` : 'Buka WhatsApp (pilih kontak)'}
                        >
                          <MessageCircle size={12} />
                        </button>
                      )
                    })()}
                    <button
                      onClick={() => setPrintTrx(t)}
                      className="w-7 h-7 rounded-lg flex items-center justify-center btn-press"
                      style={{
                        background: 'rgba(255,255,255,0.04)',
                        color: 'var(--text-secondary)',
                        border: '1px solid var(--border)',
                      }}
                      title="Print"
                    >
                      <Printer size={13} />
                    </button>
                    <button
                      onClick={() => setDelConfirm(t)}
                      className="w-7 h-7 rounded-lg flex items-center justify-center btn-press"
                      style={{
                        background: 'rgba(255,77,106,0.08)',
                        color: 'var(--red)',
                        border: '1px solid rgba(255,77,106,0.15)',
                      }}
                      title="Hapus"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              )
            })
          )}
        </div>

        {/* Mobile Card View */}
        <div className="md:hidden space-y-3">
          {filtered.length === 0 ? (
            <div className="rounded-2xl py-16 text-center text-sm"
              style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', color: 'var(--text-muted)' }}>
              Tidak ada transaksi
            </div>
          ) : (
            filtered.map((t) => {
              if (!t) return null
              const s = getStatus(t.status)
              const pm = getPayment(t.paymentMethod)
              return (
                <div
                  key={t.id}
                  className="rounded-2xl p-4 animate-fadeIn"
                  style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
                >
                  <div className="flex items-start justify-between mb-3">
                    <div>
                      <p className="text-xs font-bold"
                        style={{ color: 'var(--accent-light)', fontFamily: 'Syne' }}>
                        {t.invoiceNo}
                      </p>
                      <p className="text-sm font-semibold mt-0.5"
                        style={{ color: 'var(--text-primary)' }}>
                        {t.customer}
                      </p>
                      <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                        {formatDateTime(t.date)}
                      </p>
                    </div>
                    <Badge color={s.color}>{s.label}</Badge>
                  </div>
                  <div className="flex items-end justify-between mb-3">
                    <div>
                      <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Total</p>
                      <p className="font-bold text-base"
                        style={{ fontFamily: 'Syne', color: 'var(--text-primary)' }}>
                        {formatRupiah(t.total)}
                      </p>
                    </div>
                    {t.remaining > 0 && (
                      <div className="text-right">
                        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Sisa</p>
                        <p className="font-bold text-sm"
                          style={{ color: 'var(--red)', fontFamily: 'Syne' }}>
                          {formatRupiah(t.remaining)}
                        </p>
                      </div>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {t.remaining > 0 && (
                      <button
                        onClick={() => openPay(t)}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold btn-press"
                        style={{
                          background: 'rgba(16,217,138,0.1)',
                          color: '#10d98a',
                          border: '1px solid rgba(16,217,138,0.2)',
                          fontFamily: 'Syne',
                        }}
                      >
                        <Wallet size={11} /> Bayar
                      </button>
                    )}
                    <button
                      onClick={() => setViewTrx(t)}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold btn-press"
                      style={{
                        background: 'rgba(139,92,246,0.1)',
                        color: 'var(--accent-light)',
                        border: '1px solid rgba(139,92,246,0.2)',
                        fontFamily: 'Syne',
                      }}
                    >
                      <Eye size={11} /> Detail
                    </button>
                    <button
                      onClick={() => setPrintTrx(t)}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold btn-press"
                      style={{
                        background: 'rgba(255,255,255,0.04)',
                        color: 'var(--text-secondary)',
                        border: '1px solid var(--border)',
                        fontFamily: 'Syne',
                      }}
                    >
                      <Printer size={11} /> Print
                    </button>
                  </div>
                </div>
              )
            })
          )}
        </div>
      </div>

      {/* View Detail Modal */}
      <Modal
        open={!!viewTrx}
        onClose={() => setViewTrx(null)}
        title={viewTrx?.invoiceNo || 'Detail Order'}
        subtitle={viewTrx ? formatDateTime(viewTrx.date) : ''}
        size="md"
      >
        {viewTrx && (
          <div className="space-y-4">
            {viewTrx.orderNo && (
              <div className="flex flex-wrap gap-2 items-center text-xs">
                <span className="px-2.5 py-1 rounded-md font-semibold"
                  style={{
                    background: 'rgba(139,92,246,0.12)',
                    color: 'var(--accent-light)',
                    border: '1px solid rgba(139,92,246,0.25)',
                    fontFamily: 'Syne',
                  }}>
                  ORDER {viewTrx.orderNo}
                </span>
                {viewTrx.cashier && (
                  <span style={{ color: 'var(--text-muted)' }}>
                    Kasir: <strong style={{ color: 'var(--text-secondary)' }}>{viewTrx.cashier}</strong>
                  </span>
                )}
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              {[
                { label: 'Customer', value: viewTrx.customer || 'Umum' },
                { label: 'Pembayaran', value: `${getPayment(viewTrx.paymentMethod).icon} ${getPayment(viewTrx.paymentMethod).label}` },
                { label: 'Status Bayar', value: getStatus(viewTrx.status).label },
                { label: 'Workflow', value: getWorkflow(viewTrx.orderStatus).label },
              ].map((r, i) => (
                <div key={i} className="p-3 rounded-xl"
                  style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
                  <p className="text-xs mb-0.5" style={{ color: 'var(--text-muted)' }}>{r.label}</p>
                  <p className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                    {r.value}
                  </p>
                </div>
              ))}
            </div>

            {/* Workflow status history */}
            {Array.isArray(viewTrx.statusHistory) && viewTrx.statusHistory.length > 0 && (
              <div className="rounded-xl p-4"
                style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
                <div className="text-xs font-semibold mb-3"
                  style={{ color: 'var(--accent-light)', fontFamily: 'Syne', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                  📋 Riwayat Perubahan Status
                </div>
                <div className="space-y-2">
                  {viewTrx.statusHistory.map((h, i) => {
                    if (!h) return null
                    const cfg = getWorkflow(h.order_status)
                    const fromCfg = h.from ? getWorkflow(h.from) : null
                    return (
                      <div key={i} className="flex items-center gap-3 text-xs">
                        <div className="w-2 h-2 rounded-full flex-shrink-0"
                          style={{ background: cfg.color }} />
                        <span className="font-semibold"
                          style={{ color: cfg.color, fontFamily: 'Syne' }}>
                          {cfg.label}
                        </span>
                        {fromCfg && (
                          <span style={{ color: 'var(--text-muted)' }}>
                            ← {fromCfg.label}
                          </span>
                        )}
                        <span className="ml-auto" style={{ color: 'var(--text-muted)' }}>
                          {h.changed_at ? timeAgo(h.changed_at) : '-'} {h.changed_by ? <>· {h.changed_by}</> : null}
                        </span>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            <div className="rounded-xl overflow-hidden" style={{ border: '1px solid var(--border)' }}>
              <div className="px-4 py-2 text-xs font-semibold uppercase tracking-wider grid grid-cols-12"
                style={{ background: 'var(--bg-elevated)', color: 'var(--text-muted)', fontFamily: 'Syne' }}>
                <span className="col-span-7">Produk</span>
                <span className="col-span-2 text-center">Qty</span>
                <span className="col-span-3 text-right">Subtotal</span>
              </div>
              {(viewTrx.items || []).map((item, i) => (
                <div key={i}
                  className="grid grid-cols-12 px-4 py-3 text-sm items-center gap-2"
                  style={{ borderTop: '1px solid var(--border)' }}>
                  <div className="col-span-7 flex items-center gap-2 min-w-0">
                    <ProductImage
                      src={item.image}
                      alt={item.name}
                      className="w-8 h-8 rounded-lg object-cover flex-shrink-0"
                      fallbackSize={32}
                    />
                    <div className="min-w-0">
                      <p className="font-medium text-xs truncate" style={{ color: 'var(--text-primary)' }}>
                        {item.name}
                      </p>
                      <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                        {formatRupiah(item.price)}
                      </p>
                    </div>
                  </div>
                  <p className="col-span-2 text-center text-xs font-bold"
                    style={{ color: 'var(--text-secondary)' }}>
                    {item.qty}
                  </p>
                  <p className="col-span-3 text-right text-xs font-bold"
                    style={{ color: 'var(--accent-light)', fontFamily: 'Syne' }}>
                    {formatRupiah(item.qty * item.price)}
                  </p>
                </div>
              ))}
            </div>

            <div className="rounded-xl p-4 space-y-2"
              style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
              <div className="flex justify-between text-xs">
                <span style={{ color: 'var(--text-muted)' }}>Subtotal</span>
                <span style={{ color: 'var(--text-secondary)' }}>{formatRupiah(viewTrx.subtotal)}</span>
              </div>
              {viewTrx.discount > 0 && (
                <div className="flex justify-between text-xs">
                  <span style={{ color: 'var(--text-muted)' }}>Diskon</span>
                  <span style={{ color: 'var(--red)' }}>-{formatRupiah(viewTrx.discount)}</span>
                </div>
              )}
              <div className="flex justify-between font-bold pt-2 text-sm"
                style={{ borderTop: '1px dashed var(--border)' }}>
                <span style={{ color: 'var(--text-primary)', fontFamily: 'Syne' }}>TOTAL</span>
                <span style={{ color: 'var(--accent-light)', fontFamily: 'Syne' }}>
                  {formatRupiah(viewTrx.total)}
                </span>
              </div>
              <div className="flex justify-between text-xs">
                <span style={{ color: 'var(--text-muted)' }}>DP Dibayar</span>
                <span style={{ color: '#10d98a', fontWeight: 600 }}>{formatRupiah(viewTrx.dp)}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span style={{ color: 'var(--text-muted)' }}>Sisa</span>
                <span style={{
                  color: viewTrx.remaining > 0 ? 'var(--red)' : '#10d98a',
                  fontWeight: 600,
                }}>
                  {formatRupiah(viewTrx.remaining)}
                </span>
              </div>
            </div>

            <div className="flex gap-2">
              {viewTrx.remaining > 0 && (
                <button
                  onClick={() => { openPay(viewTrx); setViewTrx(null) }}
                  className="flex-1 flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-semibold btn-press"
                  style={{
                    background: 'rgba(16,217,138,0.12)',
                    color: '#10d98a',
                    border: '1px solid rgba(16,217,138,0.25)',
                    fontFamily: 'Syne',
                  }}
                >
                  <Wallet size={14} /> Tambah Bayaran
                </button>
              )}
              <button
                onClick={() => { setViewTrx(null); setPrintTrx(viewTrx) }}
                className="flex-1 flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-semibold btn-press"
                style={{
                  background: 'linear-gradient(135deg, var(--accent), #6366f1)',
                  color: '#fff',
                  fontFamily: 'Syne',
                }}
              >
                <Printer size={14} /> Cetak Invoice
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* Payment Modal */}
      <Modal
        open={!!payTrx}
        onClose={() => setPayTrx(null)}
        title="Tambah Pembayaran"
        subtitle={payTrx?.invoiceNo}
        size="sm"
      >
        {payTrx && (
          <div className="space-y-4">
            <div className="rounded-xl p-4 space-y-2"
              style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
              <div className="flex justify-between text-sm">
                <span style={{ color: 'var(--text-muted)' }}>Total</span>
                <span style={{ color: 'var(--text-primary)', fontWeight: 700, fontFamily: 'Syne' }}>
                  {formatRupiah(payTrx.total)}
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span style={{ color: 'var(--text-muted)' }}>Sudah Dibayar</span>
                <span style={{ color: '#10d98a', fontWeight: 600 }}>{formatRupiah(payTrx.paid)}</span>
              </div>
              <div className="flex justify-between text-sm pt-2"
                style={{ borderTop: '1px dashed var(--border)' }}>
                <span style={{ color: 'var(--text-muted)' }}>Sisa</span>
                <span style={{ color: 'var(--red)', fontWeight: 700, fontFamily: 'Syne' }}>
                  {formatRupiah(payTrx.remaining)}
                </span>
              </div>
            </div>
            <Input
              label="Jumlah Bayar"
              required
              type="number"
              prefix="Rp"
              value={payAmount}
              onChange={(e) => setPayAmount(e.target.value)}
              placeholder="0"
            />
            <div className="flex gap-2">
              <Button variant="secondary" className="flex-1" onClick={() => setPayTrx(null)}>Batal</Button>
              <Button variant="success" className="flex-1" onClick={handlePay}>
                <CheckCircle2 size={14} /> Konfirmasi
              </Button>
            </div>
          </div>
        )}
      </Modal>

      {/* Delete Confirm */}
      <Modal open={!!delConfirm} onClose={() => setDelConfirm(null)} title="Hapus Transaksi" size="sm">
        <div className="text-center py-2">
          <div className="w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4"
            style={{ background: 'rgba(255,77,106,0.12)', border: '2px solid rgba(255,77,106,0.3)' }}>
            <Trash2 size={24} style={{ color: 'var(--red)' }} />
          </div>
          <h3 className="font-bold text-base mb-2"
            style={{ fontFamily: 'Syne', color: 'var(--text-primary)' }}>
            Yakin ingin menghapus?
          </h3>
          <p className="text-sm mb-6" style={{ color: 'var(--text-secondary)' }}>
            Transaksi <strong>{delConfirm?.invoiceNo}</strong> akan dihapus permanen.
          </p>
          <div className="flex gap-3">
            <Button variant="secondary" className="flex-1" onClick={() => setDelConfirm(null)}>Batal</Button>
            <Button variant="danger" className="flex-1"
              onClick={() => { deleteTransaction(delConfirm.id); setDelConfirm(null) }}>
              Ya, Hapus
            </Button>
          </div>
        </div>
      </Modal>

      {/* Export Excel Modal */}
      <Modal
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        title="Export Omzet ke Excel"
        subtitle="Pilih periode untuk export laporan omzet"
        size="md"
      >
        <div className="space-y-4">
          {/* Mode tabs */}
          <div className="grid grid-cols-3 gap-2">
            {[
              { id: 'range', label: 'Range Tanggal', icon: Calendar },
              { id: 'month', label: 'Per Bulan', icon: Calendar },
              { id: 'all', label: 'Semua', icon: FileSpreadsheet },
            ].map(({ id, label, icon: Icon }) => {
              const active = exportMode === id
              return (
                <button
                  key={id}
                  onClick={() => setExportMode(id)}
                  className="flex flex-col items-center gap-1.5 py-3 rounded-xl text-xs font-semibold transition-all"
                  style={{
                    background: active
                      ? 'linear-gradient(135deg, rgba(16,217,138,0.18), rgba(5,150,105,0.08))'
                      : 'var(--bg-card)',
                    color: active ? '#10d98a' : 'var(--text-secondary)',
                    border: `1px solid ${active ? 'rgba(16,217,138,0.4)' : 'var(--border)'}`,
                    fontFamily: 'Syne',
                  }}
                >
                  <Icon size={16} />
                  {label}
                </button>
              )
            })}
          </div>

          {/* Range picker */}
          {exportMode === 'range' && (
            <div className="grid grid-cols-2 gap-3">
              <Input
                label="Tanggal Mulai"
                type="date"
                value={exportFrom}
                onChange={(e) => setExportFrom(e.target.value)}
              />
              <Input
                label="Tanggal Akhir"
                type="date"
                value={exportTo}
                onChange={(e) => setExportTo(e.target.value)}
              />
            </div>
          )}

          {/* Month picker */}
          {exportMode === 'month' && (
            <Input
              label="Pilih Bulan"
              type="month"
              value={exportMonth}
              onChange={(e) => setExportMonth(e.target.value)}
            />
          )}

          {/* Status filter */}
          <div>
            <label className="block text-xs font-semibold mb-2"
              style={{ color: 'var(--text-secondary)', fontFamily: 'Syne', letterSpacing: '0.02em' }}>
              Filter Status
            </label>
            <div className="grid grid-cols-2 gap-2">
              {[
                { id: 'lunas', label: 'Hanya Lunas', desc: 'Omzet terealisasi' },
                { id: 'all', label: 'Semua Status', desc: 'Termasuk pending' },
              ].map((opt) => {
                const active = exportStatusFilter === opt.id
                return (
                  <button
                    key={opt.id}
                    onClick={() => setExportStatusFilter(opt.id)}
                    className="text-left p-3 rounded-xl transition-all"
                    style={{
                      background: active ? 'rgba(139,92,246,0.12)' : 'var(--bg-card)',
                      border: `1px solid ${active ? 'rgba(139,92,246,0.4)' : 'var(--border)'}`,
                      color: active ? 'var(--accent-light)' : 'var(--text-secondary)',
                    }}
                  >
                    <div className="text-xs font-semibold" style={{ fontFamily: 'Syne' }}>{opt.label}</div>
                    <div className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>{opt.desc}</div>
                  </button>
                )
              })}
            </div>
          </div>

          {/* Customer filter */}
          {customers.length > 0 && (
            <div>
              <label className="block text-xs font-semibold mb-2"
                style={{ color: 'var(--text-secondary)', fontFamily: 'Syne', letterSpacing: '0.02em' }}>
                Filter Customer
              </label>
              <select
                value={exportCustomerId}
                onChange={(e) => setExportCustomerId(e.target.value)}
                className="w-full px-3 py-2.5 rounded-xl text-sm"
                style={{
                  background: 'var(--bg-card)',
                  border: '1px solid var(--border)',
                  color: 'var(--text-primary)',
                }}>
                <option value="all">Semua Customer</option>
                {customers.map(c => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
          )}

          {/* Preview */}
          <div className="rounded-xl p-4"
            style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
            <div className="text-xs font-semibold mb-3"
              style={{ color: 'var(--text-muted)', fontFamily: 'Syne', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              Preview Hasil
            </div>
            <div className="grid grid-cols-2 gap-3 mb-3">
              <div>
                <div className="text-xs" style={{ color: 'var(--text-muted)' }}>Transaksi</div>
                <div className="text-lg font-bold" style={{ fontFamily: 'Syne', color: 'var(--text-primary)' }}>
                  {exportSummary.count}
                </div>
              </div>
              <div>
                <div className="text-xs" style={{ color: 'var(--text-muted)' }}>Total Omzet</div>
                <div className="text-lg font-bold truncate"
                  style={{ fontFamily: 'Syne', color: '#10d98a' }}>
                  {formatRupiah(exportSummary.totalOmzet)}
                </div>
              </div>
              <div>
                <div className="text-xs" style={{ color: 'var(--text-muted)' }}>Dibayar</div>
                <div className="text-sm font-semibold" style={{ color: 'var(--accent-light)', fontFamily: 'Syne' }}>
                  {formatRupiah(exportSummary.totalPaid)}
                </div>
              </div>
              <div>
                <div className="text-xs" style={{ color: 'var(--text-muted)' }}>Sisa</div>
                <div className="text-sm font-semibold"
                  style={{ color: exportSummary.totalRem > 0 ? 'var(--amber)' : 'var(--text-secondary)', fontFamily: 'Syne' }}>
                  {formatRupiah(exportSummary.totalRem)}
                </div>
              </div>
            </div>
            {exportMode === 'month' && (
              <div className="text-xs pt-2" style={{ borderTop: '1px dashed var(--border)', color: 'var(--text-muted)' }}>
                Periode: <strong style={{ color: 'var(--text-secondary)' }}>{monthLabel(exportMonth)}</strong>
              </div>
            )}
            {exportMode === 'range' && (
              <div className="text-xs pt-2" style={{ borderTop: '1px dashed var(--border)', color: 'var(--text-muted)' }}>
                Periode: <strong style={{ color: 'var(--text-secondary)' }}>{exportFrom} s/d {exportTo}</strong>
              </div>
            )}
          </div>

          <div className="flex gap-2">
            <Button variant="secondary" className="flex-1" onClick={() => setExportOpen(false)}>
              Batal
            </Button>
            <Button
              variant="success"
              className="flex-1"
              onClick={handleExport}
              disabled={exportData.length === 0}
            >
              <Download size={14} />
              Download {exportData.length > 0 ? `(${exportData.length})` : ''}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Print Invoice */}
      {printTrx && <Invoice transaction={printTrx} storeInfo={storeInfo} onClose={() => setPrintTrx(null)} />}
    </div>
  )
}
