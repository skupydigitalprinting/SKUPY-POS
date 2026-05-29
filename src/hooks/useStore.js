import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { supabase, isSupabaseConfigured, uploadLogo, deleteLogo } from '../lib/supabase'

// Session persistence — keep user logged in across browser refresh.
// Uses localStorage to remember the admin id; on init, we re-fetch from
// Supabase to validate the session is still valid (admin still exists).
const SESSION_KEY = 'skupy_session_v2'

function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY)
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}

function saveSession(user) {
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(user)) } catch {}
}

function clearSession() {
  try { localStorage.removeItem(SESSION_KEY) } catch {}
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

const adminFromDB = (r) => ({
  id: r.id, username: r.username, password: r.password,
  name: r.name || r.username, role: r.role || 'staff',
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
  description: r.description || '', image: r.image || '',
})

const productToDB = (p) => ({
  name: p.name, category: p.category,
  price: Number(p.price) || 0, modal: Number(p.modal) || 0, stock: Number(p.stock) || 0,
  description: p.description || '', image: p.image || '',
})

const trxFromDB = (r) => ({
  id: r.id,
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
  cashierId: r.cashier_id,
  date: r.created_at,
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

export function useStore() {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [products, setProducts] = useState([])
  const [transactions, setTransactions] = useState([])
  const [storeInfo, setStoreInfo] = useState(null)
  const [admins, setAdmins] = useState([])
  const [customers, setCustomers] = useState([])
  const [debts, setDebts] = useState([])
  const [currentUser, setCurrentUser] = useState(() => loadSession())
  const mounted = useRef(true)

  useEffect(() => () => { mounted.current = false }, [])

  const refreshAll = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const [s, a, p, t, c, d] = await Promise.all([
        supabase.from('settings').select('*').eq('id', 1).maybeSingle(),
        supabase.from('admins').select('*').order('created_at', { ascending: true }),
        supabase.from('products').select('*').order('created_at', { ascending: false }),
        supabase.from('transactions').select('*').order('created_at', { ascending: false }),
        supabase.from('customers').select('*').order('created_at', { ascending: false }),
        supabase.from('debts').select('*').order('created_at', { ascending: false }),
      ])
      for (const r of [s, a, p, t, c, d]) if (r.error) throw r.error
      if (!mounted.current) return
      setStoreInfo(settingsFromDB(s.data) || {
        name: 'Skupy Printing', tagline: '', address: '', phone: '', email: '',
        bank: { name: '', number: '', holder: '' },
        frontLogo: '', invoiceLogo: '', taxRate: 0,
      })
      const allAdmins = (a.data || []).map(adminFromDB)
      setAdmins(allAdmins)
      // Validate restored session: if user no longer exists, clear it
      const restored = loadSession()
      if (restored?.id && !allAdmins.find(x => x.id === restored.id)) {
        clearSession()
        if (mounted.current) setCurrentUser(null)
      }
      setProducts((p.data || []).map(productFromDB))
      setTransactions((t.data || []).map(trxFromDB))
      setCustomers((c.data || []).map(customerFromDB))
      setDebts((d.data || []).map(debtFromDB))
    } catch (e) {
      if (mounted.current) setError(
        isSupabaseConfigured
          ? `Gagal terhubung ke Supabase: ${e.message || e}`
          : 'Supabase belum dikonfigurasi. Buat file .env dari .env.example.'
      )
    } finally {
      if (mounted.current) setLoading(false)
    }
  }, [])

  useEffect(() => { refreshAll() }, [refreshAll])

  // Realtime subscriptions (optional — refresh on insert/update/delete)
  useEffect(() => {
    if (!isSupabaseConfigured) return
    const channel = supabase.channel('skupy-pos-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'customers' }, () => refreshCustomers())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'debts' }, () => refreshDebts())
      .subscribe()
    return () => { supabase.removeChannel(channel) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const refreshCustomers = useCallback(async () => {
    const { data, error: e } = await supabase.from('customers').select('*').order('created_at', { ascending: false })
    if (!e && mounted.current) setCustomers((data || []).map(customerFromDB))
  }, [])

  const refreshDebts = useCallback(async () => {
    const { data, error: e } = await supabase.from('debts').select('*').order('created_at', { ascending: false })
    if (!e && mounted.current) setDebts((data || []).map(debtFromDB))
  }, [])

  const wrap = useCallback(async (fn) => {
    setBusy(true)
    try { return await fn() }
    finally { if (mounted.current) setBusy(false) }
  }, [])

  // ---------- AUTH ----------
  const login = useCallback(async (username, password) => wrap(async () => {
    const u = (username || '').trim().toLowerCase()
    if (!u || !password) return { ok: false, error: 'Username & password wajib diisi' }
    const { data, error: e } = await supabase
      .from('admins').select('*').eq('username', u).eq('password', password).maybeSingle()
    if (e) return { ok: false, error: e.message }
    if (!data) return { ok: false, error: 'Username atau password salah' }
    const user = { id: data.id, username: data.username, name: data.name || data.username, role: data.role }
    setCurrentUser(user)
    saveSession(user)
    return { ok: true }
  }), [wrap])

  const logout = useCallback(() => {
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
        if (oldUrl) { try { await deleteLogo(oldUrl) } catch {} }
        if (mounted.current) setStoreInfo(next)
        return { ok: true }
      }
      const url = await uploadLogo(fileOrEmpty, logoType)
      const next = { ...storeInfo, [logoType]: url }
      const { error: e } = await supabase.from('settings').upsert({ id: 1, ...settingsToDB(next) })
      if (e) return { ok: false, error: e.message }
      if (mounted.current) setStoreInfo(next)
      return { ok: true }
    } catch (err) { return { ok: false, error: err.message || String(err) } }
  }), [storeInfo, wrap])

  // ---------- ADMINS ----------
  const addAdmin = useCallback(async (data) => wrap(async () => {
    const u = (data.username || '').trim().toLowerCase()
    if (!u) return { ok: false, error: 'Username wajib diisi' }
    if (!data.password || data.password.length < 4) return { ok: false, error: 'Password minimal 4 karakter' }
    const { data: inserted, error: e } = await supabase.from('admins')
      .insert({ username: u, password: data.password, name: data.name || u, role: data.role || 'staff' })
      .select().single()
    if (e) {
      if (String(e.message).includes('duplicate')) return { ok: false, error: 'Username sudah dipakai' }
      return { ok: false, error: e.message }
    }
    if (mounted.current) setAdmins(prev => [...prev, adminFromDB(inserted)])
    return { ok: true }
  }), [wrap])

  const deleteAdmin = useCallback(async (id) => wrap(async () => {
    if (admins.length <= 1) return { ok: false, error: 'Minimal harus ada 1 admin' }
    if (currentUser?.id === id) return { ok: false, error: 'Tidak bisa menghapus diri sendiri' }
    const { error: e } = await supabase.from('admins').delete().eq('id', id)
    if (e) return { ok: false, error: e.message }
    if (mounted.current) setAdmins(prev => prev.filter(a => a.id !== id))
    return { ok: true }
  }), [admins, currentUser, wrap])

  const changePassword = useCallback(async (oldPass, newPass) => wrap(async () => {
    if (!currentUser) return { ok: false, error: 'Belum login' }
    if (!newPass || newPass.length < 4) return { ok: false, error: 'Password baru minimal 4 karakter' }
    const { data: me, error: e1 } = await supabase.from('admins').select('id, password').eq('id', currentUser.id).single()
    if (e1) return { ok: false, error: e1.message }
    if (me.password !== oldPass) return { ok: false, error: 'Password lama salah' }
    const { error: e2 } = await supabase.from('admins').update({ password: newPass }).eq('id', currentUser.id)
    if (e2) return { ok: false, error: e2.message }
    if (mounted.current) setAdmins(prev => prev.map(a => a.id === currentUser.id ? { ...a, password: newPass } : a))
    return { ok: true }
  }), [currentUser, wrap])

  // ---------- CUSTOMERS ----------
  const addCustomer = useCallback(async (data) => wrap(async () => {
    if (!data.name?.trim()) return { ok: false, error: 'Nama wajib diisi' }
    const { data: row, error: e } = await supabase.from('customers').insert(customerToDB(data)).select().single()
    if (e) return { ok: false, error: e.message }
    if (mounted.current) setCustomers(prev => [customerFromDB(row), ...prev])
    return { ok: true, data: customerFromDB(row) }
  }), [wrap])

  const updateCustomer = useCallback(async (id, data) => wrap(async () => {
    const { data: row, error: e } = await supabase.from('customers').update(customerToDB(data)).eq('id', id).select().single()
    if (e) return { ok: false, error: e.message }
    if (mounted.current) setCustomers(prev => prev.map(c => c.id === id ? customerFromDB(row) : c))
    return { ok: true }
  }), [wrap])

  const deleteCustomer = useCallback(async (id) => wrap(async () => {
    const { error: e } = await supabase.from('customers').delete().eq('id', id)
    if (e) return { ok: false, error: e.message }
    if (mounted.current) setCustomers(prev => prev.filter(c => c.id !== id))
    return { ok: true }
  }), [wrap])

  // ---------- PRODUCTS ----------
  const addProduct = useCallback(async (data) => wrap(async () => {
    const { data: row, error: e } = await supabase.from('products').insert(productToDB(data)).select().single()
    if (e) return { ok: false, error: e.message }
    if (mounted.current) setProducts(prev => [productFromDB(row), ...prev])
    return { ok: true }
  }), [wrap])

  const updateProduct = useCallback(async (id, data) => wrap(async () => {
    const { data: row, error: e } = await supabase.from('products').update(productToDB(data)).eq('id', id).select().single()
    if (e) return { ok: false, error: e.message }
    if (mounted.current) setProducts(prev => prev.map(p => p.id === id ? productFromDB(row) : p))
    return { ok: true }
  }), [wrap])

  const deleteProduct = useCallback(async (id) => wrap(async () => {
    const { error: e } = await supabase.from('products').delete().eq('id', id)
    if (e) return { ok: false, error: e.message }
    if (mounted.current) setProducts(prev => prev.filter(p => p.id !== id))
    return { ok: true }
  }), [wrap])

  // ---------- TRANSACTIONS ----------
  const nextInvoiceNumber = useCallback(async () => {
    const year = new Date().getFullYear()
    const { count } = await supabase
      .from('transactions').select('*', { count: 'exact', head: true })
      .like('invoice_no', `INV-${year}-%`)
    return `INV-${year}-${String((count || 0) + 1).padStart(4, '0')}`
  }, [])

  const nextOrderNumber = useCallback(async () => {
    const year = new Date().getFullYear()
    const { count } = await supabase
      .from('transactions').select('*', { count: 'exact', head: true })
      .like('order_no', `ORD-${year}-%`)
    return `ORD-${year}-${String((count || 0) + 1).padStart(4, '0')}`
  }, [])

  const addTransaction = useCallback(async (trx) => wrap(async () => {
    try {
      const [invoiceNo, orderNo] = await Promise.all([
        nextInvoiceNumber(),
        nextOrderNumber(),
      ])
      const cashier = currentUser?.name || currentUser?.username || ''
      const cashierId = currentUser?.id || null
      const nowIso = new Date().toISOString()
      const statusHistory = [{
        order_status: trx.orderStatus || 'menunggu',
        changed_at: nowIso,
        changed_by: cashier || 'system',
      }]
      const payload = trxToDB({
        ...trx,
        invoiceNo, orderNo,
        cashier, cashierId,
        statusHistory,
        orderStatus: trx.orderStatus || 'menunggu',
      })
      const { data: row, error: e } = await supabase.from('transactions').insert(payload).select().single()
      if (e) return { ok: false, error: e.message }

      // Decrement stock
      await Promise.all(trx.items.map(async (item) => {
        const p = products.find(x => x.id === item.productId)
        if (!p) return
        await supabase.from('products').update({ stock: Math.max(0, p.stock - item.qty) }).eq('id', item.productId)
      }))

      // If "Hutang", create a debt row
      if (trx.paymentMethod === 'hutang' && trx.customerId) {
        await supabase.from('debts').insert({
          customer_id: trx.customerId,
          transaction_id: row.id,
          invoice_no: invoiceNo,
          total_debt: +trx.remaining || +trx.total || 0,
          paid: 0,
          remaining: +trx.remaining || +trx.total || 0,
          due_date: trx.dueDate || null,
          status: 'aktif',
          notes: trx.notes || '',
        })
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
      // Refresh customer stats (driven by trigger)
      if (trx.customerId) await refreshCustomers()
      return { ok: true, data: newTrx }
    } catch (err) { return { ok: false, error: err.message || String(err) } }
  }), [products, currentUser, wrap, nextInvoiceNumber, nextOrderNumber, refreshCustomers, refreshDebts])

  const updateOrderStatus = useCallback(async (id, newStatus) => wrap(async () => {
    const current = transactions.find(t => t.id === id)
    if (!current) return { ok: false, error: 'Transaksi tidak ditemukan' }
    const cashier = currentUser?.name || currentUser?.username || 'system'
    const newHistory = [
      ...(current.statusHistory || []),
      {
        order_status: newStatus,
        changed_at: new Date().toISOString(),
        changed_by: cashier,
        from: current.orderStatus || 'menunggu',
      },
    ]
    const { data: row, error: e } = await supabase
      .from('transactions')
      .update({ order_status: newStatus, status_history: newHistory })
      .eq('id', id).select().single()
    if (e) return { ok: false, error: e.message }
    if (mounted.current) setTransactions(prev => prev.map(t => t.id === id ? trxFromDB(row) : t))
    return { ok: true }
  }), [transactions, currentUser, wrap])

  const updateTransactionStatus = useCallback(async (id, status) => wrap(async () => {
    const current = transactions.find(t => t.id === id)
    if (!current) return { ok: false, error: 'Transaksi tidak ditemukan' }
    const updates = { status }
    if (status === 'lunas') { updates.paid = current.total; updates.dp = current.total; updates.remaining = 0 }
    const { data: row, error: e } = await supabase.from('transactions').update(updates).eq('id', id).select().single()
    if (e) return { ok: false, error: e.message }
    if (mounted.current) setTransactions(prev => prev.map(t => t.id === id ? trxFromDB(row) : t))
    return { ok: true }
  }), [transactions, wrap])

  const updateTransactionPayment = useCallback(async (id, addPayment) => wrap(async () => {
    const current = transactions.find(t => t.id === id)
    if (!current) return { ok: false, error: 'Transaksi tidak ditemukan' }
    const newPaid = Math.min(current.total, current.paid + Number(addPayment))
    const remaining = current.total - newPaid
    const updates = { paid: newPaid, dp: newPaid, remaining, status: remaining === 0 ? 'lunas' : current.status }
    const { data: row, error: e } = await supabase.from('transactions').update(updates).eq('id', id).select().single()
    if (e) return { ok: false, error: e.message }
    if (mounted.current) setTransactions(prev => prev.map(t => t.id === id ? trxFromDB(row) : t))
    return { ok: true }
  }), [transactions, wrap])

  const deleteTransaction = useCallback(async (id) => wrap(async () => {
    const { error: e } = await supabase.from('transactions').delete().eq('id', id)
    if (e) return { ok: false, error: e.message }
    if (mounted.current) setTransactions(prev => prev.filter(t => t.id !== id))
    return { ok: true }
  }), [wrap])

  // ---------- DEBTS ----------
  const payDebt = useCallback(async (debtId, amount, paymentMethod = 'cash', notes = '') => wrap(async () => {
    if (!amount || amount <= 0) return { ok: false, error: 'Nominal harus > 0' }
    const cashier = currentUser?.name || currentUser?.username || ''
    const cashierId = currentUser?.id || null
    const { error: e } = await supabase.from('debt_payments').insert({
      debt_id: debtId, amount: Number(amount),
      payment_method: paymentMethod, notes,
      cashier, cashier_id: cashierId,
    })
    if (e) return { ok: false, error: e.message }
    // Refresh debts (trigger has already updated debts.paid/remaining/status)
    await refreshDebts()
    await refreshCustomers()
    return { ok: true }
  }), [currentUser, wrap, refreshDebts, refreshCustomers])

  const deleteDebt = useCallback(async (id) => wrap(async () => {
    const { error: e } = await supabase.from('debts').delete().eq('id', id)
    if (e) return { ok: false, error: e.message }
    if (mounted.current) setDebts(prev => prev.filter(d => d.id !== id))
    return { ok: true }
  }), [wrap])

  const getDebtPayments = useCallback(async (debtId) => {
    const { data, error: e } = await supabase
      .from('debt_payments').select('*').eq('debt_id', debtId).order('paid_at', { ascending: true })
    if (e) return { ok: false, error: e.message, data: [] }
    return { ok: true, data: data || [] }
  }, [])

  // ---------- STATS ----------
  const stats = useMemo(() => {
    const today = new Date().toDateString()
    const now = new Date()
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)

    const todayTrx = transactions.filter(t => new Date(t.date).toDateString() === today)
    const monthTrx = transactions.filter(t => new Date(t.date) >= monthStart)

    const totalOmzet = transactions.filter(t => t.status === 'lunas').reduce((s, t) => s + t.total, 0)
    const todayOmzet = todayTrx.filter(t => t.status === 'lunas').reduce((s, t) => s + t.total, 0)
    const monthOmzet = monthTrx.filter(t => t.status === 'lunas').reduce((s, t) => s + t.total, 0)
    const pendingCount = transactions.filter(t => t.status === 'pending').length
    const procesCount = transactions.filter(t => t.status === 'proses').length
    const todayOrders = todayTrx.length
    const monthOrders = monthTrx.length

    const productSales = {}
    transactions.forEach(t => t.items.forEach(i => {
      productSales[i.productId] = (productSales[i.productId] || 0) + i.qty
    }))
    const topProducts = products
      .map(p => ({ ...p, sold: productSales[p.id] || 0 }))
      .sort((a, b) => b.sold - a.sold).slice(0, 5)

    const chartData = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(); d.setDate(d.getDate() - (6 - i))
      const ds = d.toDateString()
      const dayTrx = transactions.filter(t => new Date(t.date).toDateString() === ds)
      return {
        day: d.toLocaleDateString('id-ID', { weekday: 'short' }),
        date: d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short' }),
        omzet: dayTrx.filter(t => t.status === 'lunas').reduce((s, t) => s + t.total, 0),
        transaksi: dayTrx.length,
      }
    })

    const categoryRevenue = {}
    transactions.forEach(t => t.items.forEach(item => {
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
  }, [transactions, products, customers, debts])

  return {
    loading, busy, error,
    products, transactions, storeInfo, stats,
    admins, currentUser, customers, debts,
    refreshAll, refreshCustomers, refreshDebts,
    addProduct, updateProduct, deleteProduct,
    addTransaction, updateTransactionStatus, updateTransactionPayment, deleteTransaction,
    updateOrderStatus,
    updateStoreInfo, updateLogo,
    login, logout, addAdmin, deleteAdmin, changePassword,
    addCustomer, updateCustomer, deleteCustomer,
    payDebt, deleteDebt, getDebtPayments,
  }
}
