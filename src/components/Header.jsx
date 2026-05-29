import React from 'react'
import { Menu, Bell, Clock, Settings as SettingsIcon } from 'lucide-react'

const PAGE_TITLES = {
  dashboard: { title: 'Dashboard', sub: 'Statistik & ringkasan toko' },
  kasir: { title: 'Kasir', sub: 'Transaksi POS realtime' },
  produk: { title: 'Produk', sub: 'Manajemen katalog produk' },
  order: { title: 'Order', sub: 'Daftar pesanan & invoice' },
  customers: { title: 'Customers', sub: 'Database pelanggan' },
  piutang: { title: 'Piutang', sub: 'Hutang & cicilan customer' },
}

export default function Header({ activePage, onMenuToggle, currentUser, onOpenSettings }) {
  const meta = PAGE_TITLES[activePage] || PAGE_TITLES.dashboard
  const [now, setNow] = React.useState(new Date())

  React.useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000)
    return () => clearInterval(t)
  }, [])

  const initial = (currentUser?.username || 'A')[0].toUpperCase()

  return (
    <header
      className="flex items-center justify-between px-4 lg:px-6 py-3.5 flex-shrink-0"
      style={{
        background: 'rgba(17, 17, 24, 0.7)',
        backdropFilter: 'blur(16px) saturate(180%)',
        WebkitBackdropFilter: 'blur(16px) saturate(180%)',
        borderBottom: '1px solid var(--border)',
      }}
    >
      <div className="flex items-center gap-3 min-w-0">
        <button
          onClick={onMenuToggle}
          className="lg:hidden flex items-center justify-center rounded-xl flex-shrink-0"
          style={{
            width: 36, height: 36,
            background: 'var(--bg-card)',
            border: '1px solid var(--border)',
            color: 'var(--text-secondary)',
          }}
        >
          <Menu size={17} />
        </button>
        <div className="min-w-0">
          <h1 className="font-bold text-base lg:text-lg leading-tight truncate"
            style={{ fontFamily: 'Syne', color: 'var(--text-primary)' }}>
            {meta.title}
          </h1>
          <p className="text-xs truncate hidden sm:block" style={{ color: 'var(--text-muted)' }}>
            {meta.sub}
          </p>
        </div>
      </div>

      <div className="flex items-center gap-2 flex-shrink-0">
        <div className="hidden md:flex items-center gap-2 px-3 py-2 rounded-xl"
          style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
          <Clock size={13} style={{ color: 'var(--accent-light)' }} />
          <span className="text-xs font-medium" style={{ color: 'var(--text-secondary)', fontFamily: 'DM Sans' }}>
            {now.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}
          </span>
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>·</span>
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
            {now.toLocaleDateString('id-ID', { day: 'numeric', month: 'short' })}
          </span>
        </div>

        <button
          className="relative flex items-center justify-center rounded-xl"
          style={{
            width: 36, height: 36,
            background: 'var(--bg-card)',
            border: '1px solid var(--border)',
            color: 'var(--text-secondary)',
          }}
        >
          <Bell size={15} />
          <span className="absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full"
            style={{ background: 'var(--accent)' }} />
        </button>

        <button
          onClick={onOpenSettings}
          className="hidden md:flex items-center gap-2 px-2 py-1 rounded-xl btn-press"
          style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
        >
          <div className="w-7 h-7 rounded-lg flex items-center justify-center text-xs font-bold"
            style={{
              background: currentUser?.role === 'owner'
                ? 'linear-gradient(135deg, #f59e0b, #ea580c)'
                : 'linear-gradient(135deg, #8b5cf6, #6366f1)',
              color: '#fff', fontFamily: 'Syne',
            }}>
            {initial}
          </div>
          <div className="hidden lg:block pr-1 text-left">
            <div className="text-xs font-semibold leading-tight"
              style={{ color: 'var(--text-primary)', fontFamily: 'Syne' }}>
              {currentUser?.name || currentUser?.username || 'Admin'}
            </div>
            <div className="text-xs leading-tight" style={{ color: 'var(--text-muted)' }}>
              {currentUser?.role || 'staff'}
            </div>
          </div>
        </button>

        <button
          onClick={onOpenSettings}
          className="md:hidden flex items-center justify-center rounded-xl"
          style={{
            width: 36, height: 36,
            background: 'var(--bg-card)',
            border: '1px solid var(--border)',
            color: 'var(--text-secondary)',
          }}
          title="Pengaturan"
        >
          <SettingsIcon size={15} />
        </button>
      </div>
    </header>
  )
}
