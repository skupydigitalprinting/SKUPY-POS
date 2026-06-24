import React, { useState, useEffect, useRef, lazy, Suspense } from 'react'
import { AlertTriangle, Database, RefreshCw, Loader2 } from 'lucide-react'
import Sidebar from './components/Sidebar'
import Header from './components/Header'
import BookSplash from './components/BookSplash'
import { InvoicePreviewProvider } from './components/InvoicePreview'
import BottomNav from './components/BottomNav'
import ErrorBoundary from './components/ErrorBoundary'
import Login from './pages/Login'
import Logo from './components/Logo'
import { ToastProvider, useToast } from './components/Toast'
import { ConfirmProvider } from './components/Confirm'
import { useStore } from './hooks/useStore'

// ─── Code splitting ───────────────────────────────────────────
// Halaman & modal besar di-lazy-load supaya bundle awal kecil & cepat
// (penting di Safari iPhone). Hanya halaman aktif yang di-download.
const Dashboard = lazy(() => import('./pages/Dashboard'))
const Kasir = lazy(() => import('./pages/Kasir'))
const Produk = lazy(() => import('./pages/Produk'))
const Order = lazy(() => import('./pages/Order'))
const Customers = lazy(() => import('./pages/Customers'))
const Piutang = lazy(() => import('./pages/Piutang'))
const Accounting = lazy(() => import('./pages/Accounting'))
const Credibook = lazy(() => import('./pages/Credibook'))
const Settings = lazy(() => import('./components/Settings'))

function PageLoader() {
  return (
    <div className="flex-1 flex items-center justify-center" style={{ minHeight: 200 }}>
      <Loader2 size={26} className="animate-spin" style={{ color: 'var(--accent-light)' }} />
    </div>
  )
}

function AccessDenied() {
  return (
    <div className="flex-1 flex items-center justify-center mesh-bg p-6">
      <div className="text-center max-w-sm">
        <div className="w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-4"
          style={{ background: 'rgba(255,77,106,0.12)', border: '1px solid rgba(255,77,106,0.3)' }}>
          <AlertTriangle size={26} style={{ color: 'var(--red)' }} />
        </div>
        <h2 className="font-bold text-lg" style={{ fontFamily: 'Syne', color: 'var(--text-primary)' }}>Akses Ditolak</h2>
        <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>
          Halaman ini hanya untuk Owner & Staff Admin.
        </p>
      </div>
    </div>
  )
}

