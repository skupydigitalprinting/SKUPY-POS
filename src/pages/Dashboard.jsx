import React from 'react'
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, BarChart, Bar, PieChart, Pie, Cell, Legend,
} from 'recharts'
import {
  TrendingUp, ShoppingBag, Users, Clock, Receipt,
  ArrowUpRight, Star, Zap, ArrowRight, Activity,
} from 'lucide-react'
import { formatRupiah, formatCompact, formatDateTime, timeAgo, STATUS_MAP } from '../utils/helpers'
import { Badge, ProductImage } from '../components/ui'
import { CATEGORIES } from '../data/dummyData'
import Logo from '../components/Logo'

const COLORS = ['#8b5cf6', '#10d98a', '#f59e0b', '#3b82f6', '#ff4d6a', '#a78bfa']

function StatCard({ icon: Icon, label, value, sub, color = 'accent', trend, delay = 0 }) {
  const colors = {
    accent: { bg: 'rgba(139,92,246,0.12)', icon: '#a78bfa', glow: 'rgba(139,92,246,0.3)' },
    green: { bg: 'rgba(16,217,138,0.12)', icon: '#10d98a', glow: 'rgba(16,217,138,0.3)' },
    amber: { bg: 'rgba(245,158,11,0.12)', icon: '#f59e0b', glow: 'rgba(245,158,11,0.3)' },
    blue: { bg: 'rgba(59,130,246,0.12)', icon: '#3b82f6', glow: 'rgba(59,130,246,0.3)' },
  }
  const c = colors[color]
  return (
    <div
      className="animate-slideUp rounded-2xl p-5 relative overflow-hidden"
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
          <Icon size={20} style={{ color: c.icon }} />
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

export default function Dashboard({ stats, transactions, setActivePage, storeInfo, currentUser }) {
  const recentTrx = transactions.slice(0, 6)
  const catLabel = (id) => CATEGORIES.find(c => c.id === id)?.label || id

  const pieData = stats.categoryData.map((d) => ({ ...d, name: catLabel(d.name) }))

  return (
    <div className="flex-1 overflow-y-auto mesh-bg" style={{ minHeight: 0 }}>
      <div className="p-4 sm:p-6 max-w-7xl mx-auto">
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

        {/* Stat Cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 mb-5">
          <StatCard
            icon={TrendingUp}
            label="Total Omzet"
            value={formatRupiah(stats.totalOmzet)}
            sub="Semua waktu"
            color="accent"
            trend="+12%"
            delay={0}
          />
          <StatCard
            icon={ShoppingBag}
            label="Omzet Hari Ini"
            value={formatRupiah(stats.todayOmzet)}
            sub={`${stats.todayTrx.length} transaksi`}
            color="green"
            trend="+8%"
            delay={60}
          />
          <StatCard
            icon={Clock}
            label="Pending Order"
            value={stats.pendingCount}
            sub={`+${stats.procesCount} sedang proses`}
            color="amber"
            delay={120}
          />
          <StatCard
            icon={Users}
            label="Total Pelanggan"
            value={stats.customers}
            sub={`${stats.totalTransactions} transaksi total`}
            color="blue"
            delay={180}
          />
        </div>

        {/* Secondary stat row */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 mb-5">
          <StatCard
            icon={TrendingUp}
            label="Omzet Bulan Ini"
            value={formatCompact(stats.monthOmzet)}
            sub={new Date().toLocaleDateString('id-ID', { month: 'long' })}
            color="accent"
            delay={0}
          />
          <StatCard
            icon={Receipt}
            label="Order Hari Ini"
            value={stats.todayOrders}
            sub="Transaksi"
            color="green"
            delay={60}
          />
          <StatCard
            icon={Receipt}
            label="Order Bulan Ini"
            value={stats.monthOrders}
            sub={new Date().toLocaleDateString('id-ID', { month: 'long' })}
            color="blue"
            delay={120}
          />
          <StatCard
            icon={Star}
            label="Piutang Aktif"
            value={formatCompact(stats.totalActiveDebt)}
            sub={`${stats.activeDebtsCount} customer`}
            color="amber"
            delay={180}
          />
        </div>

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
                    {c.name[0]?.toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-semibold truncate"
                      style={{ color: 'var(--text-primary)' }}>
                      {c.name}
                    </p>
                    <p className="text-xs truncate" style={{ color: 'var(--accent-light)', fontFamily: 'Syne' }}>
                      {formatCompact(c.totalSpent)}
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
                      {p.sold} terjual
                    </p>
                  </div>
                  <div className="text-xs font-bold" style={{ color: 'var(--accent-light)', fontFamily: 'Syne' }}>
                    {formatCompact(p.price * p.sold)}
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

          {/* Pie chart - sales by category */}
          <div className="rounded-2xl p-5 animate-slideUp"
            style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', animationDelay: '420ms' }}>
            <h2 className="font-bold text-sm mb-3"
              style={{ fontFamily: 'Syne', color: 'var(--text-primary)' }}>
              Distribusi Kategori
            </h2>
            <ResponsiveContainer width="100%" height={180}>
              <PieChart>
                <Pie
                  data={pieData}
                  cx="50%"
                  cy="50%"
                  innerRadius={40}
                  outerRadius={70}
                  paddingAngle={3}
                  dataKey="value"
                  stroke="none"
                >
                  {pieData.map((_, i) => (
                    <Cell key={i} fill={COLORS[i % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{
                    background: 'rgba(28,28,40,0.95)',
                    border: '1px solid var(--border-strong)',
                    borderRadius: 12,
                    fontSize: 11,
                  }}
                  formatter={(v) => formatRupiah(v)}
                />
              </PieChart>
            </ResponsiveContainer>
            <div className="flex flex-wrap gap-1.5 mt-2">
              {pieData.slice(0, 6).map((p, i) => (
                <div key={p.name} className="flex items-center gap-1.5 text-xs"
                  style={{ color: 'var(--text-secondary)' }}>
                  <span className="w-2 h-2 rounded-full" style={{ background: COLORS[i % COLORS.length] }} />
                  {p.name}
                </div>
              ))}
            </div>
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
                const s = STATUS_MAP[t.status]
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
                      {t.customer[0]}
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
                        {formatCompact(t.total)}
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
    </div>
  )
}
