import React, { useState } from 'react'
import { AlertTriangle, Database, RefreshCw } from 'lucide-react'
import Sidebar from './components/Sidebar'
import Header from './components/Header'
import Settings from './components/Settings'
import BottomNav from './components/BottomNav'
import ErrorBoundary from './components/ErrorBoundary'
import Dashboard from './pages/Dashboard'
import Kasir from './pages/Kasir'
import Produk from './pages/Produk'
import Order from './pages/Order'
import Customers from './pages/Customers'
import Piutang from './pages/Piutang'
import Login from './pages/Login'
import Logo from './components/Logo'
import { ToastProvider } from './components/Toast'
import { useStore } from './hooks/useStore'

function LoadingSplash() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center mesh-bg p-6">
      <div className="animate-float mb-6"><Logo size={72} /></div>
      <div className="flex items-center gap-3 text-sm"
        style={{ color: 'var(--text-secondary)', fontFamily: 'Syne' }}>
        <div className="w-4 h-4 rounded-full border-2 border-purple-400/30 border-t-purple-400 animate-spin" />
        Memuat data dari Supabase...
      </div>
    </div>
  )
}

function ErrorScreen({ error, onRetry }) {
  return (
    <div className="min-h-screen flex items-center justify-center mesh-bg p-6">
      <div
        className="max-w-md w-full rounded-2xl p-7 animate-scaleIn"
        style={{
          background: 'rgba(28,28,40,0.85)',
          backdropFilter: 'blur(20px)',
          border: '1px solid var(--border-strong)',
          boxShadow: '0 24px 80px rgba(0,0,0,0.5)',
        }}
      >
        <div
          className="w-16 h-16 rounded-2xl flex items-center justify-center mb-4 mx-auto"
          style={{ background: 'rgba(255,77,106,0.12)', border: '1px solid rgba(255,77,106,0.3)' }}
        >
          <AlertTriangle size={28} style={{ color: 'var(--red)' }} />
        </div>
        <h2 className="font-bold text-xl text-center mb-2"
          style={{ fontFamily: 'Syne', color: 'var(--text-primary)' }}>
          Tidak Dapat Terhubung
        </h2>
        <p className="text-sm text-center mb-5" style={{ color: 'var(--text-secondary)' }}>
          {error}
        </p>
        <div className="rounded-xl p-4 mb-5 text-xs space-y-2"
          style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', color: 'var(--text-muted)' }}>
          <div className="flex items-center gap-2 font-semibold"
            style={{ color: 'var(--accent-light)', fontFamily: 'Syne' }}>
            <Database size={13} /> Cara setup
          </div>
          <ol className="list-decimal pl-4 space-y-1">
            <li>Buat project di <strong>supabase.com</strong></li>
            <li>Jalankan <code>supabase/schema.sql</code> di SQL Editor</li>
            <li>Copy <code>.env.example</code> → <code>.env</code> isi URL + anon key</li>
            <li>Restart <code>npm run dev</code></li>
          </ol>
        </div>
        <button
          onClick={onRetry}
          className="w-full flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-bold btn-press"
          style={{
            background: 'linear-gradient(135deg, var(--accent), #6366f1)',
            color: '#fff',
            boxShadow: '0 4px 16px rgba(139,92,246,0.35)',
            fontFamily: 'Syne',
          }}
        >
          <RefreshCw size={14} /> Coba Lagi
        </button>
      </div>
    </div>
  )
}

function AppShell() {
  const [activePage, setActivePage] = useState('dashboard')
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const store = useStore()

  if (store.loading) return <LoadingSplash />
  if (store.error) return <ErrorScreen error={store.error} onRetry={store.refreshAll} />
  if (!store.currentUser) {
    return <Login login={store.login} storeInfo={store.storeInfo} busy={store.busy} />
  }

  const pages = {
    dashboard: <Dashboard
      stats={store.stats}
      transactions={store.transactions}
      storeInfo={store.storeInfo}
      currentUser={store.currentUser}
      setActivePage={setActivePage}
    />,
    kasir: <Kasir
      products={store.products}
      customers={store.customers}
      addTransaction={store.addTransaction}
      storeInfo={store.storeInfo}
      busy={store.busy}
    />,
    produk: <Produk
      products={store.products}
      addProduct={store.addProduct}
      updateProduct={store.updateProduct}
      deleteProduct={store.deleteProduct}
      busy={store.busy}
    />,
    order: <Order
      transactions={store.transactions}
      products={store.products}
      customers={store.customers}
      storeInfo={store.storeInfo}
      updateTransactionStatus={store.updateTransactionStatus}
      updateTransactionPayment={store.updateTransactionPayment}
      updateOrderStatus={store.updateOrderStatus}
      deleteTransaction={store.deleteTransaction}
      busy={store.busy}
    />,
    customers: <Customers
      customers={store.customers}
      transactions={store.transactions}
      addCustomer={store.addCustomer}
      updateCustomer={store.updateCustomer}
      deleteCustomer={store.deleteCustomer}
    />,
    piutang: <Piutang
      debts={store.debts}
      customers={store.customers}
      transactions={store.transactions}
      stats={store.stats}
      payDebt={store.payDebt}
      deleteDebt={store.deleteDebt}
      getDebtPayments={store.getDebtPayments}
    />,
  }

  return (
    <div
      className="flex w-screen overflow-hidden"
      style={{
        background: 'var(--bg-primary)',
        // Use 100dvh (dynamic viewport height) to handle mobile Safari URL bar
        // Fallback to 100vh for older browsers
        height: '100dvh',
        minHeight: '100vh',
      }}
    >
      <Sidebar
        activePage={activePage}
        setActivePage={setActivePage}
        mobileOpen={mobileMenuOpen}
        onMobileClose={() => setMobileMenuOpen(false)}
        storeInfo={store.storeInfo}
        currentUser={store.currentUser}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <main className="flex flex-1 flex-col overflow-hidden" style={{ minWidth: 0 }}>
        <Header
          activePage={activePage}
          onMenuToggle={() => setMobileMenuOpen(true)}
          currentUser={store.currentUser}
          onOpenSettings={() => setSettingsOpen(true)}
        />
        <div
          className="flex-1 overflow-hidden flex flex-col"
          style={{
            minHeight: 0,
            // Reserve space for the mobile bottom nav on small screens
            paddingBottom: 0,
          }}
        >
          <ErrorBoundary
            key={activePage}
            title={`Halaman ${activePage} gagal dimuat`}
          >
            {pages[activePage]}
          </ErrorBoundary>
        </div>
      </main>

      <BottomNav
        activePage={activePage}
        onChange={setActivePage}
        onMore={() => setMobileMenuOpen(true)}
      />

      <Settings
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        storeInfo={store.storeInfo}
        admins={store.admins}
        currentUser={store.currentUser}
        busy={store.busy}
        updateStoreInfo={store.updateStoreInfo}
        updateLogo={store.updateLogo}
        addAdmin={store.addAdmin}
        deleteAdmin={store.deleteAdmin}
        changePassword={store.changePassword}
        logout={() => { setSettingsOpen(false); store.logout() }}
      />
    </div>
  )
}

export default function App() {
  return (
    <ErrorBoundary title="Aplikasi gagal dimuat">
      <ToastProvider>
        <AppShell />
      </ToastProvider>
    </ErrorBoundary>
  )
}