function LoadingSplash() {
  const [showSlow, setShowSlow] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setShowSlow(true), 3000)
    return () => clearTimeout(t)
  }, [])

  return (
    <div
      className="flex flex-col items-center justify-center mesh-bg p-6"
      style={{ minHeight: '100dvh', width: '100%' }}
    >
      <div
        style={{
          animation: 'splashPulse 2.2s ease-in-out infinite',
          textAlign: 'center',
        }}
      >
        <div
          style={{
            fontFamily: 'Syne, sans-serif',
            fontWeight: 800,
            fontSize: 'clamp(56px, 16vw, 120px)',
            color: '#ffffff',
            letterSpacing: '-0.04em',
            lineHeight: 1,
            // subtle gradient glow under the wordmark
            textShadow:
              '0 0 24px rgba(139,92,246,0.35), 0 0 48px rgba(99,102,241,0.18)',
          }}
        >
          SKUPY
        </div>
        <div
          style={{
            marginTop: 14,
            fontFamily: 'DM Sans, sans-serif',
            fontStyle: 'italic',
            fontWeight: 400,
            fontSize: 'clamp(13px, 3.4vw, 16px)',
            color: 'rgba(255,255,255,0.55)',
            letterSpacing: '0.01em',
          }}
        >
          Cetak Impian, Wujudkan Karya
        </div>
      </div>

      {/* Subtle slow-loading hint (only after 3s) */}
      <div
        style={{
          position: 'absolute',
          bottom: 'calc(env(safe-area-inset-bottom) + 32px)',
          left: 0, right: 0,
          textAlign: 'center',
          fontFamily: 'Syne, sans-serif',
          fontSize: 12,
          color: 'rgba(255,255,255,0.4)',
          letterSpacing: '0.04em',
          opacity: showSlow ? 1 : 0,
          transition: 'opacity 0.6s ease',
        }}
      >
        Menyiapkan sistem...
      </div>

      <style>{`
        @keyframes splashPulse {
          0%, 100% { opacity: 0.78; transform: scale(1); }
          50%      { opacity: 1; transform: scale(1.025); }
        }
      `}</style>
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
  // Default starting page tergantung role — admin/cashier langsung ke Kasir
  // (Dashboard digated untuk owner saja).
  const store = useStore()
  const toast = useToast()
  const role = store.currentUser?.role
  const isOwner = role === 'owner'
  // Owner & Staff Admin boleh melihat dashboard; Staff Kasir tidak.
  const canSeeDashboard = role === 'owner' || role === 'admin'
  const [activePage, setActivePageRaw] = useState(canSeeDashboard ? 'dashboard' : 'kasir')
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  // Deep-link tab Accounting (mis. tombol Pengeluaran di Credibook). Signal naik
  // tiap permintaan agar Accounting selalu pindah tab walau tab-nya sama.
  const [accTab, setAccTab] = useState(null)
  const [accTabSignal, setAccTabSignal] = useState(0)
  // Shortcut eksplisit ke tab Accounting tertentu (mis. Credibook → Pengeluaran).
  // Pakai setActivePageRaw agar TIDAK kena reset 'ringkasan' di setActivePage.
  const goAccountingTab = (tabId) => {
    if (!GATED.accounting) { setActivePage('accounting'); return }
    setAccTab(tabId); setAccTabSignal(n => n + 1); setActivePageRaw('accounting')
  }

  // ── Splash premium saat ganti Book (SKUPY ⇄ THEWA ⇄ Semua) ──
  const [splash, setSplash] = useState(null)
  const prevBookRef = useRef(store.activeBookId)
  useEffect(() => {
    if (prevBookRef.current === store.activeBookId) return
    prevBookRef.current = store.activeBookId
    const bk = store.activeBookId ? (store.books || []).find(b => b.id === store.activeBookId) : null
    setSplash({ key: Date.now(), book: bk })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.activeBookId, store.books])

  // Dashboard, Accounting & Credibook: hanya Owner & Staff Admin. Kasir diblok.
  const GATED = { dashboard: canSeeDashboard, accounting: canSeeDashboard, credibook: canSeeDashboard }

  // Wrap setActivePage: kalau Staff Kasir mencoba membuka halaman tergated,
  // tampilkan toast dan redirect ke 'kasir'. Tidak ada akses tersembunyi.
  const setActivePage = (next) => {
    if (next in GATED && !GATED[next]) {
      toast.warning(`${next === 'accounting' ? 'Accounting' : next === 'credibook' ? 'Credibook' : 'Dashboard'} hanya untuk Owner & Staff Admin`)
      setActivePageRaw('kasir')
      return
    }
    // Membuka Accounting dari sidebar SELALU default ke tab Ringkasan (jangan
    // ingat tab terakhir / deep-link Pengeluaran). Shortcut Credibook pakai
    // goAccountingTab yang men-set tab eksplisit tanpa reset ini.
    if (next === 'accounting') { setAccTab('ringkasan'); setAccTabSignal(n => n + 1) }
    setActivePageRaw(next)
  }

  // Saat role berubah (mis. login ulang sebagai Staff Kasir), jangan nyangkut
  // di halaman tergated.
  useEffect(() => {
    if ((activePage === 'dashboard' || activePage === 'accounting' || activePage === 'credibook') && !canSeeDashboard) {
      setActivePageRaw('kasir')
    }
  }, [canSeeDashboard, activePage])

  if (store.loading) return <LoadingSplash />
  if (store.error) return <ErrorScreen error={store.error} onRetry={store.refreshAll} />
  if (!store.currentUser) {
    return <Login login={store.login} storeInfo={store.storeInfo} busy={store.busy} />
  }

  // Filter transaksi berdasar role:
  //   • owner   → semua transaksi
  //   • admin/cashier → hanya transaksi yang dia buat (cashier_id == user.id)
  // Owner dashboard menerima FULL list (untuk filter per-admin di UI).
  // Halaman lain (Order/Customers/Piutang) menerima list yang sudah disaring.
  // Hak akses tampilan: Owner & Staff Admin lihat SEMUA; Staff Kasir hanya
  // miliknya. Customer/piutang kini berbasis PIC (owner_user_id), order tetap
  // berbasis kasir pembuat. Tidak mengubah data — hanya menyaring tampilan.
  const canSeeAll = role === 'owner' || role === 'admin'
  const myId = store.currentUser?.id
  const ownerOfCustomer = (cid) => store.customers.find(c => c.id === cid)?.ownerUserId || null
  const scopedTransactions = canSeeAll
    ? store.transactions
    : store.transactions.filter(t => t.cashierId === myId)
  const scopedCustomers = canSeeAll
    ? store.customers
    : store.customers.filter(c => c.ownerUserId === myId)
  // Piutang mengikuti PIC customer: kasir hanya lihat piutang customer miliknya.
  const scopedDebts = canSeeAll
    ? store.debts
    : store.debts.filter(d => {
        const pic = ownerOfCustomer(d.customerId)
        if (pic) return pic === myId
        // fallback (customer tak ketemu): pakai kasir pembuat transaksi
        const linked = store.transactions.find(t => t.id === d.transactionId)
        return !linked || linked.cashierId === myId
      })

  const pages = {
    dashboard: <Dashboard
      stats={store.stats}
      transactions={store.transactions}
      products={store.products}
      debts={store.debts}
      debtPayments={store.debtPayments}
      admins={store.admins}
      storeInfo={store.storeInfo}
      currentUser={store.currentUser}
      setActivePage={setActivePage}
      deleteTransaction={store.deleteTransaction}
      editTransaction={store.editTransaction}
      editDebtPayment={store.editDebtPayment}
      deleteDebtPayment={store.deleteDebtPayment}
    />,
    kasir: <Kasir
      products={store.products}
      customers={scopedCustomers}
      addTransaction={store.addTransaction}
      addCustomer={store.addCustomer}
      admins={store.admins}
      storeInfo={store.storeInfo}
      currentUser={store.currentUser}
      setProductFavorite={store.setProductFavorite}
      busy={store.busy}
    />,
    produk: <Produk
      products={store.products}
      currentUser={store.currentUser}
      addProduct={store.addProduct}
      updateProduct={store.updateProduct}
      deleteProduct={store.deleteProduct}
      busy={store.busy}
    />,
    order: <Order
      transactions={scopedTransactions}
      products={store.products}
      customers={scopedCustomers}
      admins={store.admins}
      storeInfo={store.storeInfo}
      currentUser={store.currentUser}
      updateTransactionStatus={store.updateTransactionStatus}
      updateTransactionPayment={store.updateTransactionPayment}
      updateOrderStatus={store.updateOrderStatus}
      deleteTransaction={store.deleteTransaction}
      reassignOrderCustomer={store.reassignOrderCustomer}
      getOrderCustomerChanges={store.getOrderCustomerChanges}
      busy={store.busy}
    />,
    customers: <Customers
      customers={scopedCustomers}
      transactions={scopedTransactions}
      currentUser={store.currentUser}
      admins={store.admins}
      addCustomer={store.addCustomer}
      updateCustomer={store.updateCustomer}
      deleteCustomer={store.deleteCustomer}
    />,
    piutang: <Piutang
      debts={scopedDebts}
      customers={scopedCustomers}
      transactions={scopedTransactions}
      admins={store.admins}
      currentUser={store.currentUser}
      payDebt={store.payDebt}
      payCustomerDebtsFIFO={store.payCustomerDebtsFIFO}
      deleteDebt={store.deleteDebt}
      getDebtPayments={store.getDebtPayments}
      reassignReceivableCustomer={store.reassignReceivableCustomer}
      getReceivableCustomerChanges={store.getReceivableCustomerChanges}
    />,
    // Credibook (owner/staff admin saja) — pemasukkan manual + shortcut pengeluaran.
    credibook: canSeeDashboard
      ? <Credibook
          currentUser={store.currentUser}
          activeBookId={store.activeBookId}
          defaultBookId={store.defaultBookId}
          books={store.books}
          setActivePage={setActivePage}
          onPengeluaran={() => goAccountingTab('pengeluaran')}
          onChanged={store.refreshCredibook}
        />
      : <AccessDenied />,
    // Accounting (owner/staff admin saja) — lazy, owner-gated di setActivePage.
    accounting: canSeeDashboard
      ? <Accounting
          admins={store.admins}
          currentUser={store.currentUser}
          editTransaction={store.editTransaction}
          deleteTransaction={store.deleteTransaction}
          setActivePage={setActivePage}
          initialTab={accTab}
          initialTabSignal={accTabSignal}
        />
      : <AccessDenied />,
  }

  return (
    <InvoicePreviewProvider resolve={store.getTransactionByInvoice} storeInfo={store.storeInfo}>
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
      {splash && <BookSplash key={splash.key} book={splash.book} onDone={() => setSplash(null)} />}
      <Sidebar
        activePage={activePage}
        setActivePage={setActivePage}
        mobileOpen={mobileMenuOpen}
        onMobileClose={() => setMobileMenuOpen(false)}
        storeInfo={store.storeInfo}
        currentUser={store.currentUser}
        // Only owner can open Settings — staff sees Logout button instead
        onOpenSettings={isOwner ? () => setSettingsOpen(true) : undefined}
        onLogout={store.logout}
      />
      <main className="flex flex-1 flex-col overflow-hidden" style={{ minWidth: 0 }}>
        <Header
          activePage={activePage}
          onMenuToggle={() => setMobileMenuOpen(true)}
          currentUser={store.currentUser}
          // Only owner can open Settings via header chip
          onOpenSettings={isOwner ? () => setSettingsOpen(true) : undefined}
          onLogout={store.logout}
          onRefresh={store.refreshAll}
          books={store.books}
          activeBookId={store.activeBookId}
          onSelectBook={store.setActiveBook}
          onAddBook={store.addBook}
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
            <Suspense fallback={<PageLoader />}>
              {pages[activePage]}
            </Suspense>
          </ErrorBoundary>
        </div>
      </main>

      <BottomNav
        activePage={activePage}
        onChange={setActivePage}
        onMore={() => setMobileMenuOpen(true)}
        currentUser={store.currentUser}
      />

      {/* Settings modal — OWNER ONLY (security: not just hidden, refuse to render).
          Lazy: chunk hanya di-download saat owner benar-benar membuka Pengaturan. */}
      {settingsOpen && isOwner && (
        <Suspense fallback={null}>
          <Settings
            open
            onClose={() => setSettingsOpen(false)}
            storeInfo={store.storeInfo}
            admins={store.admins}
            currentUser={store.currentUser}
            products={store.products}
            busy={store.busy}
            updateStoreInfo={store.updateStoreInfo}
            updateLogo={store.updateLogo}
            addAdmin={store.addAdmin}
            updateAdmin={store.updateAdmin}
            deleteAdmin={store.deleteAdmin}
            reassignAdminCustomers={store.reassignAdminCustomers}
            changePassword={store.changePassword}
            logout={() => { setSettingsOpen(false); store.logout() }}
            adminBankAccounts={store.adminBankAccounts}
            addBankAccount={store.addBankAccount}
            updateBankAccount={store.updateBankAccount}
            deleteBankAccount={store.deleteBankAccount}
            masterData={{
              storeLocations: store.storeLocations,
              storeContacts: store.storeContacts,
              storeBankAccounts: store.storeBankAccounts,
              adminInvoiceProfiles: store.adminInvoiceProfiles,
              addLocation: store.addLocation, updateLocation: store.updateLocation, deleteLocation: store.deleteLocation,
              addContact: store.addContact, updateContact: store.updateContact, deleteContact: store.deleteContact,
              addStoreBank: store.addStoreBank, updateStoreBank: store.updateStoreBank, deleteStoreBank: store.deleteStoreBank,
              setAdminInvoiceProfile: store.setAdminInvoiceProfile,
              invoiceProfileForAdmin: store.invoiceProfileForAdmin,
            }}
          />
        </Suspense>
      )}
    </div>
    </InvoicePreviewProvider>
  )
}

export default function App() {
  return (
    <ErrorBoundary title="Aplikasi gagal dimuat">
      <ToastProvider>
        <ConfirmProvider>
          <AppShell />
        </ConfirmProvider>
      </ToastProvider>
    </ErrorBoundary>
  )
}
