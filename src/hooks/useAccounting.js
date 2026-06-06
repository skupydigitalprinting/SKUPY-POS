// ─────────────────────────────────────────────────────────────
// useAccounting — fetcher modul Accounting (LAZY).
//
// PENTING: hook ini TIDAK dipanggil saat app pertama dibuka. Hanya dipakai
// di dalam komponen Accounting yang di-lazy-load, jadi tidak menambah beban
// initial load POS. Semua query pakai LIMIT / pagination / RPC agregat.
// ─────────────────────────────────────────────────────────────
import { useState, useCallback, useRef } from 'react'
import { supabase } from '../lib/supabase'

const PAGE_SIZE = 50
const todayISO = () => new Date().toISOString().slice(0, 10)
const monthStartISO = () => {
  const d = new Date()
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10)
}

export function useAccounting() {
  const [busy, setBusy] = useState(false)
  const mounted = useRef(true)

  // Ringkasan agregat (RPC acc_summary) — bukan ambil semua data.
  const getSummary = useCallback(async (from, to) => {
    const { data, error } = await supabase.rpc('acc_summary', { p_from: from, p_to: to })
    if (error) return { ok: false, error: error.message, data: null }
    return { ok: true, data: data || {} }
  }, [])

  // Dashboard sederhana owner (RPC acc_dashboard).
  const getDashboard = useCallback(async (from, to) => {
    const { data, error } = await supabase.rpc('acc_dashboard', { p_from: from, p_to: to })
    if (error) return { ok: false, error: error.message, data: null }
    return { ok: true, data: data || {} }
  }, [])

  // Total Piutang Aktif langsung dari debts (untuk validasi sinkron vs RPC).
  const getPiutangAktif = useCallback(async () => {
    const { data, error } = await supabase.from('debts').select('total_debt, paid').limit(5000)
    if (error) return { ok: false, error: error.message, value: 0 }
    const v = (data || []).reduce((s, d) => s + Math.max(0, Math.round(+d.total_debt || 0) - Math.round(+d.paid || 0)), 0)
    return { ok: true, value: v }
  }, [])

  // Sinkronkan / recalculate seluruh jurnal (RPC acc_resync).
  const resync = useCallback(async () => {
    const { data, error } = await supabase.rpc('acc_resync')
    if (error) return { ok: false, error: error.message }
    return { ok: true, data }
  }, [])

  // Detail transaksi POS (uang masuk) per metode — paginated.
  const listTransactions = useCallback(async ({ method, from, to, page = 0 } = {}) => {
    let q = supabase.from('transactions')
      .select('id, invoice_no, customer, cashier, cashier_id, payment_method, total, paid, remaining, status, order_status, created_at', { count: 'exact' })
      .neq('order_status', 'dibatalkan')
      .order('created_at', { ascending: false })
      .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1)
    if (method) q = q.eq('payment_method', method)
    if (from) q = q.gte('created_at', from)
    if (to) q = q.lte('created_at', to + 'T23:59:59')
    const { data, error, count } = await q
    if (error) return { ok: false, error: error.message, data: [], count: 0 }
    return { ok: true, data: data || [], count: count || 0 }
  }, [])

  // Detail pembayaran cicilan (debt_payments).
  const listCicilan = useCallback(async ({ method, from, to, page = 0 } = {}) => {
    let q = supabase.from('debt_payments')
      .select('id, invoice_no, amount, payment_method, paid_at, cashier, cashier_id', { count: 'exact' })
      .order('paid_at', { ascending: false })
      .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1)
    if (method) q = q.eq('payment_method', method)
    if (from) q = q.gte('paid_at', from)
    if (to) q = q.lte('paid_at', to + 'T23:59:59')
    const { data, error, count } = await q
    if (error) return { ok: false, error: error.message, data: [], count: 0 }
    return { ok: true, data: data || [], count: count || 0 }
  }, [])

  // Mutasi kas/rekening (cash_movements) per channel.
  const listCashMovements = useCallback(async ({ channel = 'kas', to, page = 0 } = {}) => {
    const methods = channel === 'kas' ? ['cash'] : ['transfer', 'qris']
    let q = supabase.from('cash_movements')
      .select('id, moved_at, direction, method, amount, invoice_no, note', { count: 'exact' })
      .in('method', methods)
      .order('moved_at', { ascending: false })
      .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1)
    if (to) q = q.lte('moved_at', to + 'T23:59:59')
    const { data, error, count } = await q
    if (error) return { ok: false, error: error.message, data: [], count: 0 }
    return { ok: true, data: data || [], count: count || 0 }
  }, [])

  // Expenses by category bucket.
  const listExpensesByBucket = useCallback(async ({ bucket, from, to, page = 0 } = {}) => {
    let q = supabase.from('expenses').select('*', { count: 'exact' })
      .order('expense_date', { ascending: false })
      .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1)
    if (from) q = q.gte('expense_date', from)
    if (to) q = q.lte('expense_date', to)
    if (bucket === 'gaji') q = q.in('category', ['Gaji', 'Gaji Karyawan'])
    else if (bucket === 'bahan') q = q.eq('category', 'Pembelian Bahan')
    else if (bucket === 'operasional') q = q.not('category', 'in', '("Gaji","Gaji Karyawan","Pembelian Bahan")')
    const { data, error, count } = await q
    if (error) return { ok: false, error: error.message, data: [], count: 0 }
    return { ok: true, data: data || [], count: count || 0 }
  }, [])

  // Jurnal double-entry — pagination 50/halaman.
  const listEntries = useCallback(async ({ page = 0, from, to } = {}) => {
    let q = supabase.from('accounting_entries')
      .select('id, entry_date, source_type, invoice_no, account_code, debit, credit, description', { count: 'exact' })
      .order('entry_date', { ascending: false })
      .order('created_at', { ascending: false })
      .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1)
    if (from) q = q.gte('entry_date', from)
    if (to) q = q.lte('entry_date', to)
    const { data, error, count } = await q
    if (error) return { ok: false, error: error.message, data: [], count: 0 }
    return { ok: true, data: data || [], count: count || 0 }
  }, [])

  const listExpenses = useCallback(async ({ page = 0 } = {}) => {
    const { data, error, count } = await supabase.from('expenses')
      .select('*', { count: 'exact' })
      .order('expense_date', { ascending: false })
      .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1)
    if (error) return { ok: false, error: error.message, data: [], count: 0 }
    return { ok: true, data: data || [], count: count || 0 }
  }, [])

  const listPurchases = useCallback(async ({ page = 0 } = {}) => {
    const { data, error, count } = await supabase.from('purchases')
      .select('*', { count: 'exact' })
      .order('purchase_date', { ascending: false })
      .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1)
    if (error) return { ok: false, error: error.message, data: [], count: 0 }
    return { ok: true, data: data || [], count: count || 0 }
  }, [])

  const addExpense = useCallback(async (payload) => {
    setBusy(true)
    try {
      const { error } = await supabase.from('expenses').insert({
        expense_date: payload.date || todayISO(),
        category: payload.category || 'Operasional',
        amount: Math.round(Number(payload.amount) || 0),
        method: payload.method || 'cash',
        note: payload.note || '',
        cashier_id: payload.cashierId || null,
      })
      if (error) return { ok: false, error: error.message }
      return { ok: true }
    } finally { if (mounted.current) setBusy(false) }
  }, [])

  const deleteExpense = useCallback(async (id) => {
    const { error } = await supabase.from('expenses').delete().eq('id', id)
    return error ? { ok: false, error: error.message } : { ok: true }
  }, [])

  const addPurchase = useCallback(async (payload) => {
    setBusy(true)
    try {
      const { error } = await supabase.from('purchases').insert({
        purchase_date: payload.date || todayISO(),
        supplier: payload.supplier || '',
        item: payload.item || '',
        qty: Number(payload.qty) || 0,
        amount: Math.round(Number(payload.amount) || 0),
        method: payload.method || 'cash',
        is_credit: !!payload.isCredit,
        note: payload.note || '',
      })
      if (error) return { ok: false, error: error.message }
      return { ok: true }
    } finally { if (mounted.current) setBusy(false) }
  }, [])

  const deletePurchase = useCallback(async (id) => {
    const { error } = await supabase.from('purchases').delete().eq('id', id)
    return error ? { ok: false, error: error.message } : { ok: true }
  }, [])

  // ── Hutang Supplier ──
  const listSupplierDebts = useCallback(async () => {
    const { data, error } = await supabase.from('supplier_debts')
      .select('*').order('created_at', { ascending: false }).limit(200)
    if (error) return { ok: false, error: error.message, data: [] }
    return { ok: true, data: data || [] }
  }, [])

  const addSupplierDebt = useCallback(async (p) => {
    const total = Math.round(Number(p.total) || 0)
    const { error } = await supabase.from('supplier_debts').insert({
      supplier: p.supplier || '', item: p.item || '',
      total, paid: 0, remaining: total,
      due_date: p.dueDate || null, note: p.note || '',
    })
    return error ? { ok: false, error: error.message } : { ok: true }
  }, [])

  const paySupplierDebt = useCallback(async (debtId, amount, method, cashierId) => {
    const amt = Math.round(Number(amount) || 0)
    if (amt <= 0) return { ok: false, error: 'Nominal harus > 0' }
    const { error } = await supabase.from('supplier_debt_payments').insert({
      supplier_debt_id: debtId, amount: amt, method: method || 'cash', cashier_id: cashierId || null,
    })
    return error ? { ok: false, error: error.message } : { ok: true }
  }, [])

  const deleteSupplierDebt = useCallback(async (id) => {
    const { error } = await supabase.from('supplier_debts').delete().eq('id', id)
    return error ? { ok: false, error: error.message } : { ok: true }
  }, [])

  // Rekap per admin (RPC agregat)
  const getRecapAdmin = useCallback(async (from, to) => {
    const { data, error } = await supabase.rpc('acc_recap_admin', { p_from: from, p_to: to })
    if (error) return { ok: false, error: error.message, data: [] }
    return { ok: true, data: data || [] }
  }, [])

  // ── SUPPLIER MASTER ──
  const listSuppliers = useCallback(async (q = '') => {
    let query = supabase.from('suppliers').select('*').is('deleted_at', null).order('name', { ascending: true }).limit(500)
    if (q) query = query.ilike('name', `%${q}%`)
    const { data, error } = await query
    if (error) return { ok: false, error: error.message, data: [] }
    return { ok: true, data: data || [] }
  }, [])
  const addSupplier = useCallback(async (p) => {
    const { data, error } = await supabase.from('suppliers').insert({
      name: p.name || '', phone: p.phone || '', address: p.address || '', note: p.note || '',
    }).select().single()
    return error ? { ok: false, error: error.message } : { ok: true, data }
  }, [])
  const updateSupplier = useCallback(async (id, p) => {
    const { error } = await supabase.from('suppliers').update({
      name: p.name, phone: p.phone, address: p.address, note: p.note, updated_at: new Date().toISOString(),
    }).eq('id', id)
    return error ? { ok: false, error: error.message } : { ok: true }
  }, [])
  const deleteSupplier = useCallback(async (id) => {
    // soft delete
    const { error } = await supabase.from('suppliers').update({ deleted_at: new Date().toISOString() }).eq('id', id)
    return error ? { ok: false, error: error.message } : { ok: true }
  }, [])

  // ── HUTANG BANK ──
  const listBankLoans = useCallback(async () => {
    const { data, error } = await supabase.from('bank_loans').select('*').order('created_at', { ascending: false }).limit(200)
    if (error) return { ok: false, error: error.message, data: [] }
    return { ok: true, data: data || [] }
  }, [])
  const addBankLoan = useCallback(async (p) => {
    const plafon = Math.round(Number(p.plafon) || 0)
    const { error } = await supabase.from('bank_loans').insert({
      nama_bank: p.namaBank || '', jenis_pinjaman: p.jenis || '', nomor_kontrak: p.nomor || '',
      tanggal_mulai: p.mulai || null, tanggal_jatuh_tempo: p.jatuhTempo || null,
      plafon_pinjaman: plafon, sisa_pokok: p.sisaPokok != null ? Math.round(Number(p.sisaPokok) || 0) : plafon,
      bunga: Number(p.bunga) || 0, cicilan_bulanan: Math.round(Number(p.cicilan) || 0),
      keterangan: p.keterangan || '',
    })
    return error ? { ok: false, error: error.message } : { ok: true }
  }, [])
  const deleteBankLoan = useCallback(async (id) => {
    const { error } = await supabase.from('bank_loans').delete().eq('id', id)
    return error ? { ok: false, error: error.message } : { ok: true }
  }, [])
  const payBankLoan = useCallback(async (loanId, { amount, pokok, bunga, method, note, cashierId }) => {
    const amt = Math.round(Number(amount) || 0)
    if (amt <= 0) return { ok: false, error: 'Nominal harus > 0' }
    const { error } = await supabase.from('bank_loan_payments').insert({
      loan_id: loanId, amount: amt, pokok: Math.round(Number(pokok) || 0), bunga: Math.round(Number(bunga) || 0),
      method: method || 'cash', note: note || '', cashier_id: cashierId || null,
    })
    return error ? { ok: false, error: error.message } : { ok: true }
  }, [])

  // Ambil semua jurnal dalam rentang (untuk export Excel) — dibatasi aman.
  const fetchEntriesForExport = useCallback(async (from, to) => {
    const { data, error } = await supabase.from('accounting_entries')
      .select('entry_date, source_type, invoice_no, account_code, debit, credit, description')
      .gte('entry_date', from).lte('entry_date', to)
      .order('entry_date', { ascending: true }).limit(5000)
    if (error) return { ok: false, error: error.message, data: [] }
    return { ok: true, data: data || [] }
  }, [])

  return {
    busy, PAGE_SIZE, todayISO, monthStartISO,
    getSummary, getDashboard, getPiutangAktif, resync, listEntries, listExpenses, listPurchases,
    listTransactions, listCicilan, listCashMovements, listExpensesByBucket,
    addExpense, deleteExpense, addPurchase, deletePurchase,
    listSupplierDebts, addSupplierDebt, paySupplierDebt, deleteSupplierDebt,
    listSuppliers, addSupplier, updateSupplier, deleteSupplier,
    listBankLoans, addBankLoan, deleteBankLoan, payBankLoan,
    getRecapAdmin, fetchEntriesForExport,
  }
}
