import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { getDataClient, secureAuthEnabled, isSupabaseConfigured, uploadLogo, deleteLogo } from '../lib/supabase'
import { ADMIN_PROFILE_COLUMNS, adminProfileFromDB as adminFromDB } from '../utils/adminProfile'
import { PRODUCT_PUBLIC_COLUMNS, attachProductCosts, saveSecureProduct } from '../lib/productAccess'
import { createInvoiceChangeClient } from '../lib/invoiceChangeClient'
import { createInvoiceWorkflow } from '../lib/invoiceWorkflow'
import { createPaymentClient } from '../lib/paymentClient'

// Session persistence — "Ingat saya / Tetap login".
//   • Ingat saya ON  → localStorage, berlaku 30 hari (auto-hapus bila lewat).
//   • Ingat saya OFF → sessionStorage saja (hilang saat tab/browser ditutup).
// HANYA menyimpan data non-sensitif: id, username, name, role, login_time.
// TIDAK pernah menyimpan password / PIN / hash.
const SESSION_KEY = 'skupy_session_v2'
const REMEMBER_TTL = 30 * 24 * 60 * 60 * 1000 // 30 hari (ms)

// Direct reassignment is incompatible with the secure server-owned links/audit.
const reassignmentUnavailable = () => ({
  ok: false,
  code: 'SECURE_REASSIGNMENT_UNAVAILABLE',
  error: 'Pemindahan customer/PIC belum tersedia di mode keamanan baru. Tidak ada perubahan yang disimpan.',
})

const incompleteTransactionSync = () => ({
  ok: false,
  needsReconciliation: true,
  error: 'Sebagian perubahan mungkin sudah tersimpan, tetapi sinkronisasi belum terkonfirmasi. Periksa invoice dan piutang sebelum mengulang tindakan.',
})

// Supabase minimal-return writes legitimately contain data:null. Row-returning
// payment writes additionally require the affected row, so a zero-row write fails.
function confirmedWrite(result, expectedId) {
  return !!result && result.error === null && Object.hasOwn(result, 'data')
    && result.count !== 0 && (expectedId === undefined
      || (!!result.data?.id && (expectedId === null || result.data.id === expectedId)))
}

function paymentRead(result) {
  if (!result || result.error !== null || !Object.hasOwn(result, 'data') || result.data === undefined) {
    throw new Error('Data pembayaran belum dapat diperiksa. Tidak ada perubahan yang disimpan.')
  }
  return result.data
}

function paymentMoney(value) {
  const raw = Number(value)
  if (!['number', 'string'].includes(typeof value) || String(value).trim() === ''
    || !Number.isFinite(raw) || raw < 0 || !Number.isSafeInteger(Math.round(raw))) {
    throw new Error('Nominal keuangan tidak valid. Minta owner memeriksa data.')
  }
  return Math.round(raw)
}

function paymentSnapshot(total, paid, remaining) {
  const t = paymentMoney(total), p = paymentMoney(paid), r = paymentMoney(remaining)
  if (Math.abs(Number(total) - Number(paid) - Number(remaining)) >= 1 || t !== p + r) {
    throw Object.assign(new Error('Saldo invoice/piutang tidak sesuai. Minta owner memeriksa data; belum ada perubahan yang disimpan.'), { needsReview: true })
  }
  return { total: t, paid: p, remaining: r }
}

function paymentBalance(total, paid, delta) {
  const t = paymentMoney(total), p = paymentMoney(paid)
  if (!Number.isSafeInteger(delta) || p > t
    || p + delta < 0 || p + delta > t || !Number.isSafeInteger(p + delta)) {
    throw new Error('Nominal pembayaran tidak valid atau melebihi sisa tagihan. Periksa saldo invoice/piutang.')
  }
  return { paid: p + delta, remaining: t - p - delta }
}

const inactiveFinancialInvoice = row => !!(row.deleted_at || row.deletedAt)
  || (row.order_status || row.orderStatus) === 'dibatalkan'
  || ['batal', 'cancelled'].includes(row.status) || row.cancelled === true

function safeUser(u) {
  if (!u) return null
  return { id: u.id, username: u.username, name: u.name, role: u.role, login_time: u.login_time || Date.now() }
}

function loadSession() {
  try {
    // 1) sessionStorage (login tanpa "ingat saya") — prioritas dalam tab aktif.
    const rawS = sessionStorage.getItem(SESSION_KEY)
    if (rawS) {
      const s = JSON.parse(rawS)
      return safeUser(s?.user || (s?.id ? s : null))
    }
    // 2) localStorage ("ingat saya") — cek masa berlaku 30 hari.
    const rawL = localStorage.getItem(SESSION_KEY)
    if (!rawL) return null
    const s = JSON.parse(rawL)
    if (s?.expires && Date.now() > s.expires) { localStorage.removeItem(SESSION_KEY); return null }
    return safeUser(s?.user || (s?.id ? s : null)) // s.id → kompat format lama
  } catch { return null }
}

function saveSession(user, remember) {
  try {
    const payload = { user: safeUser(user), remember: !!remember }
    if (remember) {
      payload.expires = Date.now() + REMEMBER_TTL
      localStorage.setItem(SESSION_KEY, JSON.stringify(payload))
      sessionStorage.removeItem(SESSION_KEY)
    } else {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(payload))
      localStorage.removeItem(SESSION_KEY)
    }
  } catch {}
}

function clearSession() {
  try { localStorage.removeItem(SESSION_KEY); sessionStorage.removeItem(SESSION_KEY) } catch {}
}

// Apakah sesi sekarang "ingat saya" (tersimpan di localStorage)? Dipakai saat
// menyimpan ulang sesi (mis. user yang sedang login mengganti nama/username)
// agar tetap memakai storage yang sama.
function sessionRemembered() {
  try { return !!localStorage.getItem(SESSION_KEY) } catch { return false }
}

// ---------- mappers ----------

const settingsFromDB = (r) => r ? ({
  id: r.id,
  name: r.name || '',
  tagline: r.tagline || '',
  address: r.address || '',
  phone: r.phone || '',
  email: r.email || '',
  bank: { name: r.bank_name || '', number: r.bank_number || '', holder: r.bank_holder || '' },
  frontLogo: r.front_logo || '',
  invoiceLogo: r.invoice_logo || '',
  taxRate: r.tax_rate ?? 0,
}) : null

const settingsToDB = (s) => ({
  name: s.name, tagline: s.tagline, address: s.address, phone: s.phone, email: s.email,
  bank_name: s.bank?.name ?? '', bank_number: s.bank?.number ?? '', bank_holder: s.bank?.holder ?? '',
  front_logo: s.frontLogo ?? '', invoice_logo: s.invoiceLogo ?? '',
  tax_rate: s.taxRate ?? 0,
})

const customerFromDB = (r) => ({
  id: r.id,
  name: r.name,
  phone: r.phone || '',
  whatsapp: r.whatsapp || r.phone || '',
  address: r.address || '',
  email: r.email || '',
  notes: r.notes || '',
  totalTransactions: Number(r.total_transactions) || 0,
  totalSpent: Number(r.total_spent) || 0,
  totalDebt: Number(r.total_debt) || 0,
  createdBy: r.created_by || null,
  createdByName: r.created_by_name || '',
  createdByRole: r.created_by_role || '',
  ownerUserId: r.owner_user_id || null,
  ownerUsername: r.owner_username || '',
  ownerName: r.owner_name || '',
  deletedAt: r.deleted_at || null,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

const customerToDB = (c) => ({
  name: c.name,
  phone: c.phone || '',
  whatsapp: c.whatsapp || '',
  address: c.address || '',
  email: c.email || '',
  notes: c.notes || '',
})

const productFromDB = (r) => ({
  id: r.id, name: r.name, category: r.category,
  price: Number(r.price) || 0, modal: Number(r.modal) || 0, stock: Number(r.stock) || 0,
  unit: (r.unit || 'pcs').toLowerCase(),
  description: r.description || '', image: r.image || '',
  isFavorite: !!r.is_favorite,
  createdAt: r.created_at,
})

const productToDB = (p) => ({
  name: p.name, category: p.category,
  price: Number(p.price) || 0, modal: Number(p.modal) || 0, stock: Number(p.stock) || 0,
  unit: (p.unit || 'pcs').toLowerCase(),
  description: p.description || '', image: p.image || '',
  is_favorite: !!p.isFavorite,
})

const trxFromDB = (r) => ({
  id: r.id,
  version: Number.isSafeInteger(Number(r.version)) && r.version != null ? Number(r.version) : null,
  invoiceNo: r.invoice_no,
  orderNo: r.order_no || '',
  customer: r.customer,
  customerId: r.customer_id,
  customerPhone: r.customer_phone || '',
  customerAddress: r.customer_address || '',
  items: r.items || [],
  subtotal: +r.subtotal || 0, discount: +r.discount || 0, tax: +r.tax || 0,
  total: +r.total || 0, paid: +r.paid || 0, dp: +r.dp || 0, remaining: +r.remaining || 0,
  paymentMethod: r.payment_method,
  status: r.status,
  orderStatus: r.order_status || 'menunggu',
  notes: r.notes || '',
  statusHistory: r.status_history || [],
  cashier: r.cashier || '',
  cashierRole: r.cashier_role || '',
  cashierId: r.cashier_id,
  dueDate: r.due_date || null,
  date: r.created_at,
  deletedAt: r.deleted_at || null,
  // Snapshot rekening bank admin pembuat (histori invoice tetap aman)
  bankAccountId: r.bank_account_id || null,
  bankName: r.bank_name || '',
  bankNumber: r.bank_account_number || '',
  bankHolder: r.bank_account_holder || '',
  // Snapshot identitas toko (master data invoice)
  storeNameSnapshot: r.store_name_snapshot || '',
  addressSnapshot: r.address_snapshot || '',
  phoneSnapshot: r.phone_snapshot || '',
})

const trxToDB = (t) => ({
  invoice_no: t.invoiceNo,
  order_no: t.orderNo || null,
  customer: t.customer || 'Umum',
  customer_id: t.customerId || null,
  customer_phone: t.customerPhone || '',
  customer_address: t.customerAddress || '',
  items: t.items || [],
  subtotal: +t.subtotal || 0, discount: +t.discount || 0, tax: +t.tax || 0,
  total: +t.total || 0, paid: +t.paid || 0, dp: +t.dp || 0, remaining: +t.remaining || 0,
  payment_method: t.paymentMethod || 'cash',
  status: t.status || 'pending',
  order_status: t.orderStatus || 'menunggu',
  notes: t.notes || '',
  status_history: t.statusHistory || [],
  cashier: t.cashier || '',
  cashier_id: t.cashierId || null,
  cashier_role: t.cashierRole || '',
  due_date: t.dueDate || null,
  // PIC (owner) — hanya disertakan bila di-set (hindari error bila kolom belum ada)
  ...(t.ownerUserId ? { owner_user_id: t.ownerUserId, owner_name: t.ownerName || '' } : {}),
  // Snapshot rekening bank admin pembuat — hanya bila ada (kolom mungkin belum ada)
  ...((t.bankAccountId || t.bankName) ? {
    bank_account_id: t.bankAccountId || null,
    bank_name: t.bankName || '',
    bank_account_number: t.bankNumber || '',
    bank_account_holder: t.bankHolder || '',
    created_by_admin_id: t.cashierId || null,
  } : {}),
  // Snapshot identitas toko (master data) — hanya bila ada
  ...((t.storeNameSnapshot || t.addressSnapshot || t.phoneSnapshot) ? {
    store_name_snapshot: t.storeNameSnapshot || '',
    address_snapshot: t.addressSnapshot || '',
    phone_snapshot: t.phoneSnapshot || '',
  } : {}),
})

// Order workflow statuses (separate from payment status)
export const ORDER_WORKFLOW = [
  'menunggu',     // Just placed
  'diproses',     // Being processed
  'produksi',     // In production
  'selesai',      // Production complete
  'diambil',      // Picked up by customer
  'dikirim',      // Shipped
  'dibatalkan',   // Cancelled
]

const debtFromDB = (r) => ({
  id: r.id,
  customerId: r.customer_id,
  transactionId: r.transaction_id,
  invoiceNo: r.invoice_no,
  totalDebt: +r.total_debt || 0,
  paid: +r.paid || 0,
  remaining: +r.remaining || 0,
  dueDate: r.due_date,
  status: r.status,
  notes: r.notes || '',
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

// ---------- Hook ----------

export function useStore(verifiedSession = null) {
  const [supabase] = useState(getDataClient)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [products, setProducts] = useState([])
  const [transactions, setTransactions] = useState([])
  const [storeInfo, setStoreInfo] = useState(null)
  const [admins, setAdmins] = useState([])
  const [customers, setCustomers] = useState([])
  const [debts, setDebts] = useState([])
  const [debtPayments, setDebtPayments] = useState([])
  // Pemasukkan Credibook (pendapatan usaha non-kasir) — book-scoped, masuk Omset.
  const [credibookIncome, setCredibookIncome] = useState([])
  const [currentUser, setCurrentUser] = useState(() => secureAuthEnabled ? verifiedSession?.user || null : loadSession())
  // ── BOOK (multi-brand) ──
  // activeBookId null = "Semua Book" (perilaku lama, tanpa filter). Memilih book
  // tertentu menyaring data PENJUALAN (transactions/customers/debts/debt_payments).
  const [books, setBooks] = useState([])
  // Rekening bank per admin (owner kelola). Snapshot dipakai invoice.
  const [adminBankAccounts, setAdminBankAccounts] = useState([])
  // Master data invoice (owner): alamat, kontak, rekening + profil per admin.
  const [storeLocations, setStoreLocations] = useState([])
  const [storeContacts, setStoreContacts] = useState([])
  const [storeBankAccounts, setStoreBankAccounts] = useState([])
  const [adminInvoiceProfiles, setAdminInvoiceProfiles] = useState([])
  const [activeBookId, setActiveBookId] = useState(() => {
    if (secureAuthEnabled) return null
    try { return localStorage.getItem('skupy_active_book') || null } catch { return null }
  })
  const defaultBookId = useMemo(() => {
    const def = (books || []).find(b => b.is_default && !b.deleted_at)
    return def?.id || (books[0] && books[0].id) || null
  }, [books])
  // Filter query Supabase berdasarkan book aktif (no-op bila "Semua Book").
  const applyBook = (q) => (activeBookId ? q.eq('book_id', activeBookId) : q)
  // book_id untuk WRITE (transaksi/customer baru) — book aktif atau default.
  const writeBookId = activeBookId || defaultBookId
  const mounted = useRef(true)
  const financialReadEpoch = useRef(0)
  const [invoiceRevision, setInvoiceRevision] = useState(0)
  const invoiceSessionCurrent = () => mounted.current && secureAuthEnabled
    && !!verifiedSession?.user?.authUserId && verifiedSession?.isCurrent?.() === true
  const invoiceBook = useRef({ id: activeBookId, generation: 0 })
  if (invoiceBook.current.id !== activeBookId) invoiceBook.current = { id: activeBookId, generation: invoiceBook.current.generation + 1 }
  const bookGeneration = invoiceBook.current.generation
  const [pendingInvoiceChanges, setPendingInvoiceChanges] = useState([])
  const [pendingPayments, setPendingPayments] = useState([])
  const [paymentRefreshPending, setPaymentRefreshPending] = useState(false)
  const paymentRefreshNeeded = useRef(false)
  const secureFifoBlocks = useRef(new Set())
  const paymentClient = useMemo(() => secureAuthEnabled && verifiedSession?.user?.authUserId ? createPaymentClient({
    client: supabase, scope: import.meta.env.VITE_SUPABASE_URL || '', actorId: verifiedSession.user.authUserId,
    isCurrent: () => invoiceSessionCurrent() && invoiceBook.current.generation === bookGeneration,
    storage: { get length() { return localStorage.length }, key: index => localStorage.key(index),
      getItem: key => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value), removeItem: key => localStorage.removeItem(key) },
    draftStorage: { getItem: key => sessionStorage.getItem(key), setItem: (key, value) => sessionStorage.setItem(key, value), removeItem: key => sessionStorage.removeItem(key) },
  }) : null, [bookGeneration])
  const refreshPaymentIntents = () => {
    if (!invoiceSessionCurrent()) return
    try { setPendingPayments(paymentClient?.pending() || []) } catch { /* client refuses writes without durable storage */ }
  }
  const settlePaymentRefresh = () => {
    paymentRefreshNeeded.current = false
    setPaymentRefreshPending(false)
    if (paymentClient && paymentClient.pending().length === 0) secureFifoBlocks.current.clear()
  }
  useEffect(() => { refreshPaymentIntents() }, [paymentClient, invoiceRevision])
  const invoiceOperations = useMemo(() => secureAuthEnabled && verifiedSession?.user?.authUserId ? createInvoiceChangeClient({
    client: supabase, scope: import.meta.env.VITE_SUPABASE_URL || '',
    actorId: verifiedSession?.user?.authUserId,
    isCurrent: () => invoiceSessionCurrent() && invoiceBook.current.generation === bookGeneration,
    storage: { get length() { return localStorage.length }, key: index => localStorage.key(index),
      getItem: key => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value), removeItem: key => localStorage.removeItem(key) },
    draftStorage: { getItem: key => sessionStorage.getItem(key), setItem: (key, value) => sessionStorage.setItem(key, value), removeItem: key => sessionStorage.removeItem(key) },
  }) : null, [bookGeneration])
  const refreshInvoiceIntents = () => {
    if (!invoiceSessionCurrent()) return
    try { setPendingInvoiceChanges(invoiceOperations?.pending() || []) } catch { /* writes fail closed if storage is unavailable */ }
  }
  useEffect(() => { refreshInvoiceIntents() }, [invoiceOperations, invoiceRevision])

  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  // ─── refreshAll: initial load + manual refresh ────────────────────
  // CRITICAL: tabel `transactions` punya kolom JSONB `items` yang bisa
  // sangat besar (base64 image per item × ribuan baris). SELECT * tanpa
  // batas memicu "canceling statement due to statement timeout" di
  // Supabase free/pro tier yang punya statement_timeout ~8 detik.
  // Solusi: batasi ke 500 transaksi terakhir + 500 debt terakhir untuk
  // initial paint dashboard. Detail tetap bisa diambil via fetch lazy.
  // HEMAT EGRESS: batasi load awal transaksi (kolom items JSONB berat). Dashboard
  // "Total Omzet (semua waktu)" & Produk Terlaris dihitung dari array ini — untuk
  // angka all-time yang akurat gunakan tab Accounting (berbasis RPC). 200 transaksi
  // terakhir cukup untuk operasional harian. DEBT_LIMIT tetap 500 (baris kecil +
  // Piutang harus lengkap).
  const TRX_LIMIT = 200
  const DEBT_LIMIT = 500
  // Kolom produk ringan (TANPA `image`) untuk query cepat anti-timeout.
  // Tidak menyertakan is_favorite di sini supaya load awal TIDAK gagal bila
  // migrasi belum dijalankan. Favorit di-merge terpisah (resilient) setelahnya.
  const PRODUCT_LIGHT_COLS = secureAuthEnabled ? PRODUCT_PUBLIC_COLUMNS : 'id,name,category,price,modal,stock,unit,description,created_at'
  // Ambil flag favorit terpisah & gabungkan ke state produk. Aman bila kolom
  // is_favorite belum ada (error diabaikan).
  const mergeFavorites = useCallback(async () => {
    try {
      const { data, error } = await supabase.from('products').select('id,is_favorite').limit(5000)
      if (error || !Array.isArray(data)) return
      const fav = new Map(data.map(r => [r.id, !!r.is_favorite]))
      if (mounted.current) setProducts(prev => prev.map(p => fav.has(p.id) ? { ...p, isFavorite: fav.get(p.id) } : p))
    } catch { /* kolom belum ada → abaikan */ }
  }, [])

  // Ambil gambar produk di latar belakang & gabungkan ke state.
  // Best-effort: kalau gagal/timeout, gambar tetap pakai fallback.
  const hydrateProductImages = useCallback(async () => {
    try {
      const { data, error: e } = await supabase
        .from('products').select('id,image')
        .order('created_at', { ascending: false }).limit(500)
      if (e || !data || !mounted.current) return
      const map = new Map(data.map(r => [r.id, r.image || '']))
      setProducts(prev => prev.map(x => (map.has(x.id) ? { ...x, image: map.get(x.id) } : x)))
    } catch { /* abaikan — biarkan gambar fallback */ }
  }, [])

  const refreshAll = useCallback(async () => {
    if (secureAuthEnabled && (!invoiceSessionCurrent() || invoiceBook.current.generation !== bookGeneration)) return
    const issued = financialReadEpoch.current
    setLoading(true); setError(null)
    try {
      const [s, a, p, t, c, d, dp] = await Promise.all([
        supabase.from('settings').select('*').eq('id', 1).maybeSingle(),
        supabase.from('admins').select(ADMIN_PROFILE_COLUMNS).order('created_at', { ascending: true }),
        // PENTING: jangan ambil kolom `image` di sini. Gambar produk lama
        // tersimpan sebagai base64 besar (bisa MB), dan SELECT * tanpa batas
        // bikin statement timeout saat boot. Kolom ringan dulu → app cepat
        // hidup, gambar di-hydrate di latar belakang (lihat bawah).
        supabase.from('products').select(PRODUCT_LIGHT_COLS).order('created_at', { ascending: false }).limit(500),
        // Limit transactions + debts agar query selalu cepat. Difilter book aktif.
        applyBook(supabase.from('transactions').select('*').is('deleted_at', null).order('created_at', { ascending: false }).limit(TRX_LIMIT)),
        applyBook(supabase.from('customers').select('*').order('created_at', { ascending: false })),
        applyBook(supabase.from('debts').select('*').is('deleted_at', null).order('created_at', { ascending: false }).limit(DEBT_LIMIT)),
        // Uang masuk (cicilan) — untuk dashboard owner "Total Uang Masuk".
        applyBook(supabase.from('debt_payments').select('id, debt_id, invoice_no, amount, payment_method, paid_at, cashier_id, deleted_at').is('deleted_at', null).order('paid_at', { ascending: false }).limit(2000)),
      ])
      // Daftar book (defensif: jika tabel belum ada / migrasi belum jalan, abaikan).
      try {
        const bk = await supabase.from('books').select('*').is('deleted_at', null).order('created_at', { ascending: true })
        if (!bk.error && mounted.current) setBooks(bk.data || [])
      } catch { /* tabel books belum ada — fitur Book nonaktif sampai migrasi dijalankan */ }
      // Rekening bank per admin (defensif: tabel mungkin belum ada).
      try {
        const ba = await supabase.from('admin_bank_accounts').select('*').is('deleted_at', null).order('created_at', { ascending: true })
        if (!ba.error && mounted.current) setAdminBankAccounts(ba.data || [])
      } catch { /* tabel admin_bank_accounts belum ada — fitur rekening nonaktif sampai migrasi */ }
      // Master data invoice (defensif: tabel mungkin belum ada).
      try {
        const [loc, con, sba, aip] = await Promise.all([
          supabase.from('store_locations').select('*').is('deleted_at', null).order('created_at', { ascending: true }),
          supabase.from('store_contacts').select('*').is('deleted_at', null).order('created_at', { ascending: true }),
          supabase.from('store_bank_accounts').select('*').is('deleted_at', null).order('created_at', { ascending: true }),
          supabase.from('admin_invoice_profiles').select('*').is('deleted_at', null),
        ])
        if (mounted.current) {
          if (!loc.error) setStoreLocations(loc.data || [])
          if (!con.error) setStoreContacts(con.data || [])
          if (!sba.error) setStoreBankAccounts(sba.data || [])
          if (!aip.error) setAdminInvoiceProfiles(aip.data || [])
        }
      } catch { /* tabel master data belum ada — fitur nonaktif sampai migrasi */ }
      // Pemasukkan Credibook (book-scoped) — masuk Omset di dashboard. Defensif.
      try {
        const cb = await applyBook(supabase.from('credibook_income')
          .select('id, name, transaction_date, amount, payment_method, note, income_type, book_id')
          .is('deleted_at', null).order('transaction_date', { ascending: false }).limit(2000))
        if (!cb.error && mounted.current) setCredibookIncome(cb.data || [])
      } catch { /* tabel credibook_income belum ada — abaikan */ }
      for (const r of [s, a, p, t, c, d, ...(secureAuthEnabled ? [dp] : [])]) if (r.error) throw r.error
      if (secureAuthEnabled && [t, c, d, dp].some(r => !Array.isArray(r.data))) throw new Error('Data keuangan belum lengkap')
      const productRows = secureAuthEnabled
        ? await attachProductCosts(supabase, p.data || [], currentUser?.role)
        : p.data || []
      if (!mounted.current || issued !== financialReadEpoch.current) return
      setStoreInfo(settingsFromDB(s.data) || {
        name: 'Skupy Printing', tagline: '', address: '', phone: '', email: '',
        bank: { name: '', number: '', holder: '' },
        frontLogo: '', invoiceLogo: '', taxRate: 0,
      })
      const allAdmins = (a.data || []).map(adminFromDB)
      setAdmins(allAdmins)
      // Validate restored session: if user no longer exists, clear it
      const restored = secureAuthEnabled ? null : loadSession()
      if (restored?.id && !allAdmins.find(x => x.id === restored.id)) {
        clearSession()
        if (mounted.current) setCurrentUser(null)
      }
      setProducts(productRows.map(productFromDB))
      mergeFavorites()  // gabungkan flag favorit (resilient, non-blocking)
      // Hydrate gambar di latar belakang — tidak memblok tampilan awal.
      hydrateProductImages()
      const trxList = (t.data || []).map(trxFromDB)
      setTransactions(trxList)
      setCustomers((c.data || []).map(customerFromDB).filter(x => !x.deletedAt))
      setDebts((d.data || []).map(debtFromDB))
      // debt_payments dipakai dashboard owner; kalau query gagal, biarkan kosong.
      if (!dp.error) setDebtPayments(dp.data || [])
      if (secureAuthEnabled) settlePaymentRefresh()

      // NOTE: Legacy "auto-fix stale=lunas" sync DIHAPUS karena bisa
      // mem-issue UPDATE bulk ke ratusan baris saat startup → potensi
      // statement timeout. Sinkronisasi sekarang dikerjakan oleh
      // syncDebtPaymentStatus per invoice saat aksi user terjadi.
    } catch (e) {
      if (mounted.current && issued === financialReadEpoch.current) setError(
        isSupabaseConfigured
          ? `Gagal terhubung ke Supabase: ${e.message || e}`
          : 'Supabase belum dikonfigurasi. Buat file .env dari .env.example.'
      )
    } finally {
      if (mounted.current && issued === financialReadEpoch.current) setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookGeneration])

  useEffect(() => { refreshAll() }, [refreshAll])

  // Saat pindah book → muat ulang data penjualan (skip render awal).
  const bookInit = useRef(true)
  useEffect(() => {
    if (bookInit.current) { bookInit.current = false; return }
    refreshTransactions(); refreshCustomers(); refreshDebts(); refreshDebtPayments(); refreshCredibook()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeBookId])

  // Ganti book aktif (null = Semua Book). Persist pilihan.
  const setActiveBook = useCallback((id) => {
    financialReadEpoch.current++
    invoiceBook.current = { id: id || null, generation: invoiceBook.current.generation + 1 }
    if (!secureAuthEnabled) {
      try { if (id) localStorage.setItem('skupy_active_book', id); else localStorage.removeItem('skupy_active_book') } catch { /* ignore */ }
    }
    setActiveBookId(id || null)
  }, [])

  // Tambah book baru (brand). Owner only (enforce di UI).
  const addBook = useCallback(async (data) => {
    const name = (data.name || '').trim()
    if (!name) return { ok: false, error: 'Nama book wajib diisi' }
    const { data: row, error: e } = await supabase.from('books').insert({
      name, brand_name: (data.brandName || name).trim(), prefix: (data.prefix || '').trim().toUpperCase() || null,
      logo_url: data.logoUrl || null, description: data.description || '', is_active: data.isActive !== false, is_default: false,
    }).select('*').single()
    if (e) return { ok: false, error: e.message }
    if (mounted.current) setBooks(prev => [...prev, row])
    return { ok: true, data: row }
  }, [])
  const updateBook = useCallback(async (id, data) => {
    const patch = { updated_at: new Date().toISOString() }
    if (data.name !== undefined) patch.name = data.name
    if (data.brandName !== undefined) patch.brand_name = data.brandName
    if (data.prefix !== undefined) patch.prefix = (data.prefix || '').trim().toUpperCase() || null
    if (data.logoUrl !== undefined) patch.logo_url = data.logoUrl || null
    if (data.description !== undefined) patch.description = data.description
    if (data.isActive !== undefined) patch.is_active = data.isActive
    const { data: row, error: e } = await supabase.from('books').update(patch).eq('id', id).select('*').single()
    if (e) return { ok: false, error: e.message }
    if (mounted.current) setBooks(prev => prev.map(b => b.id === id ? row : b))
    return { ok: true }
  }, [])

  // (Rekening bank per admin dipindah ke bawah — setelah `wrap` dideklarasikan,
  //  agar tidak TDZ "Cannot access 'wrap' before initialization".)

  // Refresher helpers — semua dibatasi LIMIT supaya tidak pernah timeout.
  const refreshCustomers = useCallback(async () => {
    const issued = financialReadEpoch.current
    const { data, error: e } = await applyBook(supabase
      .from('customers').select('*')
      .order('created_at', { ascending: false })
      .limit(1000))
    if (!e && mounted.current && issued === financialReadEpoch.current) setCustomers((data || []).map(customerFromDB).filter(x => !x.deletedAt))
  }, [activeBookId])

  const refreshDebtPayments = useCallback(async () => {
    const issued = financialReadEpoch.current
    const { data, error: e } = await applyBook(supabase
      .from('debt_payments')
      .select('id, debt_id, invoice_no, amount, payment_method, paid_at, cashier_id, deleted_at')
      .is('deleted_at', null)
      .order('paid_at', { ascending: false })
      .limit(2000))
    if (!e && mounted.current && issued === financialReadEpoch.current) setDebtPayments(data || [])
  }, [activeBookId])

  const refreshDebts = useCallback(async () => {
    const issued = financialReadEpoch.current
    const { data, error: e } = await applyBook(supabase
      .from('debts').select('*')
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(500))
    if (!e && mounted.current && issued === financialReadEpoch.current) setDebts((data || []).map(debtFromDB))
  }, [activeBookId])

  const refreshTransactions = useCallback(async () => {
    const issued = financialReadEpoch.current
    const { data, error: e } = await applyBook(supabase
      .from('transactions').select('*')
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(500))
    if (!e && mounted.current && issued === financialReadEpoch.current) setTransactions((data || []).map(trxFromDB))
  }, [activeBookId])

  const invoiceWorkflow = useMemo(() => createInvoiceWorkflow({
    enabled: secureAuthEnabled && !!verifiedSession?.user?.authUserId,
    isCurrent: () => invoiceSessionCurrent() && invoiceBook.current.generation === bookGeneration,
    operations: invoiceOperations,
    onSettled: refreshInvoiceIntents,
    readInvoice: async id => {
      const result = await applyBook(supabase.from('transactions').select('*').eq('id', id).is('deleted_at', null)).maybeSingle()
      if (result.error) throw result.error
      return result.data ? trxFromDB(result.data) : null
    },
    invalidate: () => { financialReadEpoch.current++; setInvoiceRevision(value => value + 1) },
    refresh: async () => {
      const issued = financialReadEpoch.current
      // Publish the related collections together, only after every read succeeds.
      const results = await Promise.all([
        applyBook(supabase.from('transactions').select('*').is('deleted_at', null).order('created_at', { ascending: false }).limit(500)),
        applyBook(supabase.from('debts').select('*').is('deleted_at', null).order('created_at', { ascending: false }).limit(500)),
        applyBook(supabase.from('customers').select('*').order('created_at', { ascending: false }).limit(1000)),
        applyBook(supabase.from('debt_payments').select('id, debt_id, invoice_no, amount, payment_method, paid_at, cashier_id, deleted_at').is('deleted_at', null).order('paid_at', { ascending: false }).limit(2000)),
      ])
      if (!invoiceSessionCurrent() || invoiceBook.current.generation !== bookGeneration || issued !== financialReadEpoch.current || results.some(result => result.error || !Array.isArray(result.data))) {
        if (invoiceSessionCurrent() && invoiceBook.current.generation === bookGeneration && issued === financialReadEpoch.current) setError('Perubahan invoice sudah tersimpan, tetapi data terbaru belum dapat dimuat. Muat ulang sebelum melanjutkan.')
        throw new Error('Invoice refresh incomplete')
      }
      setTransactions(results[0].data.map(trxFromDB))
      setDebts(results[1].data.map(debtFromDB))
      setCustomers(results[2].data.map(customerFromDB).filter(row => !row.deletedAt))
      setDebtPayments(results[3].data)
    },
  }), [activeBookId, invoiceOperations])

  const paymentWorkflow = useMemo(() => {
    const available = () => paymentClient && invoiceSessionCurrent() && invoiceBook.current.generation === bookGeneration
    const unavailable = () => ({ ok: false, error: 'Pembayaran terverifikasi belum tersedia pada sesi ini.' })
    const refreshRequired = data => ({ ok: false, committed: true, needsRefresh: true, data,
      error: 'Pembayaran sudah tersimpan. Muat ulang data sebelum mencatat pembayaran berikutnya.' })
    const finish = async result => {
      if (!available()) return { ok: false, needsReconciliation: true, error: 'Sesi berubah. Periksa status dengan akun semula.' }
      refreshPaymentIntents()
      if (!result.ok) return result
      financialReadEpoch.current++
      setInvoiceRevision(value => value + 1)
      const data = { ...result.data, paidAfter: result.data.paid, remainingAfter: result.data.remaining,
        paidBefore: result.data.paid - result.data.amount, remainingBefore: result.data.remaining + result.data.amount,
        status: result.data.remaining === 0 ? 'lunas' : 'pending' }
      paymentRefreshNeeded.current = true
      setPaymentRefreshPending(true)
      const refreshed = await invoiceWorkflow.refresh()
      if (!refreshed.ok || !available()) return refreshRequired(data)
      settlePaymentRefresh()
      return { ok: true, data }
    }
    return {
      pending: () => available() ? paymentClient.pending() : [],
      submit: async request => !available() ? unavailable() : paymentRefreshNeeded.current ? refreshRequired()
        : finish(await paymentClient.submit(request)),
      reconcile: async invoiceNo => !available() ? unavailable() : finish(await paymentClient.reconcile(invoiceNo)),
      resume: async invoiceNo => !available() ? unavailable() : finish(await paymentClient.resume(invoiceNo)),
      refresh: async () => {
        if (!available()) return unavailable()
        const result = await invoiceWorkflow.refresh()
        if (result.ok && available()) { settlePaymentRefresh(); setError(null); setInvoiceRevision(value => value + 1) }
        return result
      },
    }
  }, [invoiceWorkflow, paymentClient])

  // Cari 1 transaksi by invoiceNo untuk PREVIEW invoice (klik nomor invoice di
  // mana pun). Cari di state dulu; kalau tidak ada (mis. transaksi lama di luar
  // limit), fetch 1 baris dari Supabase. Tidak membuat data baru — hanya baca.
  const getTransactionByInvoice = useCallback(async (invoiceNo) => {
    if (!invoiceNo) return null
    const local = transactions.find(t => t.invoiceNo === invoiceNo)
    if (local) return local
    try {
      const { data } = await supabase.from('transactions').select('*').eq('invoice_no', invoiceNo).is('deleted_at', null).maybeSingle()
      return data ? trxFromDB(data) : null
    } catch { return null }
  }, [transactions])

  // Pemasukkan Credibook — book-scoped. Defensif: jika tabel belum ada, kosongkan.
  const refreshCredibook = useCallback(async () => {
    try {
      const { data, error: e } = await applyBook(supabase
        .from('credibook_income')
        .select('id, name, transaction_date, amount, payment_method, note, income_type, book_id')
        .is('deleted_at', null)
        .order('transaction_date', { ascending: false })
        .limit(2000))
      if (!e && mounted.current) setCredibookIncome(data || [])
    } catch { /* tabel credibook_income belum ada — abaikan */ }
  }, [activeBookId])

  // Recompute denormalized customer summary (dipakai banyak fungsi).
  // PENTING: dideklarasikan AWAL agar tersedia di dependency array fungsi-fungsi
  // yang memakainya (hindari TDZ "Cannot access ... before initialization").
  const recalculateCustomerSummary = useCallback(async (customerId, { validateOnly = false } = {}) => {
    // Candidate 006 maintains these derived fields inside the database transaction.
    if (secureAuthEnabled || !customerId) return { ok: true }
    let writeAttempted = false
    try {
      const [trxRes, debtRes] = await Promise.all([
        supabase.from('transactions')
          .select('id, invoice_no, total, remaining, status, order_status, deleted_at')
          .eq('customer_id', customerId),
        supabase.from('debts')
          .select('transaction_id, invoice_no, remaining, status, deleted_at')
          .eq('customer_id', customerId)
          .is('deleted_at', null)
          .eq('status', 'aktif'),
      ])
      if (trxRes.error || debtRes.error || !Array.isArray(trxRes.data) || !Array.isArray(debtRes.data)) {
        return { ok: false, error: 'Ringkasan customer belum dapat dihitung karena data transaksi/piutang belum tersedia.' }
      }
      const trxs = trxRes.data.filter(t => !inactiveFinancialInvoice(t))
      const activeDebts = debtRes.data.filter(d => !d.deleted_at)
      const inactive = trxRes.data.filter(inactiveFinancialInvoice)
      if (activeDebts.some(d => paymentMoney(d.remaining) > 0 && inactive.some(t =>
        (d.transaction_id && d.transaction_id === t.id) || (d.invoice_no && d.invoice_no === t.invoice_no)))) {
        return { ok: false, needsReview: true, error: 'Piutang aktif terkait invoice batal/terhapus masih memiliki saldo. Ringkasan belum diubah; perlu pemeriksaan owner.' }
      }
      const totalTransactions = trxs.length
      const totalSpent = trxs.reduce((s, t) => s + paymentMoney(t.total), 0)
      const totalDebt = activeDebts.reduce((s, d) => s + paymentMoney(d.remaining), 0)
      // Reuse the same checks before any financial mutation; no summary write.
      if (validateOnly) return { ok: true }
      writeAttempted = true
      const result = await supabase
        .from('customers')
        .update({
          total_transactions: totalTransactions,
          total_spent: totalSpent,
          total_debt: totalDebt,
        }, { count: 'exact' })
        .eq('id', customerId)
        .select('id').single()
      if (!confirmedWrite(result, customerId)) return incompleteTransactionSync()
      return { ok: true }
    } catch (err) {
      return writeAttempted ? incompleteTransactionSync() : { ok: false, error: 'Ringkasan customer belum dapat diperiksa. Coba muat ulang data.' }
    }
  }, [])

  // ─── Realtime subscriptions ───────────────────────────────────────
  // Satu channel, satu subscription. Setiap perubahan dipush ke handler
  // yang DI-DEBOUNCE: kalau payDebt mengupdate 4 tabel dalam 100ms, kita
  // hanya issue 1 batch refresh setelah 500ms idle — bukan 4 round-trip
  // berturut-turut yang bisa memicu statement timeout cascade.
  useEffect(() => {
    if (!isSupabaseConfigured) return

    // Debounce: queue tabel mana yang perlu di-refresh, fire sekali.
    const queue = new Set()
    let timer = null
    const flush = () => {
      timer = null
      const tables = [...queue]
      queue.clear()
      if (tables.includes('transactions')) refreshTransactions()
      if (tables.includes('debts'))         refreshDebts()
      if (tables.includes('customers'))     refreshCustomers()
      if (tables.includes('debt_payments')) refreshDebtPayments()
      if (tables.includes('credibook_income')) refreshCredibook()
    }
    const schedule = (...names) => {
      names.forEach(n => queue.add(n))
      if (timer) clearTimeout(timer)
      timer = setTimeout(flush, 500)  // 500ms debounce window
    }

    // Realtime data kasir/order/piutang. HEMAT EGRESS:
    //  • Tabel `products` DIKELUARKAN dari realtime (jarang berubah; disegarkan saat
    //    edit produk / refresh manual) → mengurangi broadcast.
    //  • Channel DIPUTUS saat tab disembunyikan (background) & disambung lagi saat
    //    tab aktif, dengan satu refresh susulan agar perubahan tak terlewat.
    //  • Tabel accounting disegarkan oleh poll/subscription di halaman Accounting.
    let channel = null
    const buildChannel = () => supabase.channel('skupy-pos-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'transactions' },
        () => schedule('transactions'))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'debts' },
        () => schedule('debts'))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'debt_payments' },
        () => schedule('debts', 'transactions', 'debt_payments'))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'credibook_income' },
        () => schedule('credibook_income'))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'customers' },
        () => schedule('customers'))
      .subscribe()
    const start = (catchUp) => {
      if (channel) return
      channel = buildChannel()
      // Saat kembali aktif, tarik sekali agar sinkron dengan perubahan selama background.
      if (catchUp) schedule('transactions', 'debts', 'debt_payments', 'customers', 'credibook_income')
    }
    const stop = () => { if (channel) { supabase.removeChannel(channel); channel = null } }
    const onVis = () => { if (document.visibilityState === 'visible') start(true); else stop() }

    if (document.visibilityState === 'visible') start(false)
    document.addEventListener('visibilitychange', onVis)

    return () => {
      if (timer) clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVis)
      stop()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const wrap = useCallback(async (fn) => {
    setBusy(true)
    try { return await fn() }
    finally { if (mounted.current) setBusy(false) }
  }, [])

  // Bounded, in-session containment only: not a server lock or a durable receipt.
  const paymentOperations = useRef({ pending: new Set(), blocked: new Set() })
  const containPayment = useCallback(async (keys, run) => {
    const state = paymentOperations.current
    const held = new Set()
    let dispatched = false
    const guard = (more) => {
      for (const key of more.filter(Boolean)) {
        if (state.blocked.has(key)) throw Object.assign(new Error(incompleteTransactionSync().error), { needsReconciliation: true })
        if (state.pending.has(key) && !held.has(key)) throw new Error('Pembayaran sedang diproses. Tunggu hasilnya.')
      }
      for (const key of more.filter(Boolean)) { held.add(key); state.pending.add(key) }
    }
    try {
      guard(keys)
      const result = await run({ guard, write: async (query, expectedId = null, schemaFallback) => {
        dispatched = true
        let response = await query
        // PGRST204 names an unknown column: PostgREST rejected the request before
        // executing SQL. Only this definitive rejection permits a legacy retry.
        if (schemaFallback && response?.error?.code === 'PGRST204'
          && response.error.message?.includes("'invoice_no'")) response = await schemaFallback()
        if (!confirmedWrite(response, expectedId)) throw new Error('Penyimpanan pembayaran belum terkonfirmasi')
        return response.data
      } })
      if (result?.needsReconciliation) held.forEach(key => state.blocked.add(key))
      return result
    } catch (error) {
      if (dispatched || error.needsReconciliation) {
        if (dispatched) held.forEach(key => state.blocked.add(key))
        return incompleteTransactionSync()
      }
      return { ok: false, needsReconciliation: false, ...(error.needsReview ? { needsReview: true } : {}), error: error.message || 'Data pembayaran belum dapat diperiksa' }
    } finally {
      held.forEach(key => state.pending.delete(key))
    }
  }, [])

  // ── REKENING BANK PER ADMIN (owner only) — SETELAH `wrap` agar tidak TDZ ──
  const refreshBankAccounts = useCallback(async () => {
    try {
      const { data, error } = await supabase.from('admin_bank_accounts').select('*').is('deleted_at', null).order('created_at', { ascending: true })
      if (!error && mounted.current) setAdminBankAccounts(data || [])
    } catch { /* tabel belum ada */ }
  }, [])
  // Rekening default aktif untuk admin tertentu (untuk snapshot invoice).
  const bankAccountForAdmin = useCallback((adminId) => {
    if (!adminId) return null
    const list = adminBankAccounts.filter(b => b.admin_id === adminId && b.is_active !== false && !b.deleted_at)
    return list.find(b => b.is_default) || list[0] || null
  }, [adminBankAccounts])
  const addBankAccount = useCallback(async (data) => wrap(async () => {
    if (!data.adminId) return { ok: false, error: 'Pilih admin dulu' }
    if (!(data.bankName || '').trim()) return { ok: false, error: 'Nama bank wajib diisi' }
    if (!(data.accountNumber || '').trim()) return { ok: false, error: 'Nomor rekening wajib diisi' }
    if (!(data.accountHolder || '').trim()) return { ok: false, error: 'Atas nama wajib diisi' }
    const makeDefault = !!data.isDefault
    // Jika dijadikan default → matikan default lama admin ini dulu (rule #3).
    if (makeDefault) await supabase.from('admin_bank_accounts').update({ is_default: false }).eq('admin_id', data.adminId).is('deleted_at', null)
    const payload = {
      admin_id: data.adminId, bank_name: data.bankName.trim(), account_number: data.accountNumber.trim(),
      account_holder: data.accountHolder.trim(), branch: (data.branch || '').trim() || null, note: (data.note || '').trim() || null,
      is_active: data.isActive !== false, is_default: makeDefault,
    }
    const { data: row, error: e } = await supabase.from('admin_bank_accounts').insert(payload).select('*').single()
    if (e) return { ok: false, error: e.message }
    await refreshBankAccounts()
    return { ok: true, data: row }
  }), [wrap, refreshBankAccounts])
  const updateBankAccount = useCallback(async (id, data) => wrap(async () => {
    const cur = adminBankAccounts.find(b => b.id === id)
    const adminId = data.adminId || cur?.admin_id
    const makeDefault = !!data.isDefault
    if (makeDefault && adminId) await supabase.from('admin_bank_accounts').update({ is_default: false }).eq('admin_id', adminId).is('deleted_at', null).neq('id', id)
    const patch = { updated_at: new Date().toISOString() }
    if (data.adminId !== undefined) patch.admin_id = data.adminId
    if (data.bankName !== undefined) patch.bank_name = data.bankName.trim()
    if (data.accountNumber !== undefined) patch.account_number = data.accountNumber.trim()
    if (data.accountHolder !== undefined) patch.account_holder = data.accountHolder.trim()
    if (data.branch !== undefined) patch.branch = (data.branch || '').trim() || null
    if (data.note !== undefined) patch.note = (data.note || '').trim() || null
    if (data.isActive !== undefined) patch.is_active = data.isActive
    if (data.isDefault !== undefined) patch.is_default = makeDefault
    const { error: e } = await supabase.from('admin_bank_accounts').update(patch).eq('id', id)
    if (e) return { ok: false, error: e.message }
    await refreshBankAccounts()
    return { ok: true }
  }), [wrap, adminBankAccounts, refreshBankAccounts])
  const deleteBankAccount = useCallback(async (id) => wrap(async () => {
    const { error: e } = await supabase.from('admin_bank_accounts').update({ deleted_at: new Date().toISOString(), is_default: false }).eq('id', id)
    if (e) return { ok: false, error: e.message }
    await refreshBankAccounts()
    return { ok: true }
  }), [wrap, refreshBankAccounts])

  // ── MASTER DATA INVOICE (owner): alamat / kontak / rekening + profil admin ──
  const refreshMasterData = useCallback(async () => {
    try {
      const [loc, con, sba, aip] = await Promise.all([
        supabase.from('store_locations').select('*').is('deleted_at', null).order('created_at', { ascending: true }),
        supabase.from('store_contacts').select('*').is('deleted_at', null).order('created_at', { ascending: true }),
        supabase.from('store_bank_accounts').select('*').is('deleted_at', null).order('created_at', { ascending: true }),
        supabase.from('admin_invoice_profiles').select('*').is('deleted_at', null),
      ])
      if (!mounted.current) return
      if (!loc.error) setStoreLocations(loc.data || [])
      if (!con.error) setStoreContacts(con.data || [])
      if (!sba.error) setStoreBankAccounts(sba.data || [])
      if (!aip.error) setAdminInvoiceProfiles(aip.data || [])
    } catch { /* tabel belum ada */ }
  }, [])

  // Generic CRUD master (table, state setter). Soft delete.
  const _masterAdd = (table) => async (payload) => wrap(async () => {
    const { data: row, error: e } = await supabase.from(table).insert(payload).select('*').single()
    if (e) return { ok: false, error: e.message }
    await refreshMasterData()
    return { ok: true, data: row }
  })
  const _masterUpdate = (table) => async (id, patch) => wrap(async () => {
    const { error: e } = await supabase.from(table).update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id)
    if (e) return { ok: false, error: e.message }
    await refreshMasterData()
    return { ok: true }
  })
  const _masterDelete = (table) => async (id) => wrap(async () => {
    const { error: e } = await supabase.from(table).update({ deleted_at: new Date().toISOString() }).eq('id', id)
    if (e) return { ok: false, error: e.message }
    await refreshMasterData()
    return { ok: true }
  })

  const addLocation = useCallback(async (d) => {
    if (!(d.locationName || '').trim()) return { ok: false, error: 'Nama lokasi wajib diisi' }
    if (!(d.address || '').trim()) return { ok: false, error: 'Alamat wajib diisi' }
    return _masterAdd('store_locations')({ location_name: d.locationName.trim(), store_name: (d.storeName || '').trim() || null, address: d.address.trim(), city: (d.city || '').trim() || null, note: (d.note || '').trim() || null, is_active: d.isActive !== false })
  }, [wrap, refreshMasterData])
  const updateLocation = useCallback(async (id, d) => {
    const patch = {}
    if (d.locationName !== undefined) patch.location_name = d.locationName.trim()
    if (d.storeName !== undefined) patch.store_name = (d.storeName || '').trim() || null
    if (d.address !== undefined) patch.address = d.address.trim()
    if (d.city !== undefined) patch.city = (d.city || '').trim() || null
    if (d.note !== undefined) patch.note = (d.note || '').trim() || null
    if (d.isActive !== undefined) patch.is_active = d.isActive
    return _masterUpdate('store_locations')(id, patch)
  }, [wrap, refreshMasterData])
  const deleteLocation = useCallback(async (id) => _masterDelete('store_locations')(id), [wrap, refreshMasterData])

  const addContact = useCallback(async (d) => {
    if (!(d.contactName || '').trim()) return { ok: false, error: 'Nama kontak wajib diisi' }
    return _masterAdd('store_contacts')({ contact_name: d.contactName.trim(), phone: (d.phone || '').trim() || null, whatsapp: (d.whatsapp || '').trim() || null, note: (d.note || '').trim() || null, is_active: d.isActive !== false })
  }, [wrap, refreshMasterData])
  const updateContact = useCallback(async (id, d) => {
    const patch = {}
    if (d.contactName !== undefined) patch.contact_name = d.contactName.trim()
    if (d.phone !== undefined) patch.phone = (d.phone || '').trim() || null
    if (d.whatsapp !== undefined) patch.whatsapp = (d.whatsapp || '').trim() || null
    if (d.note !== undefined) patch.note = (d.note || '').trim() || null
    if (d.isActive !== undefined) patch.is_active = d.isActive
    return _masterUpdate('store_contacts')(id, patch)
  }, [wrap, refreshMasterData])
  const deleteContact = useCallback(async (id) => _masterDelete('store_contacts')(id), [wrap, refreshMasterData])

  const addStoreBank = useCallback(async (d) => {
    if (!(d.bankName || '').trim()) return { ok: false, error: 'Nama bank wajib diisi' }
    if (!(d.accountNumber || '').trim()) return { ok: false, error: 'Nomor rekening wajib diisi' }
    if (!(d.accountHolder || '').trim()) return { ok: false, error: 'Atas nama wajib diisi' }
    return _masterAdd('store_bank_accounts')({ bank_name: d.bankName.trim(), account_number: d.accountNumber.trim(), account_holder: d.accountHolder.trim(), note: (d.note || '').trim() || null, is_active: d.isActive !== false })
  }, [wrap, refreshMasterData])
  const updateStoreBank = useCallback(async (id, d) => {
    const patch = {}
    if (d.bankName !== undefined) patch.bank_name = d.bankName.trim()
    if (d.accountNumber !== undefined) patch.account_number = d.accountNumber.trim()
    if (d.accountHolder !== undefined) patch.account_holder = d.accountHolder.trim()
    if (d.note !== undefined) patch.note = (d.note || '').trim() || null
    if (d.isActive !== undefined) patch.is_active = d.isActive
    return _masterUpdate('store_bank_accounts')(id, patch)
  }, [wrap, refreshMasterData])
  const deleteStoreBank = useCallback(async (id) => _masterDelete('store_bank_accounts')(id), [wrap, refreshMasterData])

  // Set / upsert profil invoice admin (1 aktif per admin).
  const setAdminInvoiceProfile = useCallback(async (adminId, d) => wrap(async () => {
    if (!adminId) return { ok: false, error: 'Pilih admin dulu' }
    const existing = adminInvoiceProfiles.find(p => p.admin_id === adminId && !p.deleted_at)
    const body = { admin_id: adminId, location_id: d.locationId || null, contact_id: d.contactId || null, bank_account_id: d.bankAccountId || null, is_active: true, updated_at: new Date().toISOString() }
    let e
    if (existing) ({ error: e } = await supabase.from('admin_invoice_profiles').update(body).eq('id', existing.id))
    else ({ error: e } = await supabase.from('admin_invoice_profiles').insert(body))
    if (e) return { ok: false, error: e.message }
    await refreshMasterData()
    return { ok: true }
  }), [wrap, adminInvoiceProfiles, refreshMasterData])

  // Resolusi data invoice untuk admin (location/contact/bank dari master).
  const invoiceProfileForAdmin = useCallback((adminId) => {
    const prof = adminInvoiceProfiles.find(p => p.admin_id === adminId && !p.deleted_at)
    if (!prof) return null
    const location = storeLocations.find(l => l.id === prof.location_id && !l.deleted_at) || null
    const contact = storeContacts.find(c => c.id === prof.contact_id && !c.deleted_at) || null
    const bank = storeBankAccounts.find(b => b.id === prof.bank_account_id && !b.deleted_at) || null
    return { profile: prof, location, contact, bank }
  }, [adminInvoiceProfiles, storeLocations, storeContacts, storeBankAccounts])

  // ---------- AUTH ----------
  const login = useCallback(async (username, password, remember = false) => wrap(async () => {
    if (secureAuthEnabled) return { ok: false, error: 'Gunakan layar login utama.' }
    const u = (username || '').trim().toLowerCase()
    if (!u || !password) return { ok: false, error: 'Username & password wajib diisi' }
    const { data, error: e } = await supabase
      .from('admins').select(ADMIN_PROFILE_COLUMNS).eq('username', u).eq('password', password).maybeSingle()
    if (e) return { ok: false, error: e.message }
    if (!data) return { ok: false, error: 'Username atau password salah' }
    const user = { id: data.id, username: data.username, name: data.name || data.username, role: data.role, login_time: Date.now() }
    setCurrentUser(user)
    saveSession(user, remember)   // remember=true → localStorage 30 hari; false → sessionStorage
    return { ok: true }
  }), [wrap])

  const logout = useCallback(() => {
    if (secureAuthEnabled) { void verifiedSession?.logout(); return }
    setCurrentUser(null)
    clearSession()
  }, [])

  // ---------- SETTINGS ----------
  const updateStoreInfo = useCallback(async (partial) => wrap(async () => {
    const next = { ...storeInfo, ...partial }
    const { error: e } = await supabase.from('settings').upsert({ id: 1, ...settingsToDB(next) })
    if (e) return { ok: false, error: e.message }
    if (mounted.current) setStoreInfo(next)
    return { ok: true }
  }), [storeInfo, wrap])

  const updateLogo = useCallback(async (logoType, fileOrEmpty) => wrap(async () => {
    try {
      if (!fileOrEmpty) {
        const oldUrl = storeInfo?.[logoType]
        const next = { ...storeInfo, [logoType]: '' }
        const { error: e } = await supabase.from('settings').upsert({ id: 1, ...settingsToDB(next) })
        if (e) return { ok: false, error: e.message }
        if (oldUrl) { try { await deleteLogo(oldUrl, supabase) } catch {} }
        if (mounted.current) setStoreInfo(next)
        return { ok: true }
      }
      const url = await uploadLogo(fileOrEmpty, logoType, supabase)
      const next = { ...storeInfo, [logoType]: url }
      const { error: e } = await supabase.from('settings').upsert({ id: 1, ...settingsToDB(next) })
      if (e) return { ok: false, error: e.message }
      if (mounted.current) setStoreInfo(next)
      return { ok: true }
    } catch (err) { return { ok: false, error: err.message || String(err) } }
  }), [storeInfo, wrap])

  // ---------- ADMINS ----------
  const addAdmin = useCallback(async (data) => wrap(async () => {
    if (secureAuthEnabled) return { ok: false, error: 'Pembuatan akun Auth harus melalui pengelola sistem.' }
    const u = (data.username || '').trim().toLowerCase()
    if (!u) return { ok: false, error: 'Username wajib diisi' }
    if (!data.password || data.password.length < 4) return { ok: false, error: 'Password minimal 4 karakter' }
    const { data: inserted, error: e } = await supabase.from('admins')
      .insert({ username: u, password: data.password, name: data.name || u, role: data.role || 'staff' })
      .select(ADMIN_PROFILE_COLUMNS).single()
    if (e) {
      if (String(e.message).includes('duplicate')) return { ok: false, error: 'Username sudah dipakai' }
      return { ok: false, error: e.message }
    }
    if (mounted.current) setAdmins(prev => [...prev, adminFromDB(inserted)])
    return { ok: true }
  }), [wrap])

  // Edit admin (Owner only): username / nama / role / password (opsional).
  // Guard: tidak boleh menurunkan/menghapus role Owner terakhir. Jika mengedit
  // user yang sedang login, currentUser + session ikut diperbarui.
  const updateAdmin = useCallback(async (id, fields = {}) => wrap(async () => {
    if (secureAuthEnabled) return { ok: false, error: 'Gunakan pengelolaan akun Auth.' }
    if (currentUser?.role !== 'owner') return { ok: false, error: 'Hanya Owner yang bisa mengubah admin' }
    const target = admins.find(a => a.id === id)
    if (!target) return { ok: false, error: 'Admin tidak ditemukan' }

    const patch = {}
    if (fields.username !== undefined) {
      const u = String(fields.username || '').trim().toLowerCase()
      if (!u) return { ok: false, error: 'Username wajib diisi' }
      if (/\s/.test(u)) return { ok: false, error: 'Username tidak boleh mengandung spasi' }
      if (admins.some(a => a.id !== id && (a.username || '').toLowerCase() === u)) return { ok: false, error: 'Username sudah dipakai admin lain' }
      patch.username = u
    }
    if (fields.name !== undefined) {
      const nm = String(fields.name || '').trim()
      if (nm) patch.name = nm
    }
    if (fields.role !== undefined && fields.role !== target.role) {
      const owners = admins.filter(a => a.role === 'owner')
      if (target.role === 'owner' && fields.role !== 'owner' && owners.length <= 1) {
        return { ok: false, error: 'Tidak boleh menurunkan role Owner terakhir' }
      }
      patch.role = fields.role
    }
    if (fields.password) {
      if (String(fields.password).length < 4) return { ok: false, error: 'Password baru minimal 4 karakter' }
      patch.password = String(fields.password)
    }
    if (Object.keys(patch).length === 0) return { ok: true } // tidak ada perubahan

    // coba dengan updated_at; bila kolom belum dimigrasi → ulangi tanpa updated_at
    let { data: updated, error } = await supabase.from('admins').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id).select(ADMIN_PROFILE_COLUMNS).single()
    if (error && /updated_at|column .* does not exist|schema cache/i.test(error.message || '')) {
      ;({ data: updated, error } = await supabase.from('admins').update(patch).eq('id', id).select(ADMIN_PROFILE_COLUMNS).single())
    }
    if (error) {
      if (/duplicate/i.test(error.message)) return { ok: false, error: 'Username sudah dipakai' }
      return { ok: false, error: error.message }
    }
    if (mounted.current) setAdmins(prev => prev.map(a => a.id === id ? adminFromDB(updated) : a))
    // Jika mengedit diri sendiri yang sedang login → segarkan currentUser + session
    if (currentUser?.id === id) {
      const nu = { ...currentUser, username: updated.username, name: updated.name, role: updated.role }
      setCurrentUser(nu)
      saveSession(nu, sessionRemembered())
    }
    return { ok: true }
  }), [admins, currentUser, wrap])

  const deleteAdmin = useCallback(async (id) => wrap(async () => {
    if (secureAuthEnabled) return { ok: false, error: 'Penonaktifan akun Auth harus melalui pengelola sistem.' }
    if (admins.length <= 1) return { ok: false, error: 'Minimal harus ada 1 admin' }
    if (currentUser?.id === id) return { ok: false, error: 'Tidak bisa menghapus diri sendiri' }
    // Cegah hapus admin yang masih jadi PIC customer → minta pindahkan dulu.
    const { count } = await supabase.from('customers').select('id', { count: 'exact', head: true }).eq('owner_user_id', id).is('deleted_at', null)
    if ((count || 0) > 0) {
      return { ok: false, needsReassign: true, customerCount: count, error: `Admin ini masih menjadi PIC ${count} customer. Pindahkan customer ke admin lain dulu.` }
    }
    const { error: e } = await supabase.from('admins').delete().eq('id', id)
    if (e) return { ok: false, error: e.message }
    if (mounted.current) setAdmins(prev => prev.filter(a => a.id !== id))
    return { ok: true }
  }), [admins, currentUser, wrap])

  // Pindahkan semua customer milik 1 admin (PIC) ke admin lain. Dipakai sebelum
  // menghapus admin, atau untuk perapian. Tidak mengubah transaksi/piutang/nominal.
  const reassignAdminCustomers = useCallback(async (fromId, toId) => wrap(async () => {
    if (secureAuthEnabled) return reassignmentUnavailable()
    if (!fromId || !toId || fromId === toId) return { ok: false, error: 'Admin tujuan tidak valid' }
    const to = admins.find(a => a.id === toId)
    if (!to) return { ok: false, error: 'Admin tujuan tidak ditemukan' }
    const { error } = await supabase.from('customers')
      .update({ owner_user_id: toId, owner_username: to.username, owner_name: to.name || to.username })
      .eq('owner_user_id', fromId)
    if (error) return { ok: false, error: error.message }
    const from = admins.find(a => a.id === fromId)
    supabase.from('customer_owner_changes').insert({
      customer_id: null, customer_name: '(semua customer)',
      old_owner_id: fromId, old_owner_name: from?.name || from?.username || '',
      new_owner_id: toId, new_owner_name: to.name || to.username,
      changed_by: currentUser?.id || null, changed_by_name: currentUser?.name || currentUser?.username || '',
    }).then(() => {}, () => {})
    await refreshCustomers()
    return { ok: true }
  }), [admins, currentUser, wrap, refreshCustomers])

  const changePassword = useCallback(async (oldPass, newPass) => wrap(async () => {
    if (secureAuthEnabled) return { ok: false, error: 'Pemulihan akun owner harus melalui jalur Auth yang terverifikasi.' }
    if (!currentUser) return { ok: false, error: 'Belum login' }
    if (!newPass || newPass.length < 4) return { ok: false, error: 'Password baru minimal 4 karakter' }
    const { data: me, error: e1 } = await supabase.from('admins').select('id, password').eq('id', currentUser.id).single()
    if (e1) return { ok: false, error: e1.message }
    if (me.password !== oldPass) return { ok: false, error: 'Password lama salah' }
    const { error: e2 } = await supabase.from('admins').update({ password: newPass }).eq('id', currentUser.id)
    if (e2) return { ok: false, error: e2.message }
    return { ok: true }
  }), [currentUser, wrap])

  // ---------- CUSTOMERS ----------
  const addCustomer = useCallback(async (data) => wrap(async () => {
    if (!data.name?.trim()) return { ok: false, error: 'Nama wajib diisi' }
    // created_by = pembuat; owner_user_id = PIC (default user login, owner/admin boleh override)
    const payload = customerToDB(data)
    if (currentUser?.id) {
      payload.created_by = currentUser.id
      payload.created_by_name = currentUser.name || currentUser.username || ''
      payload.created_by_role = currentUser.role || ''
    }
    const ownerId = data.ownerUserId || currentUser?.id || null
    if (ownerId) {
      const a = admins.find(x => x.id === ownerId)
      payload.owner_user_id = ownerId
      payload.owner_username = a?.username || currentUser?.username || ''
      payload.owner_name = a?.name || a?.username || currentUser?.name || ''
    }
    if (writeBookId) payload.book_id = writeBookId
    let { data: row, error: e } = await supabase.from('customers').insert(payload).select().single()
    if (!secureAuthEnabled && e && /(created_by|owner_user_id|book_id|does not exist|schema cache)/i.test(e.message || '')) {
      const base = customerToDB(data)
      if (writeBookId) { try { base.book_id = writeBookId } catch { /* */ } }
      ;({ data: row, error: e } = await supabase.from('customers').insert(base).select().single())
      if (e && /book_id/i.test(e.message || '')) {
        delete base.book_id
        ;({ data: row, error: e } = await supabase.from('customers').insert(base).select().single())
      }
    }
    if (e) return { ok: false, error: e.message }
    if (mounted.current) setCustomers(prev => [customerFromDB(row), ...prev])
    return { ok: true, data: customerFromDB(row) }
  }), [wrap, currentUser, admins])

  const updateCustomer = useCallback(async (id, data) => wrap(async () => {
    const prevCust = customers.find(c => c.id === id)
    if (secureAuthEnabled && Object.prototype.hasOwnProperty.call(data, 'ownerUserId')
      && (data.ownerUserId || null) !== (prevCust?.ownerUserId || null)) return reassignmentUnavailable()
    const patch = customerToDB(data)
    const oldOwnerId = prevCust?.ownerUserId || null
    let ownerChanged = false
    if (data.ownerUserId && data.ownerUserId !== oldOwnerId) {
      const a = admins.find(x => x.id === data.ownerUserId)
      patch.owner_user_id = data.ownerUserId
      patch.owner_username = a?.username || ''
      patch.owner_name = a?.name || a?.username || ''
      ownerChanged = true
    }
    let { data: row, error: e } = await supabase.from('customers').update(patch).eq('id', id).select().single()
    if (!secureAuthEnabled && e && /owner_user_id|does not exist|schema cache/i.test(e.message || '')) {
      ;({ data: row, error: e } = await supabase.from('customers').update(customerToDB(data)).eq('id', id).select().single())
    }
    if (e) return { ok: false, error: e.message }
    if (mounted.current) setCustomers(prev => prev.map(c => c.id === id ? customerFromDB(row) : c))
    if (ownerChanged) {
      const na = admins.find(x => x.id === data.ownerUserId)
      supabase.from('customer_owner_changes').insert({
        customer_id: id, customer_name: prevCust?.name || row?.name || '',
        old_owner_id: oldOwnerId, old_owner_name: prevCust?.ownerName || '',
        new_owner_id: data.ownerUserId, new_owner_name: na?.name || na?.username || '',
        changed_by: currentUser?.id || null, changed_by_name: currentUser?.name || currentUser?.username || '',
      }).then(() => {}, () => {})
    }
    return { ok: true }
  }), [wrap, customers, admins, currentUser])

  const deleteCustomer = useCallback(async (id) => wrap(async () => {
    // Cegah hard delete bila customer masih punya transaksi/piutang → soft delete.
    const [{ count: trxCount, error: trxError }, { count: debtCount, error: debtError }] = await Promise.all([
      supabase.from('transactions').select('id', { count: 'exact', head: true }).eq('customer_id', id),
      supabase.from('debts').select('id', { count: 'exact', head: true }).eq('customer_id', id),
    ])
    if (trxError || debtError || !Number.isSafeInteger(trxCount) || trxCount < 0
      || !Number.isSafeInteger(debtCount) || debtCount < 0) {
      return { ok: false, error: 'Riwayat transaksi/piutang belum dapat diperiksa. Customer tidak dihapus; coba lagi setelah koneksi pulih.' }
    }
    const hasRelated = trxCount > 0 || debtCount > 0
    if (hasRelated) {
      const { error } = await supabase.from('customers').update({ deleted_at: new Date().toISOString() }).eq('id', id)
      if (error && /deleted_at|does not exist|schema cache/i.test(error.message || '')) {
        return { ok: false, error: 'Customer masih memiliki transaksi/piutang. Jalankan migrasi customer_reassign agar bisa dinonaktifkan.' }
      }
      if (error) return { ok: false, error: error.message }
      if (mounted.current) setCustomers(prev => prev.filter(c => c.id !== id))
      return { ok: true, deactivated: true, message: 'Customer ini masih memiliki transaksi/piutang. Customer hanya dinonaktifkan, bukan dihapus permanen.' }
    }
    const { error: e } = await supabase.from('customers').delete().eq('id', id)
    if (e) return { ok: false, error: e.message }
    if (mounted.current) setCustomers(prev => prev.filter(c => c.id !== id))
    return { ok: true }
  }), [wrap])

  // ── PINDAH CUSTOMER (perbaiki relasi customer pada nota yang sudah ada) ──
  // Tidak mengubah invoice/nominal/status — hanya customer_id + snapshot nama/HP.
  const _moveInvoiceToCustomer = async (trx, debt, newCust) => {
    const newName = newCust.name
    const newPhone = newCust.phone || newCust.whatsapp || ''
    const newAddr = newCust.address || ''
    let trxUpdated = 0, debtUpdated = 0
    if (trx) {
      let { error } = await supabase.from('transactions')
        .update({ customer_id: newCust.id, customer: newName, customer_name: newName, customer_phone: newPhone, customer_address: newAddr }).eq('id', trx.id)
      if (error && /customer_name|does not exist|schema cache/i.test(error.message || '')) {
        await supabase.from('transactions').update({ customer_id: newCust.id, customer: newName, customer_phone: newPhone, customer_address: newAddr }).eq('id', trx.id)
      }
      trxUpdated = 1
    }
    if (debt) {
      let { error } = await supabase.from('debts')
        .update({ customer_id: newCust.id, customer_name: newName, customer_phone: newPhone }).eq('id', debt.id)
      if (error && /customer_name|customer_phone|does not exist|schema cache/i.test(error.message || '')) {
        await supabase.from('debts').update({ customer_id: newCust.id }).eq('id', debt.id)
      }
      debtUpdated = 1
      // pembayaran milik debt ini
      const pe = await supabase.from('debt_payments').update({ customer_id: newCust.id, customer_name: newName }).eq('debt_id', debt.id)
      if (pe.error && !/customer_id|customer_name|does not exist|schema cache/i.test(pe.error.message || '')) {
        // error lain diabaikan (kolom opsional)
      }
    }
    return { trxUpdated, debtUpdated }
  }

  // PIUTANG: pindahkan semua nota hutang sebuah grup customer ke customer baru.
  const reassignReceivableCustomer = useCallback(async ({ debtIds = [], invoiceNos = [], oldCustomerId = null, oldCustomerName = '', newCustomerId, notes = '' }) => wrap(async () => {
    if (secureAuthEnabled) return reassignmentUnavailable()
    if (currentUser?.role !== 'owner' && currentUser?.role !== 'admin') return { ok: false, error: 'Hanya Owner & Staff Admin yang bisa memindahkan piutang' }
    if (!newCustomerId) return { ok: false, error: 'Customer baru wajib dipilih' }
    const newCust = customers.find(c => c.id === newCustomerId)
    if (!newCust) return { ok: false, error: 'Customer baru tidak ditemukan' }
    if (oldCustomerId && oldCustomerId === newCustomerId) return { ok: false, error: 'Customer tujuan sama dengan customer saat ini.' }

    let debtRows = []
    if (debtIds.length) { const r = await supabase.from('debts').select('*').in('id', debtIds); debtRows = r.data || [] }
    else if (invoiceNos.length) { const r = await supabase.from('debts').select('*').in('invoice_no', invoiceNos); debtRows = r.data || [] }
    const invSet = new Set([...invoiceNos, ...debtRows.map(d => d.invoice_no).filter(Boolean)])
    let trxRows = []
    if (invSet.size) { const r = await supabase.from('transactions').select('*').in('invoice_no', [...invSet]); trxRows = r.data || [] }
    const trxIds = debtRows.map(d => d.transaction_id).filter(Boolean)
    if (trxIds.length) { const r2 = await supabase.from('transactions').select('*').in('id', trxIds); (r2.data || []).forEach(t => { if (!trxRows.find(x => x.id === t.id)) trxRows.push(t) }) }

    const oldId = oldCustomerId || debtRows[0]?.customer_id || trxRows[0]?.customer_id || null
    const oldName = oldCustomerName || trxRows[0]?.customer || debtRows[0]?.customer_name || 'Customer dihapus'

    let affDebt = 0
    for (const d of debtRows) {
      const trx = trxRows.find(t => t.id === d.transaction_id || t.invoice_no === d.invoice_no)
      const r = await _moveInvoiceToCustomer(trx, d, newCust); affDebt += r.debtUpdated
    }
    // Transaksi tanpa baris debt (jaga-jaga) tetap dipindah
    for (const t of trxRows) {
      if (!debtRows.find(d => d.transaction_id === t.id || d.invoice_no === t.invoice_no)) await _moveInvoiceToCustomer(t, null, newCust)
    }

    await supabase.from('receivable_customer_changes').insert({
      old_customer_id: oldId, old_customer_name: oldName,
      new_customer_id: newCustomerId, new_customer_name: newCust.name,
      affected_invoice_count: invSet.size, affected_debt_count: affDebt,
      changed_by: currentUser?.id || null, changed_by_name: currentUser?.name || currentUser?.username || '', notes,
    }).then(() => {}, () => {})

    if (oldId) await recalculateCustomerSummary(oldId)
    await recalculateCustomerSummary(newCustomerId)
    await Promise.all([refreshTransactions(), refreshDebts(), refreshDebtPayments(), refreshCustomers()])
    return { ok: true, affectedInvoice: invSet.size, affectedDebt: affDebt }
  }), [customers, currentUser, wrap, recalculateCustomerSummary, refreshTransactions, refreshDebts, refreshDebtPayments, refreshCustomers])

  // Riwayat perubahan customer (audit) — untuk ditampilkan di UI.
  const getOrderCustomerChanges = useCallback(async (invoiceNo) => {
    if (!invoiceNo) return []
    const { data } = await supabase.from('order_customer_changes').select('*').eq('invoice_no', invoiceNo).order('changed_at', { ascending: false })
    return data || []
  }, [])
  const getReceivableCustomerChanges = useCallback(async (customerId) => {
    let q = supabase.from('receivable_customer_changes').select('*').order('changed_at', { ascending: false }).limit(50)
    if (customerId) q = q.or(`new_customer_id.eq.${customerId},old_customer_id.eq.${customerId}`)
    const { data } = await q
    return data || []
  }, [])

  // ORDER: pindahkan customer satu invoice/order (invoice tetap sama).
  const reassignOrderCustomer = useCallback(async ({ transactionId, invoiceNo, newCustomerId, notes = '' }) => wrap(async () => {
    if (secureAuthEnabled) return reassignmentUnavailable()
    if (!newCustomerId) return { ok: false, error: 'Customer baru wajib dipilih' }
    const newCust = customers.find(c => c.id === newCustomerId)
    if (!newCust) return { ok: false, error: 'Customer baru tidak ditemukan' }
    let trx = null
    if (transactionId) { const r = await supabase.from('transactions').select('*').eq('id', transactionId).maybeSingle(); trx = r.data }
    if (!trx && invoiceNo) { const r = await supabase.from('transactions').select('*').eq('invoice_no', invoiceNo).maybeSingle(); trx = r.data }
    if (!trx) return { ok: false, error: 'Order tidak ditemukan' }
    const role = currentUser?.role
    if (role !== 'owner' && role !== 'admin' && trx.cashier_id !== currentUser?.id) return { ok: false, error: 'Anda hanya bisa mengubah order milik sendiri' }
    if (trx.customer_id && trx.customer_id === newCustomerId) return { ok: false, error: 'Customer tujuan sama dengan customer saat ini.' }
    const oldId = trx.customer_id || null, oldName = trx.customer || 'Customer'
    let debt = null
    { const r = await supabase.from('debts').select('*').eq('invoice_no', trx.invoice_no).maybeSingle(); debt = r.data }
    if (!debt) { const r = await supabase.from('debts').select('*').eq('transaction_id', trx.id).maybeSingle(); debt = r.data }
    await _moveInvoiceToCustomer(trx, debt, newCust)
    await supabase.from('order_customer_changes').insert({
      invoice_no: trx.invoice_no, order_id: trx.id,
      old_customer_id: oldId, old_customer_name: oldName,
      new_customer_id: newCustomerId, new_customer_name: newCust.name,
      changed_by: currentUser?.id || null, changed_by_name: currentUser?.name || currentUser?.username || '', notes,
    }).then(() => {}, () => {})
    if (oldId) await recalculateCustomerSummary(oldId)
    await recalculateCustomerSummary(newCustomerId)
    await Promise.all([refreshTransactions(), refreshDebts(), refreshDebtPayments(), refreshCustomers()])
    return { ok: true }
  }), [customers, currentUser, wrap, recalculateCustomerSummary, refreshTransactions, refreshDebts, refreshDebtPayments, refreshCustomers])

  // ---------- PRODUCTS ----------
  // Detect "missing column" errors from PostgREST (Supabase REST API)
  // so we can retry with a stripped payload when the DB migration
  // hasn't been applied yet. Without this, an outdated schema would
  // crash all product CRUD with "Could not find the 'unit' column".
  const isSchemaCacheError = (err, col) => {
    if (!err) return false
    const msg = String(err.message || err.error_description || '').toLowerCase()
    const code = String(err.code || '')
    return (
      code === 'PGRST204' ||
      msg.includes(`'${col}' column`) ||
      msg.includes(`column "${col}"`) ||
      msg.includes(`could not find the '${col}'`) ||
      msg.includes('schema cache')
    )
  }
  // Drop one or more keys and return a new object
  const omit = (obj, keys) => {
    const out = { ...obj }
    for (const k of keys) delete out[k]
    return out
  }

  const addProduct = useCallback(async (data) => wrap(async () => {
    const payload = productToDB(data)
    if (secureAuthEnabled) {
      const row = await saveSecureProduct(supabase, null, payload, currentUser?.role)
      if (mounted.current) setProducts(prev => [productFromDB(row), ...prev])
      return { ok: true }
    }
    let { data: row, error: e } = await supabase
      .from('products').insert(payload).select().single()
    // Fallback: DB belum punya kolom is_favorite (migrasi belum jalan).
    if (e && isSchemaCacheError(e, 'is_favorite')) {
      const retry = await supabase.from('products').insert(omit(payload, ['is_favorite'])).select().single()
      row = retry.data; e = retry.error
    }
    // Fallback: DB may be missing `unit` column (migration not yet run).
    if (e && isSchemaCacheError(e, 'unit')) {
      // eslint-disable-next-line no-console
      console.warn('[Skupy POS] DB belum punya kolom products.unit — produk akan disimpan tanpa unit. Jalankan migrasi supabase/migrations/2026_06_add_unit_to_products.sql.')
      const retry = await supabase
        .from('products').insert(omit(payload, ['unit'])).select().single()
      row = retry.data; e = retry.error
    }
    if (e) return { ok: false, error: e.message }
    if (mounted.current) setProducts(prev => [productFromDB(row), ...prev])
    return { ok: true }
  }), [wrap, currentUser?.role])

  const updateProduct = useCallback(async (id, data) => wrap(async () => {
    const payload = productToDB(data)
    if (secureAuthEnabled) {
      const row = await saveSecureProduct(supabase, id, payload, currentUser?.role)
      if (mounted.current) setProducts(prev => prev.map(p => p.id === id ? productFromDB(row) : p))
      return { ok: true }
    }
    let { data: row, error: e } = await supabase
      .from('products').update(payload).eq('id', id).select().single()
    if (e && isSchemaCacheError(e, 'is_favorite')) {
      const retry = await supabase.from('products').update(omit(payload, ['is_favorite'])).eq('id', id).select().single()
      row = retry.data; e = retry.error
    }
    if (e && isSchemaCacheError(e, 'unit')) {
      // eslint-disable-next-line no-console
      console.warn('[Skupy POS] DB belum punya kolom products.unit — produk akan disimpan tanpa unit. Jalankan migrasi supabase/migrations/2026_06_add_unit_to_products.sql.')
      const retry = await supabase
        .from('products').update(omit(payload, ['unit'])).eq('id', id).select().single()
      row = retry.data; e = retry.error
    }
    if (e) return { ok: false, error: e.message }
    if (mounted.current) setProducts(prev => prev.map(p => p.id === id ? productFromDB(row) : p))
    return { ok: true }
  }), [wrap, currentUser?.role])

  const deleteProduct = useCallback(async (id) => wrap(async () => {
    const { error: e } = await supabase.from('products').delete().eq('id', id)
    if (e) return { ok: false, error: e.message }
    if (mounted.current) setProducts(prev => prev.filter(p => p.id !== id))
    return { ok: true }
  }), [wrap])

  // Tandai / batalkan favorit produk (optimistic + realtime). Hanya mengubah
  // is_favorite — tidak menyentuh harga/modal/kategori.
  const setProductFavorite = useCallback(async (id, value) => wrap(async () => {
    const fav = !!value
    if (mounted.current) setProducts(prev => prev.map(p => p.id === id ? { ...p, isFavorite: fav } : p))
    const { error } = await supabase.from('products').update({ is_favorite: fav }).eq('id', id)
    if (error && isSchemaCacheError(error, 'is_favorite')) {
      // rollback optimistic
      if (mounted.current) setProducts(prev => prev.map(p => p.id === id ? { ...p, isFavorite: !fav } : p))
      return { ok: false, error: 'Kolom favorit belum ada. Jalankan migrasi products_is_favorite.sql.' }
    }
    if (error) {
      if (mounted.current) setProducts(prev => prev.map(p => p.id === id ? { ...p, isFavorite: !fav } : p))
      return { ok: false, error: error.message }
    }
    return { ok: true }
  }), [wrap])

  // ---------- TRANSACTIONS ----------
  // Format invoice baru: TIMESTAMP + RANDOM SUFFIX
  //   invoice_no : INV-YYYYMMDD-HHMMSS-XXX  → INV-20260601-151923-482
  //   order_no   : ORD-YYYYMMDD-HHMMSS-XXX  → ORD-20260601-151923-482
  // Kenapa diganti dari format harian (DDMMYYYY-001):
  //   • Format harian rentan tabrakan kalau ada baris yang dihapus atau
  //     dua kasir checkout bersamaan (lihat error 23505 yang muncul user).
  //   • Format timestamp + random 3-digit secara praktis collision-proof:
  //     harus DUA checkout di detik yang sama AND random sama (1/1000).
  //   • Tetap human-readable dan terurut secara alami.
  // Generator dipanggil tepat saat checkout (lihat addTransaction);
  // tidak ada generate "early" saat halaman Kasir dibuka.
  const generateInvoiceNumber = useCallback(() => {
    const d = new Date()
    const y = d.getFullYear()
    const mo = String(d.getMonth() + 1).padStart(2, '0')
    const da = String(d.getDate()).padStart(2, '0')
    const hh = String(d.getHours()).padStart(2, '0')
    const mi = String(d.getMinutes()).padStart(2, '0')
    const ss = String(d.getSeconds()).padStart(2, '0')
    const rand = String(Math.floor(Math.random() * 1000)).padStart(3, '0')
    // Prefix per book (opsional), mis. SKP-INV-... / THW-INV-... → unik antar book.
    const bk = (books || []).find(b => b.id === writeBookId)
    const pre = (bk?.prefix || '').trim().toUpperCase()
    const head = pre ? `${pre}-INV` : 'INV'
    return `${head}-${y}${mo}${da}-${hh}${mi}${ss}-${rand}`
  }, [books, activeBookId, defaultBookId])

  const generateOrderNumber = useCallback(() => {
    const d = new Date()
    const y = d.getFullYear()
    const mo = String(d.getMonth() + 1).padStart(2, '0')
    const da = String(d.getDate()).padStart(2, '0')
    const hh = String(d.getHours()).padStart(2, '0')
    const mi = String(d.getMinutes()).padStart(2, '0')
    const ss = String(d.getSeconds()).padStart(2, '0')
    const rand = String(Math.floor(Math.random() * 1000)).padStart(3, '0')
    return `ORD-${y}${mo}${da}-${hh}${mi}${ss}-${rand}`
  }, [])

  // Compat: nama lama dipertahankan supaya callers (di addTransaction
  // dan elsewhere) tidak perlu diubah massal. Keduanya sekarang sync.
  const nextInvoiceNumber = useCallback(async () => generateInvoiceNumber(), [generateInvoiceNumber])
  const nextOrderNumber   = useCallback(async () => generateOrderNumber(),   [generateOrderNumber])

  // Detect Postgres UNIQUE violation (code 23505) so we know to regenerate
  // the invoice number and retry. Supabase forwards the code on err.code,
  // and the message typically includes "duplicate key value violates unique".
  const isUniqueViolation = (err) => {
    if (!err) return false
    if (err.code === '23505') return true
    const msg = String(err.message || '').toLowerCase()
    return msg.includes('duplicate key') || msg.includes('unique constraint')
  }

  // ---------- CUSTOMER RECALCULATION ----------
  // Hitung ulang total_transactions, total_spent, dan total_debt dari tabel
  // transactions + debts. Dipanggil setelah checkout / payDebt / delete agar
  // tidak ada drift antar tabel (trigger DB hanya menambah saat INSERT, tidak
  // mengurangi saat DELETE).
  const addTransaction = useCallback(async (trx) => wrap(async () => {
    let writeDispatched = false
    try {
      const cashier = currentUser?.name || currentUser?.username || ''
      const cashierId = currentUser?.id || null
      const cashierRole = currentUser?.role || 'cashier'
      const nowIso = new Date().toISOString()
      // PIC order = PIC customer (kalau ada), fallback ke kasir yang melayani.
      const _cust = (trx.customerId && customers.find(c => c.id === trx.customerId)) || null
      const ownerUserId = _cust?.ownerUserId || cashierId || null
      const ownerName = _cust?.ownerName || cashier || ''
      // Snapshot identitas invoice admin pembuat: utamakan Profil Invoice (master
      // data), fallback rekening per-admin lama, lalu identitas toko default.
      const _prof = invoiceProfileForAdmin(cashierId)
      const _legacyBank = bankAccountForAdmin(cashierId)
      const _bank = _prof?.bank || _legacyBank
      const invoiceSnap = {
        ...(_bank ? { bankAccountId: _bank.id, bankName: _bank.bank_name, bankNumber: _bank.account_number, bankHolder: _bank.account_holder } : {}),
        ...((_prof?.location || _prof?.contact) ? {
          storeNameSnapshot: _prof?.location?.store_name || _prof?.location?.location_name || '',
          addressSnapshot: _prof?.location?.address || '',
          phoneSnapshot: _prof?.contact?.whatsapp || _prof?.contact?.phone || '',
        } : {}),
      }
      const statusHistory = [{
        order_status: trx.orderStatus || 'menunggu',
        changed_at: nowIso,
        changed_by: cashier || 'system',
      }]

      // ─── RETRY LOOP — handle duplicate invoice_no (race / gap / etc.) ───
      // Penyebab bentrok:
      //   1. Dua kasir checkout bersamaan, COUNT/MAX query keduanya balik
      //      angka sama → keduanya generate nomor yang sama.
      //   2. Invoice lama dengan nomor yang sama belum sempat tersinkron.
      //   3. Race condition antara generate dan insert.
      // Solusi: loop sampai 5x, generate ulang nomor dari MAX, lalu retry.
      const MAX_ATTEMPTS = 5
      let row = null, e = null, invoiceNo = '', orderNo = ''
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        // Fresh number each attempt (MAX query melihat baris yang baru saja
        // disisip oleh kasir lain juga, jadi attempt ke-2 akan mendapat
        // nomor yang sudah berbeda dari attempt ke-1).
        ;[invoiceNo, orderNo] = await Promise.all([
          nextInvoiceNumber(),
          nextOrderNumber(),
        ])
        const payload = trxToDB({
          ...trx,
          invoiceNo, orderNo,
          cashier, cashierId, cashierRole,
          ownerUserId, ownerName,
          ...invoiceSnap,
          statusHistory,
          orderStatus: trx.orderStatus || 'menunggu',
        })
        // Tag book aktif (defensif: hanya bila ada book & kolomnya ada).
        if (writeBookId) payload.book_id = writeBookId
        // eslint-disable-next-line no-console
        console.log(`[useStore] Inserting transaction (attempt ${attempt}/${MAX_ATTEMPTS}):`, invoiceNo)
        writeDispatched = true
        let res = await supabase.from('transactions').insert(payload).select().single()
        // Defensive retry kalau DB belum punya kolom due_date / cashier_role.
        if (!secureAuthEnabled && res.error && isSchemaCacheError(res.error, 'due_date')) {
          // eslint-disable-next-line no-console
          console.warn('[useStore] DB belum punya kolom transactions.due_date — transaksi disimpan tanpa due_date.')
          res = await supabase
            .from('transactions').insert(omit(payload, ['due_date'])).select().single()
        }
        if (!secureAuthEnabled && res.error && isSchemaCacheError(res.error, 'cashier_role')) {
          // eslint-disable-next-line no-console
          console.warn('[useStore] DB belum punya kolom transactions.cashier_role — transaksi disimpan tanpa role.')
          res = await supabase
            .from('transactions').insert(omit(payload, ['cashier_role'])).select().single()
        }
        if (!secureAuthEnabled && res.error && (isSchemaCacheError(res.error, 'owner_user_id') || isSchemaCacheError(res.error, 'owner_name'))) {
          res = await supabase
            .from('transactions').insert(omit(payload, ['owner_user_id', 'owner_name'])).select().single()
        }
        // Fallback bila kolom book_id belum ada (migrasi Book belum dijalankan).
        if (!secureAuthEnabled && res.error && isSchemaCacheError(res.error, 'book_id')) {
          res = await supabase.from('transactions').insert(omit(payload, ['book_id'])).select().single()
        }
        // Fallback bila kolom snapshot rekening bank belum ada (migrasi belum jalan).
        if (!secureAuthEnabled && res.error && (isSchemaCacheError(res.error, 'bank_account_id') || isSchemaCacheError(res.error, 'bank_name') || isSchemaCacheError(res.error, 'bank_account_number') || isSchemaCacheError(res.error, 'bank_account_holder') || isSchemaCacheError(res.error, 'created_by_admin_id'))) {
          res = await supabase.from('transactions').insert(omit(payload, ['bank_account_id', 'bank_name', 'bank_account_number', 'bank_account_holder', 'created_by_admin_id'])).select().single()
        }
        // Fallback bila kolom snapshot identitas toko belum ada (migrasi belum jalan).
        if (!secureAuthEnabled && res.error && (isSchemaCacheError(res.error, 'store_name_snapshot') || isSchemaCacheError(res.error, 'address_snapshot') || isSchemaCacheError(res.error, 'phone_snapshot'))) {
          res = await supabase.from('transactions').insert(omit(payload, ['store_name_snapshot', 'address_snapshot', 'phone_snapshot'])).select().single()
        }
        row = res.data
        e = res.error
        if (!e) break // success
        // A transport/representation failure can arrive after the INSERT committed.
        const rejected = (res.status === 409 && ['23505', '23503'].includes(e.code)) ||
          ([401, 403].includes(res.status) && e.code === '42501') ||
          (res.status === 400 && ['PGRST204', '23502', '23514', '22023', '22P02'].includes(e.code)) ||
          (res.status === 404 && e.code === 'PGRST205')
        if (!rejected) return incompleteTransactionSync()
        if (secureAuthEnabled ? e.code === '23505' : isUniqueViolation(e)) {
          // eslint-disable-next-line no-console
          console.warn(`[useStore] Nomor invoice ${invoiceNo} sudah dipakai, generate ulang (attempt ${attempt}/${MAX_ATTEMPTS})…`)
          // Short backoff so concurrent inserts don't keep stepping on each other
          await new Promise(r => setTimeout(r, 60 + attempt * 40))
          continue
        }
        // Non-recoverable error — break out so the user sees the real message
        break
      }
      if (e) {
        // eslint-disable-next-line no-console
        console.error('[useStore] Gagal insert transaksi (semua percobaan habis):', e)
        // Translate raw DB error → user-friendly Indonesian
        const msg = String(e.message || '').toLowerCase()
        const isAccPerm = msg.includes('accounting_entries') ||
          (msg.includes('permission denied') && msg.includes('account'))
        const friendly = isUniqueViolation(e)
          ? 'Nomor invoice sedang sibuk digunakan kasir lain. Coba checkout sekali lagi.'
          : isAccPerm
          ? 'Checkout gagal karena hak akses Accounting belum siap. Hubungi owner untuk memeriksa konfigurasi keamanan.'
          : `Gagal menyimpan transaksi: ${e.message}`
        return { ok: false, error: friendly }
      }
      if (!row?.id) return incompleteTransactionSync()

      // Decrement stock
      await Promise.all(trx.items.map(async (item) => {
        const p = products.find(x => x.id === item.productId)
        if (!p) return
        await supabase.from('products').update({ stock: Math.max(0, p.stock - item.qty) }).eq('id', item.productId)
      }))

      // If "Hutang", create a debt row
      if (trx.paymentMethod === 'hutang' && trx.customerId) {
        // ✱ DEBT MIRROR-OF-TRANSACTION ✱
        // debt.total_debt   = transactions.total        (full total tagihan)
        // debt.paid         = transactions.paid         (sudah include DP)
        // debt.remaining    = transactions.remaining    (total - paid)
        // Sebelumnya debt.paid disimpan 0 + total_debt = sisa-setelah-DP →
        // saat processDebtPayment menulis paidAfter ke transactions, DP
        // hilang (terpotong dobel). Sekarang kedua tabel selalu mirror.
        const totalFinal = Math.round(+trx.total || 0)
        const dpAmt = Math.round(+trx.paid || +trx.dp || 0)
        const remainingAmt = Math.max(0, totalFinal - dpAmt)
        const debtPayload = {
          customer_id: trx.customerId,
          transaction_id: row.id,
          invoice_no: invoiceNo,
          total_debt: totalFinal,
          paid: dpAmt,
          remaining: remainingAmt,
          due_date: trx.dueDate || null,
          status: remainingAmt <= 0 ? 'lunas' : 'aktif',
          notes: trx.notes || '',
        }
        if (writeBookId) debtPayload.book_id = writeBookId
        let { error: debtErr } = await supabase.from('debts').insert(debtPayload)
        if (!secureAuthEnabled && debtErr && isSchemaCacheError(debtErr, 'book_id')) {
          ;({ error: debtErr } = await supabase.from('debts').insert(omit(debtPayload, ['book_id'])))
        }
        if (debtErr) {
          // eslint-disable-next-line no-console
          console.error('[useStore] Gagal membuat hutang:', debtErr, debtPayload)
          return incompleteTransactionSync()
        }
        await refreshDebts()
      }

      const newTrx = trxFromDB(row)
      if (mounted.current) {
        setTransactions(prev => [newTrx, ...prev])
        setProducts(prev => prev.map(p => {
          const it = trx.items.find(i => i.productId === p.id)
          if (!it) return p
          return { ...p, stock: Math.max(0, p.stock - it.qty) }
        }))
      }
      // Refresh customer stats — use recalculate to keep numbers honest
      // (the INSERT trigger only adds; we want canonical values).
      if (trx.customerId) {
        const summary = await recalculateCustomerSummary(trx.customerId)
        if (!summary.ok) return incompleteTransactionSync()
        await refreshCustomers()
      }
      return { ok: true, data: newTrx }
    } catch (err) {
      return writeDispatched ? incompleteTransactionSync() : { ok: false, error: err.message || String(err) }
    }
  }), [products, customers, currentUser, wrap, nextInvoiceNumber, nextOrderNumber, refreshCustomers, refreshDebts, recalculateCustomerSummary, bankAccountForAdmin, invoiceProfileForAdmin])

  // ---------- SYNC DEBT ↔ TRANSACTION ↔ CUSTOMER ----------
  // syncDebtPaymentStatus(invoiceNo)
  // ------------------------------------------------------------
  // Single source of truth untuk konsistensi 4 tabel berdasarkan invoice_no.
  // Dipanggil setelah:
  //   • Order ditandai Lunas dari halaman Order (updateTransactionStatus)
  //   • Pembayaran sebagian dari halaman Order (updateTransactionPayment)
  //   • Pembayaran hutang dari halaman Piutang (payDebt)
  // Cara kerja:
  //   1. Cari transaction berdasarkan invoice_no
  //   2. Cari debt berdasarkan invoice_no atau transaction_id
  //   3. SUM debt_payments untuk debt tersebut
  //   4. Update paid + remaining + status di debts
  //   5. Update paid + remaining + status di transactions
  //   6. Recalc customers.total_debt
  // Idempotent — aman dipanggil berkali-kali untuk invoice yang sama.
  const syncDebtPaymentStatus = useCallback(async (invoiceNo) => {
    if (!invoiceNo) return { ok: false, error: 'invoice_no kosong' }
    let writeAttempted = false
    try {
      // 1. Transaction by invoice_no
      const { data: trx, error: trxErr } = await supabase
        .from('transactions')
        .select('id, invoice_no, customer_id, total, paid, remaining, status')
        .eq('invoice_no', invoiceNo)
        .maybeSingle()
      if (trxErr || !trx) {
        return { ok: false, error: trxErr?.message || 'Transaksi tidak ditemukan' }
      }
      const totalAmt = Math.round(+trx.total || 0)

      // 2. Debt by invoice_no OR transaction_id (whichever matches first)
      let { data: debt, error: debtError } = await supabase
        .from('debts')
        .select('*')
        .eq('invoice_no', invoiceNo)
        .maybeSingle()
      if (debtError) return { ok: false, error: 'Piutang belum dapat diperiksa. Sinkronisasi tidak dijalankan.' }
      if (!debt) {
        const byTrx = await supabase
          .from('debts').select('*').eq('transaction_id', trx.id).maybeSingle()
        if (byTrx.error) return { ok: false, error: 'Piutang belum dapat diperiksa. Sinkronisasi tidak dijalankan.' }
        debt = byTrx.data
      }

      let newPaid, newRemaining, newStatus
      if (debt) {
        // 3. SUM debt_payments → authoritative source of paid
        const { data: payments, error: paymentsError } = await supabase
          .from('debt_payments').select('amount').eq('debt_id', debt.id)
        if (paymentsError || !Array.isArray(payments)) return { ok: false, error: 'Riwayat pembayaran belum dapat diperiksa. Sinkronisasi tidak dijalankan.' }
        const paidFromHistory = Math.round((payments || []).reduce((s, p) => s + (+p.amount || 0), 0))
        // If trx.paid is higher (e.g. user marked Lunas manually from Order
        // without going through payDebt), take the larger number — that
        // represents the actual settled amount.
        newPaid = Math.round(Math.max(paidFromHistory, +trx.paid || 0))
        newRemaining = Math.max(0, totalAmt - newPaid)
        newStatus = newRemaining <= 0 ? 'lunas' : 'aktif'

        // 4. Update debts
        writeAttempted = true
        const debtWriteResult = await supabase.from('debts').update({
          paid: newPaid,
          remaining: newRemaining,
          status: newStatus,
        }).eq('id', debt.id).select('id').single()
        if (!confirmedWrite(debtWriteResult, debt.id)) return incompleteTransactionSync()
      } else {
        // No debt row — purely cash/transfer/qris transaction
        newPaid = Math.round(+trx.paid || 0)
        newRemaining = Math.max(0, totalAmt - newPaid)
        newStatus = newRemaining <= 0 ? 'lunas' : 'pending'
      }

      // 5. Update transactions (always — payment status reflects in Order)
      const trxStatus = newRemaining <= 0 ? 'lunas' : 'pending'
      writeAttempted = true
      const trxWriteResult = await supabase.from('transactions').update({
        paid: newPaid,
        dp: newPaid,
        remaining: newRemaining,
        status: trxStatus,
      }).eq('id', trx.id).select('id').single()
      if (!confirmedWrite(trxWriteResult, trx.id)) return incompleteTransactionSync()

      // 6. Recalc customer summary
      if (trx.customer_id) {
        const summary = await recalculateCustomerSummary(trx.customer_id)
        if (!summary.ok) return incompleteTransactionSync()
      }

      return { ok: true, data: { paid: newPaid, remaining: newRemaining, status: trxStatus } }
    } catch (err) {
      return writeAttempted ? incompleteTransactionSync() : { ok: false, error: 'Data invoice/piutang belum dapat diperiksa. Sinkronisasi tidak dijalankan.' }
    }
  }, [recalculateCustomerSummary])

  const destructivePaymentCheck = useCallback(async (trx, debt) => {
    const review = { ok: false, needsReview: true, error: 'Ada pembayaran/DP atau riwayat keuangan. Penghapusan/pembatalan belum tersedia tanpa rekonsiliasi oleh owner; belum ada perubahan yang disimpan.' }
    if ((trx && (paymentMoney(trx.paid) > 0 || paymentMoney(trx.dp) > 0))
      || (debt && paymentMoney(debt.paid) > 0)) return review
    // Include even retained soft-deleted history: destructive deletion must not
    // erase its audit trail. These are existence checks, not receipt totals.
    if (debt?.id) {
      const history = paymentRead(await supabase.from('debt_payments').select('id').eq('debt_id', debt.id).limit(1))
      if (!Array.isArray(history)) throw new Error('Riwayat pembayaran belum dapat diperiksa')
      if (history.length) return review
    }
    const invoiceNo = trx?.invoice_no || debt?.invoice_no
    if (invoiceNo) {
      const history = paymentRead(await supabase.from('debt_payments').select('id').eq('invoice_no', invoiceNo).limit(1))
      if (!Array.isArray(history)) throw new Error('Riwayat pembayaran belum dapat diperiksa')
      if (history.length) return review
    }
    return { ok: true }
  }, [])

  const updateOrderStatus = useCallback(async (id, newStatus) => wrap(async () => {
    const current = transactions.find(t => t.id === id)
    if (!current) return { ok: false, error: 'Transaksi tidak ditemukan' }
    return containPayment([current.invoiceNo && `invoice:${current.invoiceNo}`, current.customerId && `customer:${current.customerId}`], async ({ write, guard }) => {
      let snapshot = current
      if (newStatus === 'dibatalkan') {
        const fresh = paymentRead(await supabase.from('transactions')
          .select('id, invoice_no, customer_id, paid, dp, status_history, order_status, deleted_at').eq('id', id).maybeSingle())
        if (!fresh || fresh.id !== id || fresh.deleted_at) return { ok: false, error: 'Invoice belum dapat diperiksa' }
        guard([fresh.invoice_no && `invoice:${fresh.invoice_no}`, fresh.customer_id && `customer:${fresh.customer_id}`])
        // Legacy cancellation SQL removes cash postings. Until DP disposition has
        // a real ledger workflow, refuse any invoice that has received money.
        if (!Number.isFinite(Number(fresh.paid)) || !Number.isFinite(Number(fresh.dp))
          || Number(fresh.paid) !== 0 || Number(fresh.dp) !== 0) {
          return { ok: false, error: 'Invoice sudah menerima pembayaran/DP. Pembatalan memerlukan penyelesaian DP oleh owner; belum ada perubahan yang disimpan.' }
        }
        let debt = paymentRead(await supabase.from('debts').select('*').eq('transaction_id', id).maybeSingle())
        if (!debt && fresh.invoice_no) {
          debt = paymentRead(await supabase.from('debts').select('*').eq('invoice_no', fresh.invoice_no).maybeSingle())
        }
        if (debt && paymentMoney(debt.remaining) > 0) {
          return { ok: false, needsReview: true, error: 'Invoice masih memiliki piutang terkait. Pembatalan memerlukan penyelesaian piutang oleh owner; belum ada perubahan yang disimpan.' }
        }
        const allowed = await destructivePaymentCheck(fresh, debt)
        if (!allowed.ok) return allowed
        snapshot = { ...current, statusHistory: fresh.status_history, orderStatus: fresh.order_status }
      }
      const newHistory = [...(snapshot.statusHistory || []), {
        order_status: newStatus, changed_at: new Date().toISOString(),
        changed_by: currentUser?.name || currentUser?.username || 'system',
        from: snapshot.orderStatus || 'menunggu',
      }]
      const row = await write(supabase.from('transactions')
        .update({ order_status: newStatus, status_history: newHistory }).eq('id', id).select().single(), id)
      if (mounted.current) setTransactions(prev => prev.map(t => t.id === id ? trxFromDB(row) : t))
      return { ok: true }
    })
  }), [transactions, currentUser, wrap, containPayment, destructivePaymentCheck])

  const updateTransactionStatus = useCallback(async (id, status) => wrap(async () => {
    const current = transactions.find(t => t.id === id)
    if (!current) return { ok: false, error: 'Transaksi tidak ditemukan' }
    return containPayment([current.invoiceNo && `invoice:${current.invoiceNo}`, current.customerId && `customer:${current.customerId}`], async ({ write }) => {
      if (status === 'lunas') {
        if (Number(current.remaining) > 0 || Number(current.paid) < Number(current.total)) {
          return { ok: false, error: 'Masih ada sisa tagihan. Gunakan Tambah Pembayaran agar nominal dan metode tercatat.' }
        }
        const fresh = paymentRead(await supabase.from('transactions').select('id, total, paid, remaining').eq('id', id).maybeSingle())
        if (fresh?.id !== id || Number(fresh.remaining) !== 0 || Number(fresh.total) !== Number(fresh.paid)) {
          return { ok: false, error: 'Saldo belum terkonfirmasi lunas. Gunakan Tambah Pembayaran atau minta owner memeriksa invoice.' }
        }
      }
      const row = await write(supabase.from('transactions').update({ status }).eq('id', id).select().single(), id)
      if (mounted.current) setTransactions(prev => prev.map(t => t.id === id ? trxFromDB(row) : t))
      await Promise.all([refreshDebts(), refreshCustomers()])
      return { ok: true }
    })
  }), [transactions, wrap, containPayment, refreshDebts, refreshCustomers])

  // Verified sessions use one atomic server operation. Legacy sessions retain
  // their guarded sequential path until the coordinated production cutover.
  const processDebtPayment = useCallback(async ({
    invoice_no, paymentAmount, paymentMethod = 'cash', notes = '', skipRefresh = false,
  }) => {
    if (secureAuthEnabled) return wrap(async () => ({ ...await paymentWorkflow.submit({ invoiceNo: invoice_no,
      amount: paymentAmount, method: paymentMethod, notes }), invoiceNo: invoice_no }))
    return wrap(() => containPayment([invoice_no && `invoice:${invoice_no}`], async ({ guard, write }) => {
    const amount = paymentMoney(paymentAmount)
    if (amount <= 0) {
      return { ok: false, error: 'Nominal pembayaran harus lebih dari 0' }
    }
    if (!invoice_no) return { ok: false, error: 'invoice_no kosong' }
    if (!['cash', 'transfer', 'qris'].includes(paymentMethod)) return { ok: false, error: 'Metode pembayaran tidak valid' }

    const trxRow = paymentRead(await applyBook(supabase.from('transactions')
      .select('id, invoice_no, customer_id, total, paid, remaining, status, dp, order_status, deleted_at, book_id')
      .eq('invoice_no', invoice_no)).maybeSingle())
    let debtRow = paymentRead(await applyBook(supabase.from('debts').select('*')
      .eq('invoice_no', invoice_no)).maybeSingle())
    if (!debtRow && trxRow) {
      debtRow = paymentRead(await applyBook(supabase.from('debts').select('*')
        .eq('transaction_id', trxRow.id)).maybeSingle())
    }
    // debt_payments.debt_id is NOT NULL; never persist an invoice-only installment.
    if (!debtRow?.id) return { ok: false, error: 'Piutang terkait tidak ditemukan. Pembayaran belum disimpan.' }
    if (trxRow && !trxRow.id) throw new Error('Data invoice tidak valid')
    if (trxRow?.order_status === 'dibatalkan' || debtRow.deleted_at || trxRow?.deleted_at) {
      return { ok: false, error: 'Invoice batal/terhapus tidak dapat menerima pembayaran.' }
    }
    if (debtRow.transaction_id && debtRow.transaction_id !== trxRow?.id) {
      return { ok: false, error: 'Hubungan invoice dan piutang belum dapat dikonfirmasi.' }
    }
    const customerId = trxRow?.customer_id || debtRow.customer_id
    if (trxRow?.customer_id && debtRow.customer_id && trxRow.customer_id !== debtRow.customer_id) {
      return { ok: false, error: 'Customer invoice dan piutang tidak sesuai.' }
    }
    const debtBefore = paymentSnapshot(debtRow.total_debt, debtRow.paid, debtRow.remaining)
    const trxBefore = trxRow && paymentSnapshot(trxRow.total, trxRow.paid, trxRow.remaining)
    if (trxRow && (trxRow.invoice_no !== invoice_no
      || (debtRow.invoice_no && debtRow.invoice_no !== invoice_no)
      || (debtRow.book_id && trxRow.book_id && debtRow.book_id !== trxRow.book_id)
      || trxBefore.total !== debtBefore.total || trxBefore.paid !== debtBefore.paid
      || trxBefore.remaining !== debtBefore.remaining)) {
      return { ok: false, needsReview: true, error: 'Saldo atau identitas invoice dan piutang tidak sesuai. Minta owner memeriksa data; pembayaran belum disimpan.' }
    }
    guard([`debt:${debtRow.id}`, customerId && `customer:${customerId}`])

    const { total, paid: paidBefore } = trxBefore || debtBefore
    const { paid: paidAfter, remaining: remainingAfter } = paymentBalance(total, paidBefore, amount)
    const status = remainingAfter === 0 ? 'lunas' : 'pending'
    const preflight = await recalculateCustomerSummary(customerId, { validateOnly: true })
    if (!preflight.ok) return preflight
    if (trxRow) {
      await write(supabase.from('transactions').update({
        paid: paidAfter, dp: paidAfter, remaining: remainingAfter, status,
      }).eq('id', trxRow.id).select('id').single(), trxRow.id)
    }
    await write(supabase.from('debts').update({
      paid: paidAfter, remaining: remainingAfter, status: remainingAfter === 0 ? 'lunas' : 'aktif',
    }).eq('id', debtRow.id).select('id').single(), debtRow.id)
    const payload = {
      debt_id: debtRow.id, amount, payment_method: paymentMethod, notes,
      cashier: currentUser?.name || currentUser?.username || '',
      cashier_id: currentUser?.id || null, invoice_no, paid_at: new Date().toISOString(),
      ...(debtRow.book_id ? { book_id: debtRow.book_id } : {}),
    }
    await write(supabase.from('debt_payments').insert(payload).select('id').single(), null,
      () => supabase.from('debt_payments').insert(omit(payload, ['invoice_no'])).select('id').single())
    if (customerId) {
      const summary = await recalculateCustomerSummary(customerId)
      if (!summary?.ok) throw new Error('Ringkasan customer belum tersimpan')
    }
    if (!skipRefresh) {
      await Promise.all([refreshTransactions(), refreshDebts(), refreshCustomers(), refreshDebtPayments()])
    }
    return { ok: true, data: { paidAfter, remainingAfter, status, remainingBefore: total - paidBefore, paidBefore } }
  }))
  }, [wrap, containPayment, activeBookId, currentUser, refreshTransactions, refreshDebts, refreshCustomers, refreshDebtPayments, recalculateCustomerSummary, paymentWorkflow])

  // updateTransactionPayment (Order) — DELEGATE ke processDebtPayment.
  // Tidak ada wrap() outer karena processDebtPayment sudah pakai wrap sendiri.
  // Signature lama dipertahankan untuk backward compat: (id, addPayment).
  const updateTransactionPayment = useCallback(async (id, addPayment, paymentMethod = 'cash') => {
    const current = transactions.find(t => t.id === id)
    if (!current) return { ok: false, error: 'Transaksi tidak ditemukan' }
    if (!current.invoiceNo) return { ok: false, error: 'invoice_no kosong' }
    return await processDebtPayment({
      invoice_no: current.invoiceNo,
      paymentAmount: addPayment,
      paymentMethod,
      notes: 'Pembayaran dari halaman Order',
    })
  }, [transactions, processDebtPayment])

  // editTransaction — koreksi data invoice dari Dashboard owner.
  // Field yang bisa diubah: customer, total, discount, paid (DP/dibayar),
  // paymentMethod, dueDate. remaining + status dihitung ulang (integer).
  // Debt terkait di-mirror + customer di-recalc + refresh semua.
  const editTransaction = useCallback(async (id, fields) => wrap(async () => {
    if (secureAuthEnabled) return { ok: false, error: 'Gunakan Edit Invoice untuk mengubah barang. Pembayaran yang sudah diterima tidak dapat ditimpa.' }
    const cur = transactions.find(t => t.id === id)
    if (!cur) return { ok: false, error: 'Transaksi tidak ditemukan' }
    const total = fields.total != null ? Math.round(Number(fields.total) || 0) : Math.round(+cur.total || 0)
    const discount = fields.discount != null ? Math.round(Number(fields.discount) || 0) : Math.round(+cur.discount || 0)
    let paid = fields.paid != null ? Math.round(Number(fields.paid) || 0) : Math.round(+cur.paid || 0)
    if (paid > total) paid = total
    if (paid < 0) paid = 0
    const remaining = Math.max(0, total - paid)
    const status = remaining <= 0 ? 'lunas' : 'pending'
    const upd = {
      total, discount, paid, dp: paid, remaining, status,
      payment_method: fields.paymentMethod ?? cur.paymentMethod,
      customer: fields.customer != null ? String(fields.customer) : cur.customer,
      due_date: fields.dueDate !== undefined ? (fields.dueDate || null) : (cur.dueDate || null),
    }
    // Tanggal transaksi (created_at) opsional — dipakai saat edit pembayaran langsung.
    if (fields.date) upd.created_at = new Date(fields.date).toISOString()
    const { data: row, error } = await supabase
      .from('transactions').update(upd).eq('id', id).select().single()
    if (error) return { ok: false, error: error.message }

    try {
      // Mirror ke debt terkait (kalau ada)
      let debtRow = null
      if (cur.invoiceNo) {
        const r = await supabase.from('debts').select('id').eq('invoice_no', cur.invoiceNo).maybeSingle()
        if (r.error) return incompleteTransactionSync()
        debtRow = r.data
      }
      if (!debtRow) {
        const r2 = await supabase.from('debts').select('id').eq('transaction_id', id).maybeSingle()
        if (r2.error) return incompleteTransactionSync()
        debtRow = r2.data
      }
      if (debtRow) {
        const { error: mirrorError } = await supabase.from('debts').update({
          total_debt: total, paid, remaining,
          status: remaining <= 0 ? 'lunas' : 'aktif',
          due_date: upd.due_date,
        }).eq('id', debtRow.id)
        if (mirrorError) return incompleteTransactionSync()
      }

      if (cur.customerId) {
        const summary = await recalculateCustomerSummary(cur.customerId)
        if (!summary.ok) return incompleteTransactionSync()
      }
      await Promise.all([refreshTransactions(), refreshDebts(), refreshDebtPayments(), refreshCustomers()])
      return { ok: true, data: trxFromDB(row) }
    } catch {
      return incompleteTransactionSync()
    }
  }), [transactions, wrap, recalculateCustomerSummary, refreshTransactions, refreshDebts, refreshDebtPayments, refreshCustomers])

  const deleteTransaction = useCallback(async (id) => wrap(async () => {
    if (secureAuthEnabled) return { ok: false, error: 'Gunakan Hapus Invoice dan pilih alasan penghapusan.' }
    const current = transactions.find(t => t.id === id)
    if (!current) return { ok: false, error: 'Transaksi tidak ditemukan' }
    return containPayment([`transaction:${id}`, current.invoiceNo && `invoice:${current.invoiceNo}`], async ({ guard, write }) => {
      const fresh = paymentRead(await applyBook(supabase.from('transactions').select('*').eq('id', id)).maybeSingle())
      if (!fresh || fresh.id !== id) return { ok: false, error: 'Transaksi tidak ditemukan' }
      let debt = paymentRead(await supabase.from('debts').select('*').eq('transaction_id', id).maybeSingle())
      if (!debt && fresh.invoice_no) {
        debt = paymentRead(await supabase.from('debts').select('*').eq('invoice_no', fresh.invoice_no).maybeSingle())
      }
      const allowed = await destructivePaymentCheck(fresh, debt)
      if (!allowed.ok) return allowed
      guard([fresh.invoice_no && `invoice:${fresh.invoice_no}`, fresh.customer_id && `customer:${fresh.customer_id}`,
        debt?.id && `debt:${debt.id}`])
      const preflight = await recalculateCustomerSummary(fresh.customer_id, { validateOnly: true })
      if (!preflight.ok) return preflight
      await write(supabase.from('transactions').delete().eq('id', id).select('id').single(), id)
      if (fresh.customer_id && !(await recalculateCustomerSummary(fresh.customer_id))?.ok) {
        throw new Error('Ringkasan customer belum tersimpan')
      }
      if (mounted.current) setTransactions(prev => prev.filter(t => t.id !== id))
      await Promise.all([refreshTransactions(), refreshDebts(), refreshDebtPayments(), refreshCustomers()])
      return { ok: true }
    })
  }), [transactions, activeBookId, wrap, containPayment, destructivePaymentCheck, recalculateCustomerSummary, refreshTransactions, refreshDebts, refreshDebtPayments, refreshCustomers])

  // ---------- DEBTS ----------
  // Legacy signatures delegate to the same non-atomic, guarded payment callback.
  const payDebt = useCallback(async (debtId, amount, paymentMethod = 'cash', notes = '') => {
    try {
      const amt = paymentMoney(amount)
      if (amt <= 0) return { ok: false, error: 'Nominal pembayaran harus lebih dari 0' }
      const debt = paymentRead(await supabase.from('debts')
        .select('id, invoice_no, transaction_id, customer_id').eq('id', debtId).maybeSingle())
      if (!debt?.id) return { ok: false, error: 'Hutang tidak ditemukan' }
      let invoiceNo = debt.invoice_no
      if (!invoiceNo && debt.transaction_id) {
        const trx = paymentRead(await supabase.from('transactions').select('invoice_no')
          .eq('id', debt.transaction_id).maybeSingle())
        invoiceNo = trx?.invoice_no
      }
      if (!invoiceNo) return { ok: false, error: 'invoice_no kosong di debt + transaction' }
      return await processDebtPayment({ invoice_no: invoiceNo, paymentAmount: amt, paymentMethod, notes })
    } catch (error) {
      return { ok: false, needsReconciliation: false, error: error.message || 'Data piutang belum dapat diperiksa' }
    }
  }, [processDebtPayment])

  // ═══════════════════════════════════════════════════════════════════
  // payCustomerDebtsFIFO — pembayaran GABUNGAN untuk semua hutang 1 customer.
  // Alokasi memakai FIFO: invoice paling lama (created_at ASC) dilunasi dulu.
  //   • Uang dialokasikan per invoice (Math.min(sisaUang, sisaInvoice)).
  //   • Tiap invoice yang kebagian → 1 INSERT debt_payments (lewat
  //     processDebtPayment, jadi debts + transactions + customers ikut update).
  //   • Refresh state lokal HANYA sekali di akhir (skipRefresh per-invoice).
  //   • Clamp: kalau nominal > total sisa hutang customer, dipotong ke total.
  // ═══════════════════════════════════════════════════════════════════
  const payCustomerDebtsFIFO = useCallback(async ({
    customerId, amount, paymentMethod = 'cash', notes = '',
  }) => wrap(async () => {
    const results = []
    let paid = 0
    const stop = (result) => {
      const needsReconciliation = paid > 0 || !!result.needsReconciliation
      if (needsReconciliation) {
        if (secureAuthEnabled) {
          secureFifoBlocks.current.add(customerId)
          if (paid > 0 || result.committed) { paymentRefreshNeeded.current = true; setPaymentRefreshPending(true) }
        } else paymentOperations.current.blocked.add(`customer:${customerId}`)
      }
      return { ...result, ...(needsReconciliation ? incompleteTransactionSync() : {}),
        ok: false, needsReconciliation, paid, results }
    }
    try {
      let pay = paymentMoney(amount)
      if (pay <= 0) return stop({ error: 'Nominal pembayaran harus lebih dari 0' })
      if (!customerId) return stop({ error: 'Customer tidak valid' })
      if (secureAuthEnabled ? secureFifoBlocks.current.has(customerId) : paymentOperations.current.blocked.has(`customer:${customerId}`)) return stop(incompleteTransactionSync())
      // Fresh balances and ordering, not the potentially stale page snapshot.
      const rows = paymentRead(await applyBook(supabase.from('debts').select('*')
        .eq('customer_id', customerId).is('deleted_at', null).order('created_at', { ascending: true })))
      if (!Array.isArray(rows)) throw new Error('Daftar piutang belum dapat diperiksa')
      const list = rows.map(d => ({ ...d, balance: paymentSnapshot(d.total_debt, d.paid, d.remaining) }))
        .filter(d => d.balance.remaining > 0)
      if (!list.length) return stop({ error: 'Tidak ada hutang aktif untuk customer ini' })
      const totalRemaining = list.reduce((s, d) => s + d.balance.remaining, 0)
      pay = Math.min(pay, totalRemaining)
      for (const debt of list) {
        if (paid >= pay) break
        const alloc = Math.min(pay - paid, debt.balance.remaining)
        let inv = debt.invoice_no
        if (!inv && debt.transaction_id) {
          inv = paymentRead(await applyBook(supabase.from('transactions').select('invoice_no')
            .eq('id', debt.transaction_id)).maybeSingle())?.invoice_no
        }
        if (!inv) {
          const failure = { debtId: debt.id, alloc, ok: false, error: 'invoice_no kosong' }
          results.push(failure)
          return stop(failure)
        }
        const result = await processDebtPayment({
          invoice_no: inv, paymentAmount: alloc, paymentMethod,
          notes: notes || 'Pembayaran gabungan (FIFO)', skipRefresh: true,
        })
        results.push({ ...result, debtId: debt.id, invoiceNo: inv, alloc })
        if (!result?.ok) return stop(result || incompleteTransactionSync())
        paid += alloc
      }
      await Promise.all([refreshTransactions(), refreshDebts(), refreshCustomers(), refreshDebtPayments()])
      return { ok: true, paid, results }
    } catch (error) {
      return stop({ error: error.message || 'Pembayaran gabungan belum selesai' })
    }
  }), [activeBookId, processDebtPayment, refreshTransactions, refreshDebts, refreshCustomers, refreshDebtPayments, wrap])

  const deleteDebt = useCallback(async (id) => wrap(async () => {
    const debt = debts.find(d => d.id === id)
    return containPayment([`debt:${id}`, debt?.invoiceNo && `invoice:${debt.invoiceNo}`,
      debt?.customerId && `customer:${debt.customerId}`], async ({ guard, write }) => {
      const fresh = paymentRead(await applyBook(supabase.from('debts').select('*').eq('id', id)).maybeSingle())
      if (!fresh || fresh.id !== id) return { ok: false, error: 'Piutang tidak ditemukan' }
      let trx = null
      if (fresh.transaction_id) {
        trx = paymentRead(await supabase.from('transactions').select('*').eq('id', fresh.transaction_id).maybeSingle())
        if (!trx || trx.id !== fresh.transaction_id) return { ok: false, needsReview: true, error: 'Invoice terkait tidak ditemukan. Penghapusan belum disimpan.' }
      }
      const allowed = await destructivePaymentCheck(trx, fresh)
      if (!allowed.ok) return allowed
      guard([fresh.invoice_no && `invoice:${fresh.invoice_no}`, fresh.customer_id && `customer:${fresh.customer_id}`])
      const preflight = await recalculateCustomerSummary(fresh.customer_id, { validateOnly: true })
      if (!preflight.ok) return preflight
      await write(supabase.from('debts').delete().eq('id', id).select('id').single(), id)
      if (fresh.customer_id && !(await recalculateCustomerSummary(fresh.customer_id))?.ok) {
        throw new Error('Ringkasan customer belum tersimpan')
      }
      if (mounted.current) setDebts(prev => prev.filter(d => d.id !== id))
      await Promise.all([refreshDebts(), refreshDebtPayments(), refreshCustomers()])
      return { ok: true }
    })
  }), [debts, activeBookId, wrap, containPayment, destructivePaymentCheck, recalculateCustomerSummary, refreshDebts, refreshDebtPayments, refreshCustomers])

  const getDebtPayments = useCallback(async (debtId) => {
    const { data, error: e } = await supabase
      .from('debt_payments').select('*').eq('debt_id', debtId).is('deleted_at', null).order('paid_at', { ascending: true })
    if (e) return { ok: false, error: e.message, data: [] }
    return { ok: true, data: data || [] }
  }, [])

  // Preflight every linked balance before changing history. Delta preserves the
  // original DP; no clamping a correction into a different receipt amount.
  const correctDebtPayment = useCallback(async (paymentId, fields = {}, remove = false) =>
    wrap(() => containPayment([paymentId && `payment:${paymentId}`], async ({ guard, write }) => {
      if (!paymentId) return { ok: false, error: 'Pembayaran tidak ditemukan' }
      const pay = paymentRead(await supabase.from('debt_payments')
        .select('id, debt_id, invoice_no, amount, payment_method, paid_at, cashier_id, notes, deleted_at')
        .eq('id', paymentId).maybeSingle())
      if (!pay?.id || pay.deleted_at) return { ok: false, error: 'Pembayaran tidak ditemukan atau sudah dihapus' }
      const oldAmount = paymentMoney(pay.amount)
      const newAmount = remove ? 0 : paymentMoney(fields.amount !== undefined ? fields.amount : oldAmount)
      if (oldAmount <= 0 || (!remove && newAmount <= 0)) {
        return { ok: false, error: 'Nominal koreksi harus lebih dari 0 dan berupa angka valid' }
      }
      const delta = newAmount - oldAmount
      let debt = null, trx = null, debtBalance = null, trxBalance = null
      if (pay.debt_id) {
        debt = paymentRead(await supabase.from('debts').select('*').eq('id', pay.debt_id).maybeSingle())
        if (!debt?.id) return { ok: false, error: 'Piutang terkait tidak ditemukan. Koreksi belum disimpan.' }
      }
      const invoiceNo = pay.invoice_no || debt?.invoice_no
      guard([invoiceNo && `invoice:${invoiceNo}`, pay.debt_id && `debt:${pay.debt_id}`])
      if (invoiceNo) {
        trx = paymentRead(await supabase.from('transactions').select('*').eq('invoice_no', invoiceNo).maybeSingle())
      } else if (debt?.transaction_id) {
        trx = paymentRead(await supabase.from('transactions').select('*').eq('id', debt.transaction_id).maybeSingle())
      }
      if ((!debt && !trx?.id) || (debt?.transaction_id && trx?.id !== debt.transaction_id)) {
        return { ok: false, error: 'Hubungan pembayaran, piutang, dan invoice belum dapat dikonfirmasi.' }
      }
      if (trx?.order_status === 'dibatalkan' || trx?.deleted_at || debt?.deleted_at) {
        return { ok: false, error: 'Koreksi invoice batal/terhapus memerlukan pemeriksaan terlebih dahulu.' }
      }
      const debtBefore = debt && paymentSnapshot(debt.total_debt, debt.paid, debt.remaining)
      const trxBefore = trx && paymentSnapshot(trx.total, trx.paid, trx.remaining)
      if (pay.id !== paymentId || (pay.debt_id && debt?.id !== pay.debt_id)
        || (pay.invoice_no && debt?.invoice_no && pay.invoice_no !== debt.invoice_no)
        || (trx && invoiceNo && trx.invoice_no !== invoiceNo)
        || (debt && trx && (debt.customer_id !== trx.customer_id
          || debtBefore.total !== trxBefore.total || debtBefore.paid !== trxBefore.paid
          || debtBefore.remaining !== trxBefore.remaining))) {
        return { ok: false, needsReview: true, error: 'Saldo atau identitas pembayaran, piutang, dan invoice tidak sesuai. Minta owner memeriksa data; koreksi belum disimpan.' }
      }
      if (fields.paymentMethod !== undefined && !['cash', 'transfer', 'qris'].includes(fields.paymentMethod)) {
        return { ok: false, error: 'Metode pembayaran tidak valid' }
      }
      const history = paymentRead(await supabase.from('debt_payments').select('id, amount')
        .eq(pay.debt_id ? 'debt_id' : 'invoice_no', pay.debt_id || invoiceNo).is('deleted_at', null))
      if (!Array.isArray(history)) throw new Error('Riwayat pembayaran belum dapat diperiksa')
      const historyTotal = history.reduce((sum, row) => sum + paymentMoney(row.amount), 0)
      const rawHistoryTotal = history.reduce((sum, row) => sum + Number(row.amount), 0)
      if (!history.some(row => row.id === paymentId) || !Number.isSafeInteger(historyTotal)
        || (debt && (historyTotal > debtBefore.paid || rawHistoryTotal - Number(debt.paid) >= 1))
        || (trx && (historyTotal > trxBefore.paid || rawHistoryTotal - Number(trx.paid) >= 1))) {
        return { ok: false, needsReview: true, error: 'Riwayat pembayaran melebihi saldo dibayar atau belum lengkap. Minta owner memeriksa data; koreksi belum disimpan.' }
      }
      const customerId = debt?.customer_id || trx?.customer_id
      guard([trx?.invoice_no && `invoice:${trx.invoice_no}`, customerId && `customer:${customerId}`])
      if (debt) debtBalance = paymentBalance(debtBefore.total, debtBefore.paid, delta)
      if (trx) trxBalance = paymentBalance(trxBefore.total, trxBefore.paid, delta)
      const preflight = await recalculateCustomerSummary(customerId, { validateOnly: true })
      if (!preflight.ok) return preflight
      if (remove) {
        await write(supabase.from('debt_payments').delete().eq('id', paymentId).select('id').single(), paymentId)
      } else {
        const updates = {
          payment_method: fields.paymentMethod ?? pay.payment_method, amount: newAmount,
          paid_at: fields.paidAt ? new Date(fields.paidAt).toISOString() : pay.paid_at,
          cashier_id: fields.cashierId !== undefined ? (fields.cashierId || null) : pay.cashier_id,
        }
        if (fields.notes !== undefined) updates.notes = String(fields.notes || '')
        await write(supabase.from('debt_payments').update(updates).eq('id', paymentId).select('id').single(), paymentId)
      }
      if (delta !== 0) {
        if (debt) {
          await write(supabase.from('debts').update({
            ...debtBalance, status: debtBalance.remaining === 0 ? 'lunas' : 'aktif',
          }).eq('id', debt.id).select('id').single(), debt.id)
        }
        if (trx) {
          await write(supabase.from('transactions').update({
            ...trxBalance, dp: trxBalance.paid, status: trxBalance.remaining === 0 ? 'lunas' : 'pending',
          }).eq('id', trx.id).select('id').single(), trx.id)
        }
        if (customerId && !(await recalculateCustomerSummary(customerId))?.ok) {
          throw new Error('Ringkasan customer belum tersimpan')
        }
      }
      await Promise.all([refreshTransactions(), refreshDebts(), refreshDebtPayments(), refreshCustomers()])
      return { ok: true }
    })), [wrap, containPayment, recalculateCustomerSummary, refreshTransactions, refreshDebts, refreshDebtPayments, refreshCustomers])

  const editDebtPayment = useCallback((paymentId, fields) =>
    correctDebtPayment(paymentId, fields), [correctDebtPayment])
  const deleteDebtPayment = useCallback((paymentId) =>
    correctDebtPayment(paymentId, {}, true), [correctDebtPayment])

  // ---------- STATS ----------
  const stats = useMemo(() => {
    const today = new Date().toDateString()
    const now = new Date()
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
    const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1)

    const todayTrx = transactions.filter(t => new Date(t.date).toDateString() === today)
    const monthTrx = transactions.filter(t => new Date(t.date) >= monthStart && new Date(t.date) < nextMonth)

    // OMZET = total NILAI seluruh invoice valid (Cash/Transfer/QRIS/Hutang/DP/
    // Cicilan), TANPA melihat sudah dibayar atau belum. Hanya transaksi batal
    // ('dibatalkan') yang dikecualikan; nota terhapus sudah lenyap dari data.
    // (BUKAN SUM(paid) dan BUKAN hanya status 'lunas'.)
    const notCanceled = (t) => !inactiveFinancialInvoice(t)
    // Pemasukkan Credibook → HANYA jenis 'omzet' yang menambah Omset (book-scoped).
    // (refund/capital/other = kas masuk saja, dihitung di Accounting, bukan Omset.)
    const cbAmt = (x) => Math.round(+x.amount || 0)
    const cbDate = (x) => new Date(x.transaction_date)
    const cbOmzet = credibookIncome.filter(x => (x.income_type || 'omzet') === 'omzet')
    const cbToday = cbOmzet.filter(x => cbDate(x).toDateString() === today)
    const cbMonth = cbOmzet.filter(x => cbDate(x) >= monthStart && cbDate(x) < nextMonth)
    const cbTotalSum = cbOmzet.reduce((s, x) => s + cbAmt(x), 0)
    const cbTodaySum = cbToday.reduce((s, x) => s + cbAmt(x), 0)
    const cbMonthSum = cbMonth.reduce((s, x) => s + cbAmt(x), 0)
    const totalOmzet = transactions.filter(notCanceled).reduce((s, t) => s + (+t.total || 0), 0) + cbTotalSum
    const todayOmzet = todayTrx.filter(notCanceled).reduce((s, t) => s + (+t.total || 0), 0) + cbTodaySum
    const monthOmzet = monthTrx.filter(notCanceled).reduce((s, t) => s + (+t.total || 0), 0) + cbMonthSum
    const pendingCount = transactions.filter(t => t.status === 'pending').length
    const procesCount = transactions.filter(t => t.status === 'proses').length
    const todayOrders = todayTrx.length
    const monthOrders = monthTrx.length

    const productSales = {}
    transactions.filter(notCanceled).forEach(t => t.items.forEach(i => {
      productSales[i.productId] = (productSales[i.productId] || 0) + i.qty
    }))
    const topProducts = products
      .map(p => ({ ...p, sold: productSales[p.id] || 0 }))
      .sort((a, b) => b.sold - a.sold).slice(0, 5)

    const chartData = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(); d.setDate(d.getDate() - (6 - i))
      const ds = d.toDateString()
      const dayTrx = transactions.filter(t => notCanceled(t) && new Date(t.date).toDateString() === ds)
      const dayCb = credibookIncome.filter(x => (x.income_type || 'omzet') === 'omzet' && new Date(x.transaction_date).toDateString() === ds)
      return {
        day: d.toLocaleDateString('id-ID', { weekday: 'short' }),
        date: d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short' }),
        omzet: dayTrx.reduce((s, t) => s + (+t.total || 0), 0)
          + dayCb.reduce((s, x) => s + Math.round(+x.amount || 0), 0),
        transaksi: dayTrx.length,
      }
    })

    const categoryRevenue = {}
    transactions.filter(notCanceled).forEach(t => t.items.forEach(item => {
      const p = products.find(x => x.id === item.productId)
      if (!p) return
      categoryRevenue[p.category] = (categoryRevenue[p.category] || 0) + (item.qty * item.price)
    }))
    const categoryData = Object.entries(categoryRevenue).map(([name, value]) => ({ name, value }))

    // Customer + debt stats
    const activeDebts = debts.filter(d => d.status === 'aktif')
    const totalActiveDebt = activeDebts.reduce((s, d) => s + d.remaining, 0)
    const totalPaidDebt = debts.filter(d => d.status === 'lunas').reduce((s, d) => s + d.totalDebt, 0)
    const topDebtors = (() => {
      const map = new Map()
      activeDebts.forEach(d => {
        const c = customers.find(x => x.id === d.customerId)
        if (!c) return
        const cur = map.get(c.id) || { ...c, count: 0, totalRemaining: 0 }
        cur.count += 1
        cur.totalRemaining += d.remaining
        map.set(c.id, cur)
      })
      return [...map.values()].sort((a, b) => b.totalRemaining - a.totalRemaining).slice(0, 5)
    })()

    // Top customer (most active)
    const topCustomers = (() => {
      const map = new Map()
      transactions.forEach(t => {
        if (!t.customerId) return
        const c = customers.find(x => x.id === t.customerId)
        if (!c) return
        const cur = map.get(c.id) || { ...c, orderCount: 0, totalSpent: 0 }
        cur.orderCount += 1
        cur.totalSpent += +t.total || 0
        map.set(c.id, cur)
      })
      return [...map.values()].sort((a, b) => b.totalSpent - a.totalSpent).slice(0, 5)
    })()

    return {
      totalOmzet, todayOmzet, monthOmzet,
      todayOrders, monthOrders,
      pendingCount, procesCount,
      customers: customers.length, totalCustomers: customers.length,
      topProducts, chartData, todayTrx, monthTrx, categoryData,
      totalTransactions: transactions.length,
      totalActiveDebt, totalPaidDebt, activeDebtsCount: activeDebts.length,
      topDebtors, topCustomers,
    }
  }, [transactions, products, customers, debts, credibookIncome])

  return {
    loading, busy, error,
    products, transactions, storeInfo, stats,
    admins, currentUser, customers, debts, debtPayments,
    books, activeBookId, defaultBookId, setActiveBook, addBook, updateBook,
    adminBankAccounts, refreshBankAccounts, bankAccountForAdmin, addBankAccount, updateBankAccount, deleteBankAccount,
    storeLocations, storeContacts, storeBankAccounts, adminInvoiceProfiles, refreshMasterData, invoiceProfileForAdmin,
    addLocation, updateLocation, deleteLocation,
    addContact, updateContact, deleteContact,
    addStoreBank, updateStoreBank, deleteStoreBank,
    setAdminInvoiceProfile,
    credibookIncome, refreshCredibook, getTransactionByInvoice,
    refreshAll, refreshCustomers, refreshDebts, refreshTransactions, refreshDebtPayments,
    syncDebtPaymentStatus, recalculateCustomerSummary, processDebtPayment,
    addProduct, updateProduct, deleteProduct, setProductFavorite,
    addTransaction, updateTransactionStatus, updateTransactionPayment, deleteTransaction, editTransaction,
    invoiceWorkflow, invoiceRevision, pendingInvoiceChanges, paymentWorkflow, pendingPayments, paymentRefreshPending,
    updateOrderStatus,
    updateStoreInfo, updateLogo,
    login, logout, addAdmin, updateAdmin, deleteAdmin, changePassword, reassignAdminCustomers,
    addCustomer, updateCustomer, deleteCustomer,
    reassignReceivableCustomer, reassignOrderCustomer,
    getOrderCustomerChanges, getReceivableCustomerChanges,
    payDebt, payCustomerDebtsFIFO, deleteDebt, getDebtPayments,
    editDebtPayment, deleteDebtPayment,
  }
}
