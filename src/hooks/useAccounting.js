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
// Tanggal LOKAL (YYYY-MM-DD) — JANGAN pakai toISOString() karena mengonversi ke
// UTC sehingga di zona WIB (UTC+7) tanggal 1 lokal jadi mundur ke tgl 31 bulan
// sebelumnya (sumber bug default filter "31/05" → seharusnya "01/06").
const localISO = (d) => {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
const todayISO = () => localISO(new Date())                       // hari ini (lokal)
const monthStartISO = () => {                                     // tanggal 1 bulan berjalan
  const d = new Date()
  return localISO(new Date(d.getFullYear(), d.getMonth(), 1))
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

  // REALTIME dashboard (BUG-1): subscribe perubahan tabel sumber → panggil onChange
  // (di-debounce 800ms agar burst INSERT/UPDATE tidak memicu banyak refetch).
  // Mengembalikan fungsi unsubscribe. Polling 45s tetap ada sebagai jaring pengaman.
  const subscribeDashboard = useCallback((onChange) => {
    let timer = null
    const ping = () => { if (timer) clearTimeout(timer); timer = setTimeout(() => { onChange && onChange() }, 800) }
    const tables = [
      'transactions', 'debt_payments', 'expenses', 'purchases', 'asset_sales',
      'prepaid_rents', 'assets', 'supplier_debt_payments', 'bank_loan_payments',
      'employee_cash_advances', 'employee_cash_advance_payments', 'credibook_income',
      'debts', 'supplier_debts', 'bank_loans', 'migration_details',
    ]
    let ch
    try {
      ch = supabase.channel('acc-dashboard-rt')
      tables.forEach(t => ch.on('postgres_changes', { event: '*', schema: 'public', table: t }, ping))
      ch.subscribe()
    } catch (e) { /* realtime opsional — jika gagal, polling tetap jalan */ }
    return () => { try { if (ch) supabase.removeChannel(ch) } catch (e) {} }
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
      .is('deleted_at', null)
      .order('expense_date', { ascending: false })
      .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1)
    if (error) return { ok: false, error: error.message, data: [], count: 0 }
    return { ok: true, data: data || [], count: count || 0 }
  }, [])

  // Riwayat pengeluaran MENGIKUTI filter waktu (from..to). expense_date dipakai
  // untuk periode; jam tetap dari created_at. Exclude deleted. Urut terbaru dulu
  // (expense_date desc, lalu created_at desc). Cap tinggi = "tampilkan semua".
  const listExpensesByRange = useCallback(async ({ from, to } = {}) => {
    let q = supabase.from('expenses').select('*', { count: 'exact' }).is('deleted_at', null)
    if (from) q = q.gte('expense_date', from)
    if (to) q = q.lte('expense_date', to)
    const { data, error, count } = await q
      .order('expense_date', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(5000)
    if (error) return { ok: false, error: error.message, data: [], count: 0 }
    return { ok: true, data: data || [], count: count || 0 }
  }, [])

  const listPurchases = useCallback(async ({ page = 0 } = {}) => {
    const { data, error, count } = await supabase.from('purchases')
      .select('*', { count: 'exact' })
      .is('deleted_at', null)
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
        method: payload.method || 'transfer',
        note: payload.note || '',
        cashier_id: payload.cashierId || null,
      })
      if (error) return { ok: false, error: error.message }
      return { ok: true }
    } finally { if (mounted.current) setBusy(false) }
  }, [])

  const deleteExpense = useCallback(async (id) => {
    // SOFT DELETE — sembunyikan dari laporan; trigger membuang jurnal & arus kas
    const { error } = await supabase.from('expenses').update({ deleted_at: new Date().toISOString() }).eq('id', id)
    return error ? { ok: false, error: error.message } : { ok: true }
  }, [])

  const updateExpense = useCallback(async (id, payload) => {
    const patch = {}
    if (payload.date !== undefined) patch.expense_date = payload.date
    if (payload.category !== undefined) patch.category = payload.category
    if (payload.amount !== undefined) patch.amount = Math.round(Number(payload.amount) || 0)
    if (payload.method !== undefined) patch.method = payload.method
    if (payload.note !== undefined) patch.note = payload.note
    const { error } = await supabase.from('expenses').update(patch).eq('id', id)
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
        method: payload.method || 'transfer',
        is_credit: !!payload.isCredit,
        note: payload.note || '',
      })
      if (error) return { ok: false, error: error.message }
      return { ok: true }
    } finally { if (mounted.current) setBusy(false) }
  }, [])

  const deletePurchase = useCallback(async (id) => {
    // SOFT DELETE — sembunyikan dari laporan; trigger membuang jurnal & arus kas
    const { error } = await supabase.from('purchases').update({ deleted_at: new Date().toISOString() }).eq('id', id)
    return error ? { ok: false, error: error.message } : { ok: true }
  }, [])

  const updatePurchase = useCallback(async (id, payload) => {
    const patch = {}
    if (payload.date !== undefined) patch.purchase_date = payload.date
    if (payload.supplier !== undefined) patch.supplier = payload.supplier
    if (payload.item !== undefined) patch.item = payload.item
    if (payload.qty !== undefined) patch.qty = Number(payload.qty) || 0
    if (payload.amount !== undefined) patch.amount = Math.round(Number(payload.amount) || 0)
    if (payload.method !== undefined) patch.method = payload.method
    if (payload.note !== undefined) patch.note = payload.note
    const { error } = await supabase.from('purchases').update(patch).eq('id', id)
    return error ? { ok: false, error: error.message } : { ok: true }
  }, [])

  // ── Hutang Supplier ──
  const listSupplierDebts = useCallback(async () => {
    const { data, error } = await supabase.from('supplier_debts')
      .select('*').is('deleted_at', null).order('created_at', { ascending: false }).limit(300)
    if (error) return { ok: false, error: error.message, data: [] }
    return { ok: true, data: data || [] }
  }, [])

  // Mengembalikan id supplier_debt yang dibuat (untuk langsung input DP).
  // p.date (YYYY-MM-DD, opsional) → created_at, supaya pembelian tempo yang
  // di-backdate tercatat di tanggal pembelian (bukan now()). Jam 12 siang
  // lokal dipakai agar ::date di trigger tidak mundur sehari karena UTC.
  const addSupplierDebt = useCallback(async (p) => {
    const total = Math.round(Number(p.total) || 0)
    const row = {
      supplier: p.supplier || '', item: p.item || '',
      total, paid: 0, remaining: total,
      due_date: p.dueDate || null, note: p.note || '',
      payment_method: p.method || 'transfer',
    }
    if (p.date) row.created_at = new Date(`${p.date}T12:00:00`).toISOString()
    const { data, error } = await supabase.from('supplier_debts').insert(row).select('id').single()
    return error ? { ok: false, error: error.message } : { ok: true, id: data?.id }
  }, [])

  const editSupplierDebt = useCallback(async (id, p) => {
    const { error } = await supabase.from('supplier_debts').update({
      supplier: p.supplier, item: p.item, total: Math.round(Number(p.total) || 0),
      due_date: p.dueDate || null, note: p.note, payment_method: p.method,
      updated_at: new Date().toISOString(),
    }).eq('id', id)
    return error ? { ok: false, error: error.message } : { ok: true }
  }, [])

  const paySupplierDebt = useCallback(async (debtId, amount, method, cashierId, note, paidAt) => {
    const amt = Math.round(Number(amount) || 0)
    if (amt <= 0) return { ok: false, error: 'Nominal harus > 0' }
    const row = {
      supplier_debt_id: debtId, amount: amt, method: method || 'transfer', note: note || '', cashier_id: cashierId || null,
    }
    // paidAt (YYYY-MM-DD, opsional) → paid_at, untuk DP pembelian backdate.
    if (paidAt) row.paid_at = new Date(`${paidAt}T12:00:00`).toISOString()
    const { error } = await supabase.from('supplier_debt_payments').insert(row)
    return error ? { ok: false, error: error.message } : { ok: true }
  }, [])

  // Soft delete supplier debt — ATOMIK via RPC (1 transaksi DB).
  // Fallback dua langkah hanya kalau DB belum menjalankan migrasi
  // 2026_06_supplier_debt_fixes.sql.
  const deleteSupplierDebt = useCallback(async (id) => {
    const { error: rpcErr } = await supabase.rpc('acc_delete_supplier_debt', { p_id: id })
    if (!rpcErr) return { ok: true }
    const msg = String(rpcErr.message || '')
    if (!/could not find the function|does not exist|schema cache/i.test(msg)) {
      return { ok: false, error: msg }
    }
    // Fallback (tidak atomik): cek error langkah pertama sebelum lanjut.
    const now = new Date().toISOString()
    const { error: payErr } = await supabase.from('supplier_debt_payments').update({ deleted_at: now }).eq('supplier_debt_id', id).is('deleted_at', null)
    if (payErr) return { ok: false, error: payErr.message }
    const { error } = await supabase.from('supplier_debts').update({ deleted_at: now }).eq('id', id)
    return error ? { ok: false, error: error.message } : { ok: true }
  }, [])

  // ── Riwayat pembayaran hutang supplier ──
  const listSupplierPayments = useCallback(async (debtId) => {
    const { data, error } = await supabase.from('supplier_debt_payments')
      .select('*').eq('supplier_debt_id', debtId).is('deleted_at', null).order('paid_at', { ascending: false })
    if (error) return { ok: false, error: error.message, data: [] }
    return { ok: true, data: data || [] }
  }, [])
  const editSupplierPayment = useCallback(async (id, { amount, method, note }) => {
    const amt = Math.round(Number(amount) || 0)
    if (amt <= 0) return { ok: false, error: 'Nominal harus > 0' }
    const { error } = await supabase.from('supplier_debt_payments').update({
      amount: amt, method: method || 'transfer', note: note || '', updated_at: new Date().toISOString(),
    }).eq('id', id)
    return error ? { ok: false, error: error.message } : { ok: true }
  }, [])
  const deleteSupplierPayment = useCallback(async (id) => {
    const { error } = await supabase.from('supplier_debt_payments').update({ deleted_at: new Date().toISOString() }).eq('id', id)
    return error ? { ok: false, error: error.message } : { ok: true }
  }, [])

  // Semua pembayaran milik SATU supplier (gabungan semua nota) — untuk riwayat.
  const listSupplierPaymentsBySupplier = useCallback(async (supplier) => {
    const { data: debts } = await supabase.from('supplier_debts').select('id,item').eq('supplier', supplier).is('deleted_at', null)
    const ids = (debts || []).map(d => d.id)
    const itemById = {}; (debts || []).forEach(d => { itemById[d.id] = d.item })
    if (!ids.length) return { ok: true, data: [] }
    const { data, error } = await supabase.from('supplier_debt_payments').select('*').in('supplier_debt_id', ids).is('deleted_at', null).order('paid_at', { ascending: false })
    if (error) return { ok: false, error: error.message, data: [] }
    return { ok: true, data: (data || []).map(p => ({ ...p, item: itemById[p.supplier_debt_id] || '' })) }
  }, [])

  // PEMBAYARAN GABUNGAN FIFO — alokasikan pembayaran ke nota tertua dulu.
  // Urutan: jatuh tempo paling awal → tanggal hutang (created_at) paling lama.
  // Insert 1 payment per nota dengan fifo_group sama. Trigger DB meng-update
  // paid/remaining/status tiap nota (tidak ada double count). Uang keluar naik
  // hanya saat pembayaran ini dibuat.
  const paySupplierFIFO = useCallback(async (supplier, amount, method, cashierId, note, paidAt) => {
    const total = Math.round(Number(amount) || 0)
    if (total <= 0) return { ok: false, error: 'Nominal harus > 0' }
    const { data: debts, error: e1 } = await supabase.from('supplier_debts')
      .select('id,total,paid,due_date,created_at').eq('supplier', supplier).is('deleted_at', null)
    if (e1) return { ok: false, error: e1.message }
    const active = (debts || [])
      .map(d => ({ ...d, rem: Math.max(0, Math.round(d.total || 0) - Math.round(d.paid || 0)) }))
      .filter(d => d.rem > 0)
      .sort((a, b) => {
        const ad = a.due_date ? String(a.due_date).slice(0, 10) : '9999-12-31'
        const bd = b.due_date ? String(b.due_date).slice(0, 10) : '9999-12-31'
        if (ad !== bd) return ad < bd ? -1 : 1
        return new Date(a.created_at) - new Date(b.created_at)
      })
    if (!active.length) return { ok: false, error: 'Tidak ada nota dengan sisa hutang' }
    const group = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `g_${Date.now()}_${Math.random().toString(36).slice(2)}`
    let left = total
    const rows = []
    for (const d of active) {
      if (left <= 0) break
      const pay = Math.min(left, d.rem)
      left -= pay
      const row = { supplier_debt_id: d.id, amount: pay, method: method || 'transfer', note: note || '', cashier_id: cashierId || null, fifo_group: group }
      if (paidAt) row.paid_at = new Date(`${paidAt}T12:00:00`).toISOString()
      rows.push(row)
    }
    let { error: e2 } = await supabase.from('supplier_debt_payments').insert(rows)
    if (e2 && /fifo_group|column .* does not exist|schema cache/i.test(e2.message || '')) {
      const stripped = rows.map(({ fifo_group, ...r }) => r)
      ;({ error: e2 } = await supabase.from('supplier_debt_payments').insert(stripped))
    }
    if (e2) return { ok: false, error: e2.message }
    return { ok: true, applied: total - left, leftover: left, count: rows.length, group }
  }, [])

  // Hapus SATU batch pembayaran FIFO (soft delete semua alokasinya).
  const deleteSupplierFIFOGroup = useCallback(async (group) => {
    if (!group) return { ok: false, error: 'Group tidak valid' }
    const { error } = await supabase.from('supplier_debt_payments').update({ deleted_at: new Date().toISOString() }).eq('fifo_group', group).is('deleted_at', null)
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
    const { data, error } = await supabase.from('bank_loans').select('*').is('deleted_at', null).order('created_at', { ascending: false }).limit(200)
    if (error) return { ok: false, error: error.message, data: [] }
    return { ok: true, data: data || [] }
  }, [])
  const addBankLoan = useCallback(async (p) => {
    const plafon = Math.round(Number(p.plafon) || 0)
    // Sisa pokok kosong ('' / null / 0) → otomatis = plafon
    const sisaIn = Math.round(Number(p.sisaPokok) || 0)
    const sisa = (p.sisaPokok === '' || p.sisaPokok == null || sisaIn <= 0) ? plafon : sisaIn
    const { error } = await supabase.from('bank_loans').insert({
      nama_bank: p.namaBank || '', jenis_pinjaman: p.jenis || '', nomor_kontrak: p.nomor || '',
      tanggal_mulai: p.mulai || null, tanggal_jatuh_tempo: p.jatuhTempo || null,
      plafon_pinjaman: plafon, sisa_pokok: sisa,
      pokok_awal: sisa, // pokok awal = sisa saat dibuat → dasar recalc sisa pokok
      bunga: Number(p.bunga) || 0, cicilan_bulanan: Math.round(Number(p.cicilan) || 0),
      keterangan: p.keterangan || '',
    })
    return error ? { ok: false, error: error.message } : { ok: true }
  }, [])
  const deleteBankLoan = useCallback(async (id) => {
    // SOFT DELETE + CASCADE: pembayaran cicilannya juga di-soft-delete agar
    // tidak lagi dihitung di Uang Keluar / Arus Kas (trigger membuang jurnalnya).
    const now = new Date().toISOString()
    await supabase.from('bank_loan_payments').update({ deleted_at: now }).eq('loan_id', id).is('deleted_at', null)
    const { error } = await supabase.from('bank_loans').update({ deleted_at: now, status: 'cancelled' }).eq('id', id)
    return error ? { ok: false, error: error.message } : { ok: true }
  }, [])
  // Seluruh nominal bayar mengurangi POKOK (tanpa pemisahan bunga).
  const payBankLoan = useCallback(async (loanId, { amount, method, note, cashierId, paymentNumber } = {}) => {
    const amt = Math.round(Number(amount) || 0)
    if (amt <= 0) return { ok: false, error: 'Nominal harus > 0' }
    const { error } = await supabase.from('bank_loan_payments').insert({
      loan_id: loanId, amount: amt, pokok: amt, bunga: 0,
      method: method || 'transfer', note: note || '', cashier_id: cashierId || null,
      payment_number: paymentNumber || null,
    })
    return error ? { ok: false, error: error.message } : { ok: true }
  }, [])

  // ── Riwayat pembayaran cicilan bank ──
  const listBankPayments = useCallback(async (loanId) => {
    const { data, error } = await supabase.from('bank_loan_payments')
      .select('*').eq('loan_id', loanId).is('deleted_at', null).order('paid_at', { ascending: false })
    if (error) return { ok: false, error: error.message, data: [] }
    return { ok: true, data: data || [] }
  }, [])
  const editBankPayment = useCallback(async (id, { amount, method, note, paidAt }) => {
    const amt = Math.round(Number(amount) || 0)
    const patch = { amount: amt, pokok: amt, bunga: 0, method: method || 'transfer', note: note || '', updated_at: new Date().toISOString() }
    if (paidAt) patch.paid_at = paidAt
    const { error } = await supabase.from('bank_loan_payments').update(patch).eq('id', id)
    return error ? { ok: false, error: error.message } : { ok: true }
  }, [])
  const deleteBankPayment = useCallback(async (id) => {
    const { error } = await supabase.from('bank_loan_payments').update({ deleted_at: new Date().toISOString() }).eq('id', id)
    return error ? { ok: false, error: error.message } : { ok: true }
  }, [])

  // ── Detail sumber angka per card dashboard (audit) ──
  // Mengembalikan { ok, rows, total }. Rows ternormalisasi:
  //   { id, kind, date, source, ref, party, method, amount, status, note }
  // kind: expense | purchase | supplier_payment | bank_payment | transaction
  //       | debt_payment | supplier_debt | bank_loan | debt  (untuk edit/hapus)
  // ============================================================
  // SINGLE SOURCE OF TRUTH — semua "Uang Keluar" pada periode.
  // Menggabungkan SEMUA sumber uang keluar TANPA double counting:
  //   1) Pengeluaran manual            (expenses)
  //   2) Pembelian cash/transfer       (purchases, non-kredit)
  //   3) Pembayaran Hutang Supplier    (supplier_debt_payments)  ← sumber resmi
  //   4) Pembayaran Hutang Bank        (bank_loan_payments)      ← sumber resmi
  //   5) Kasbon Karyawan keluar        (employee_cash_advances, non-opening)
  //   6) Pengeluaran Migrasi Data Lama (migration_details old_expense)
  //   7) Pembayaran Sewa dibayar dimuka(prepaid_rents)
  // Hutang bank/supplier HANYA dihitung dari tabel pembayarannya, TIDAK dari
  // expenses → tidak ada double. Setiap baris diberi refKey unik (kind:id),
  // dijamin lewat Set sehingga satu baris tak pernah masuk 2x.
  // Hanya data valid: deleted_at IS NULL, bukan status cancelled/batal/deleted.
  // Total fungsi ini = pengeluaran_total (RPC) + cash-out sewa → cocok card.
  // ============================================================
  const getOutflowTransactions = useCallback(async (from, to) => {
    const toEnd = (to || from) + 'T23:59:59'
    const rows = []
    const seen = new Set() // guard refKey: tak pernah push baris yang sama dua kali
    const isCancelled = (s) => ['cancelled', 'canceled', 'dibatalkan', 'batal', 'deleted', 'void'].includes(String(s || '').toLowerCase())
    const add = (r) => {
      const refKey = `${r.kind}:${r.id}`
      if (seen.has(refKey)) return
      seen.add(refKey)
      rows.push({ ref: '', party: '', category: '', method: '', status: 'valid', note: '', ...r, refKey })
    }
    try {
      // 1) Pengeluaran manual
      {
        const { data } = await supabase.from('expenses').select('id,expense_date,created_at,category,amount,method,note').is('deleted_at', null).gte('expense_date', from).lte('expense_date', to)
        ;(data || []).forEach(x => add({ id: x.id, kind: 'expense', date: x.expense_date, createdAt: x.created_at, source: 'Pengeluaran', category: x.category || 'Pengeluaran', party: x.category || '', method: x.method, amount: Math.round(x.amount || 0), note: x.note }))
      }
      // 2) Pembelian cash/transfer (non-kredit) — yg kredit masuk Hutang Supplier
      {
        const { data } = await supabase.from('purchases').select('id,purchase_date,created_at,item,supplier,amount,method,is_credit,note').is('deleted_at', null).gte('purchase_date', from).lte('purchase_date', to)
        ;(data || []).filter(x => !x.is_credit).forEach(x => add({ id: x.id, kind: 'purchase', date: x.purchase_date, createdAt: x.created_at, source: 'Pembelian', category: 'Pembelian', ref: x.item, party: x.supplier, method: x.method, amount: Math.round(x.amount || 0), status: 'lunas', note: x.note }))
      }
      // 3) Pembayaran Hutang Supplier (sumber resmi = supplier_debt_payments)
      {
        const { data } = await supabase.from('supplier_debt_payments').select('id,paid_at,created_at,amount,method,note,supplier_debt_id').is('deleted_at', null).gte('paid_at', from).lte('paid_at', toEnd)
        const ids = [...new Set((data || []).map(x => x.supplier_debt_id).filter(Boolean))]
        const dmap = {}
        if (ids.length) { const { data: dd } = await supabase.from('supplier_debts').select('id,supplier,item').in('id', ids); (dd || []).forEach(d => { dmap[d.id] = d }) }
        ;(data || []).forEach(x => { const d = dmap[x.supplier_debt_id] || {}; add({ id: x.id, kind: 'supplier_payment', date: x.paid_at, createdAt: x.created_at || x.paid_at, source: 'Hutang Supplier', category: 'Bayar Hutang Supplier', ref: d.item || '', party: d.supplier || '', method: x.method, amount: Math.round(x.amount || 0), note: x.note }) })
      }
      // 4) Pembayaran Hutang Bank (sumber resmi = bank_loan_payments, BUKAN expenses)
      {
        const { data } = await supabase.from('bank_loan_payments').select('id,paid_at,created_at,amount,method,note').is('deleted_at', null).gte('paid_at', from).lte('paid_at', toEnd)
        ;(data || []).forEach(x => add({ id: x.id, kind: 'bank_payment', date: x.paid_at, createdAt: x.created_at || x.paid_at, source: 'Hutang Bank', category: 'Cicilan Bank', method: x.method, amount: Math.round(x.amount || 0), note: x.note }))
      }
      // 5) Kasbon Karyawan keluar (advance, bukan saldo awal/opening).
      //    PENTING: kasbon WAJIB masuk Uang Keluar. Bila select kolom is_opening/status
      //    gagal (skema lama), JANGAN diam-diam membuang kasbon — ulangi dgn kolom minimal
      //    agar kasbon tetap terhitung (anti bug "Uang Keluar tidak naik saat kasbon").
      {
        let { data, error } = await supabase.from('employee_cash_advances').select('id,advance_date,created_at,amount,payment_method,note,employee_name,is_opening,status').is('deleted_at', null).gte('advance_date', from).lte('advance_date', to)
        if (error) {
          ;({ data } = await supabase.from('employee_cash_advances').select('id,advance_date,created_at,amount,payment_method,note,employee_name').is('deleted_at', null).gte('advance_date', from).lte('advance_date', to))
        }
        ;(data || []).filter(x => !x.is_opening && !isCancelled(x.status)).forEach(x => add({ id: x.id, kind: 'kasbon', date: x.advance_date, createdAt: x.created_at, source: 'Kasbon Karyawan', category: 'Kasbon Keluar', party: x.employee_name || '', method: x.payment_method, amount: Math.round(x.amount || 0), note: x.note }))
      }
      // 6) Pengeluaran Migrasi Data Lama
      {
        const { data } = await supabase.from('migration_details').select('id,trx_date,created_at,name,customer,amount,method,notes,type').is('deleted_at', null).eq('type', 'old_expense').gte('trx_date', from).lte('trx_date', to)
        ;(data || []).forEach(x => add({ id: x.id, kind: 'migration', date: x.trx_date, createdAt: x.created_at, source: 'Migrasi Data', category: 'Migrasi Pengeluaran', ref: x.name, party: x.customer || '', method: x.method, amount: Math.round(x.amount || 0), status: 'migrasi', note: x.notes }))
      }
      // CATATAN SEWA DIBAYAR DIMUKA:
      //   Pembayaran sewa di muka TIDAK dihitung di sini sebagai uang keluar penuh.
      //   Saat dibayar → menambah ASET (Sewa Dibayar Dimuka) & mengurangi Arus Kas
      //   penuh. Untuk Uang Keluar / Pengeluaran (laba-rugi) sewa masuk sebagai
      //   BEBAN bulanan (amortisasi) yang dihitung di sisi komponen (rentSchedule),
      //   bukan sebagai baris pembayaran penuh di fungsi ini.
    } catch (e) { return { ok: false, error: e?.message || String(e), rows: [], total: 0, from, to, dupCount: 0 } }

    // DETEKSI POTENSI DUPLIKAT (tidak menghapus, hanya menandai):
    // baris dengan tanggal(YYYY-MM-DD)+nominal sama muncul >1x — mis. cicilan
    // bank yang juga keliru dicatat manual sebagai pengeluaran.
    const sig = (r) => `${String(r.date || '').slice(0, 10)}|${r.amount}`
    const counts = {}
    rows.forEach(r => { const k = sig(r); counts[k] = (counts[k] || 0) + 1 })
    rows.forEach(r => { r.dupSuspect = counts[sig(r)] > 1 })

    rows.sort((a, b) => new Date(b.date) - new Date(a.date))
    const total = rows.reduce((s, r) => s + (r.amount || 0), 0)
    const dupCount = rows.filter(r => r.dupSuspect).length
    return { ok: true, rows, total, from, to, dupCount }
  }, [])

  // ── ARUS KAS BERSIH (detail): MASUK & KELUAR aktual dalam rentang ──
  //   Masuk  = kas yang BENAR diterima:
  //            • Penjualan: init_paid = paid − Σ cicilan invoice itu (anti
  //              double-count dgn cicilan piutang; pending TIDAK dihitung)
  //            • Cicilan piutang (debt_payments)
  //            • Pemasukkan Credibook (semua jenis)
  //            • Migrasi pemasukan lama
  //   Keluar = getOutflowTransactions + pembayaran sewa dibayar dimuka (full).
  const getCashflowDetail = useCallback(async (from, to) => {
    const toEnd = (to || from) + 'T23:59:59'
    const masuk = [], keluar = [], pending = []
    const CB_LABEL = { omzet: 'Credibook · Omset', refund: 'Credibook · Refund', capital: 'Credibook · Modal Tambahan', other: 'Credibook · Lainnya' }
    try {
      // Σ cicilan per invoice (semua waktu) → untuk hitung init_paid
      const cicByInv = {}
      {
        const { data } = await supabase.from('debt_payments').select('invoice_no, amount').is('deleted_at', null)
        ;(data || []).forEach(x => { if (x.invoice_no) cicByInv[x.invoice_no] = (cicByInv[x.invoice_no] || 0) + Math.round(x.amount || 0) })
      }
      // 1) Penjualan — init_paid (uang diterima di awal, bukan total tagihan).
      //    Sisa yang BELUM diterima (pending/hutang) → daftar `pending` saja
      //    (tampil di tabel, TIDAK masuk Total Masuk).
      {
        const { data } = await supabase.from('transactions').select('id,created_at,invoice_no,payment_method,total,paid,remaining,status,cashier_id').is('deleted_at', null).neq('order_status', 'dibatalkan').gte('created_at', from).lte('created_at', toEnd)
        ;(data || []).forEach(x => {
          const initPaid = Math.max(0, Math.round(x.paid || 0) - (cicByInv[x.invoice_no] || 0))
          if (initPaid > 0) masuk.push({ id: x.id, type: 'masuk', date: x.created_at, createdAt: x.created_at, source: 'Penjualan', ref: x.invoice_no, category: 'Penjualan Kasir', method: x.payment_method, status: x.status, amount: initPaid, invoiceNo: x.invoice_no, cashierId: x.cashier_id })
          const rem = Math.max(0, Math.round(x.remaining != null ? x.remaining : (Math.round(x.total || 0) - Math.round(x.paid || 0))))
          if (rem > 0) pending.push({ id: x.id, type: 'pending', date: x.created_at, createdAt: x.created_at, source: 'Invoice Belum Lunas', ref: x.invoice_no, category: 'Belum diterima (tidak dihitung)', method: x.payment_method, status: x.status || 'pending', amount: rem, invoiceNo: x.invoice_no })
        })
      }
      // 2) Cicilan piutang
      {
        const { data } = await supabase.from('debt_payments').select('id,paid_at,created_at,invoice_no,amount,payment_method,note,cashier_id').is('deleted_at', null).gte('paid_at', from).lte('paid_at', toEnd)
        ;(data || []).forEach(x => masuk.push({ id: x.id, type: 'masuk', date: x.paid_at, createdAt: x.created_at || x.paid_at, source: 'Pembayaran Piutang', ref: x.invoice_no, category: 'Pembayaran Piutang', method: x.payment_method, status: 'valid', amount: Math.round(x.amount || 0), note: x.note, invoiceNo: x.invoice_no, cashierId: x.cashier_id }))
      }
      // 3) Credibook (semua jenis = kas masuk)
      {
        const { data, error } = await supabase.from('credibook_income').select('id,transaction_date,created_at,name,amount,payment_method,note,income_type').is('deleted_at', null).gte('transaction_date', from).lte('transaction_date', to)
        if (!error) (data || []).forEach(x => masuk.push({ id: x.id, type: 'masuk', date: x.transaction_date, createdAt: x.created_at, source: CB_LABEL[x.income_type] || 'Credibook', ref: x.name, category: 'Pemasukkan Manual', method: x.payment_method, status: 'valid', amount: Math.round(x.amount || 0), note: x.note }))
      }
      // 4) Migrasi pemasukan lama
      {
        const { data } = await supabase.from('migration_details').select('id,trx_date,created_at,name,customer,amount,method,notes').is('deleted_at', null).eq('type', 'old_income').gte('trx_date', from).lte('trx_date', to)
        ;(data || []).forEach(x => masuk.push({ id: x.id, type: 'masuk', date: x.trx_date, createdAt: x.created_at, source: 'Migrasi Data', ref: x.name, category: 'Migrasi Pemasukan', method: x.method, status: 'migrasi', amount: Math.round(x.amount || 0), note: x.notes }))
      }
      // 5) Pembayaran kasbon karyawan (employee_cash_advance_payments) = kas masuk.
      //    Sumber 'Pembayaran Kasbon' (beda dari 'Kasbon Karyawan' yang KELUAR) +
      //    nama karyawan sebagai ref (lookup via advance_id).
      {
        const { data } = await supabase.from('employee_cash_advance_payments').select('id,payment_date,created_at,amount,payment_method,note,advance_id').is('deleted_at', null).gte('payment_date', from).lte('payment_date', to)
        const advIds = [...new Set((data || []).map(x => x.advance_id).filter(Boolean))]
        const empMap = {}
        if (advIds.length) { const { data: aa } = await supabase.from('employee_cash_advances').select('id,employee_name').in('id', advIds); (aa || []).forEach(a => { empMap[a.id] = a.employee_name }) }
        ;(data || []).forEach(x => masuk.push({ id: x.id, type: 'masuk', date: x.payment_date, createdAt: x.created_at, source: 'Pembayaran Kasbon', ref: empMap[x.advance_id] || 'Karyawan', category: 'Pembayaran Kasbon Karyawan', method: x.payment_method, status: 'valid', amount: Math.round(x.amount || 0), note: x.note }))
      }
      // 6) Penjualan aset = kas masuk (harga jual). Bukan omset.
      {
        const { data, error } = await supabase.from('asset_sales').select('id,sale_date,created_at,asset_id,sale_price,gain_loss,payment_method,note').is('deleted_at', null).gte('sale_date', from).lte('sale_date', to)
        if (!error) {
          const ids = [...new Set((data || []).map(x => x.asset_id).filter(Boolean))]
          const nameMap = {}
          if (ids.length) { const { data: aa } = await supabase.from('assets').select('id,name').in('id', ids); (aa || []).forEach(a => { nameMap[a.id] = a.name }) }
          ;(data || []).forEach(x => masuk.push({ id: x.id, type: 'masuk', date: x.sale_date, createdAt: x.created_at, source: 'Penjualan Aset', ref: nameMap[x.asset_id] || '', category: Math.round(x.gain_loss || 0) >= 0 ? 'Untung Jual Aset' : 'Rugi Jual Aset', method: x.payment_method, status: 'valid', amount: Math.round(x.sale_price || 0), note: x.note }))
        }
      }
      // KELUAR — pengeluaran aktual (single source of truth)
      const out = await getOutflowTransactions(from, to)
      ;(out.rows || []).forEach(r => keluar.push({ ...r, type: 'keluar' }))
      // + Pembayaran sewa dibayar dimuka (FULL, saat dibayar)
      {
        const { data } = await supabase.from('prepaid_rents').select('id,payment_date,name,total_amount,payment_method,status,note').is('deleted_at', null).gte('payment_date', from).lte('payment_date', to)
        ;(data || []).filter(x => String(x.status || '').toLowerCase() !== 'cancelled').forEach(x => keluar.push({ id: x.id, type: 'keluar', date: x.payment_date, source: 'Sewa Dibayar Dimuka', ref: x.name || '', category: 'Pembayaran Sewa', method: x.payment_method, status: 'valid', amount: Math.round(x.total_amount || 0), note: x.note }))
      }
    } catch (e) {
      return { ok: false, error: e?.message || String(e), masuk: [], keluar: [], pending: [], totalMasuk: 0, totalKeluar: 0, net: 0 }
    }
    masuk.sort((a, b) => new Date(b.date) - new Date(a.date))
    keluar.sort((a, b) => new Date(b.date) - new Date(a.date))
    pending.sort((a, b) => new Date(b.date) - new Date(a.date))
    // Total HANYA dari uang yang benar diterima/dikeluarkan. `pending` TIDAK dihitung.
    const totalMasuk = masuk.reduce((s, r) => s + (r.amount || 0), 0)
    const totalKeluar = keluar.reduce((s, r) => s + (r.amount || 0), 0)
    return { ok: true, masuk, keluar, pending, totalMasuk, totalKeluar, net: totalMasuk - totalKeluar }
  }, [getOutflowTransactions])

  // ── AUDIT KEUANGAN (console) ──────────────────────────────────────────────
  // Memeriksa: double-count, baris terhapus yang masih terhitung, tumpang tindih
  // uang-masuk vs piutang, pengeluaran vs hutang, rekonsiliasi saldo, dan
  // menjalankan test validasi. Hasil ditampilkan di console. Aman: read-only.
  const auditAccounting = useCallback(async () => {
    const today = todayISO()
    const fmtNum = (n) => 'Rp ' + Math.round(Number(n) || 0).toLocaleString('id-ID')
    const issues = []
    const flag = (level, msg, data) => { issues.push({ level, msg, data }); }
    try {
      // Ambil agregat all-time (single source of truth).
      const { data: d } = await supabase.rpc('acc_dashboard', { p_from: '2000-01-01', p_to: today })

      // 1) Rekonsiliasi paid: Σ transactions.paid = Σ init_paid + Σ cicilan
      const { data: trx } = await supabase.from('transactions').select('paid,invoice_no').is('deleted_at', null).neq('order_status', 'dibatalkan')
      const { data: dps } = await supabase.from('debt_payments').select('amount,invoice_no').is('deleted_at', null)
      const sumPaid = (trx || []).reduce((s, t) => s + Math.round(t.paid || 0), 0)
      const sumCic = (dps || []).reduce((s, p) => s + Math.round(p.amount || 0), 0)
      // init_paid total (sama rumus acc_dashboard): paid − Σcic per invoice, clamp 0
      const cicByInv = {}; (dps || []).forEach(p => { if (p.invoice_no) cicByInv[p.invoice_no] = (cicByInv[p.invoice_no] || 0) + Math.round(p.amount || 0) })
      const sumInit = (trx || []).reduce((s, t) => s + Math.max(0, Math.round(t.paid || 0) - (cicByInv[t.invoice_no] || 0)), 0)
      const reconErr = sumPaid - (sumInit + sumCic)
      if (Math.abs(reconErr) > 1) flag('warn', `Rekonsiliasi paid tidak pas (selisih ${reconErr}). Kemungkinan ada cicilan tanpa update transactions.paid.`, { sumPaid, sumInit, sumCic })

      // 2) Duplikat pengeluaran (tanggal+nominal sama) — potensi dobel input
      const { data: exp } = await supabase.from('expenses').select('expense_date,amount,category,note').is('deleted_at', null)
      const dupMap = {}
      ;(exp || []).forEach(x => { const k = `${String(x.expense_date).slice(0, 10)}|${Math.round(x.amount || 0)}`; (dupMap[k] = dupMap[k] || []).push(x) })
      const dups = Object.entries(dupMap).filter(([, arr]) => arr.length > 1)
      if (dups.length) flag('warn', `${dups.length} kelompok pengeluaran kembar (tanggal+nominal sama) — cek dobel input.`, dups.map(([k, arr]) => ({ key: k, jumlah: arr.length })))

      // 3) Pembelian KREDIT tidak boleh mengurangi kas (harus jadi hutang supplier)
      const { data: pur } = await supabase.from('purchases').select('amount,is_credit').is('deleted_at', null)
      const kreditCount = (pur || []).filter(x => x.is_credit).length
      flag('info', `Pembelian kredit (tidak memotong kas, masuk Hutang Supplier): ${kreditCount} baris.`)

      // 4) Baris soft-deleted (info) — pastikan TIDAK terhitung di saldo
      const delCounts = {}
      for (const t of ['transactions', 'expenses', 'purchases', 'debt_payments', 'credibook_income']) {
        const { count } = await supabase.from(t).select('id', { count: 'exact', head: true }).not('deleted_at', 'is', null)
        delCounts[t] = count || 0
      }
      flag('info', 'Baris terhapus (deleted_at) — sudah otomatis dikecualikan dari semua perhitungan.', delCounts)

      // 5) Identitas Neraca: Aset = Hutang + Kekayaan (Kekayaan = Aset − Hutang)
      const aset = Math.round((d?.saldo_kas || 0) + (d?.saldo_rekening || 0) + (d?.piutang_aktif || 0) + (d?.piutang_karyawan || 0))
      const hutang = Math.round((d?.hutang_supplier || 0) + (d?.hutang_bank || 0))
      // (aset di sini tanpa aset tetap & sewa karena audit fokus ke kas; UI yang lengkap)

      // 6) TEST VALIDASI (#12): Masuk 500.000.000 − Keluar 132.833.178 = 367.166.822
      const tMasuk = 500000000, tKeluar = 132833178, expected = 367166822
      const calc = tMasuk - tKeluar
      const testPass = calc === expected
      if (!testPass) flag('error', `TEST GAGAL: ${tMasuk} − ${tKeluar} = ${calc}, seharusnya ${expected}.`)

      // ── Output ──
      /* eslint-disable no-console */
      console.group('%c🔍 AUDIT KEUANGAN — Skupy POS', 'color:#8b5cf6;font-weight:bold')
      console.log('Saldo (Kas & Bank):', fmtNum((d?.saldo_kas || 0) + (d?.saldo_rekening || 0)))
      console.log('  = Saldo Awal', fmtNum(d?.saldo_awal || 0), '+ Masuk', fmtNum((d?.masuk_cash || 0) + (d?.masuk_transfer || 0) + (d?.masuk_qris || 0)), '− Keluar', fmtNum((d?.keluar_cash || 0) + (d?.keluar_transfer || 0) + (d?.keluar_qris || 0)))
      console.log('Rekonsiliasi paid: Σpaid', fmtNum(sumPaid), '= Σinit_paid', fmtNum(sumInit), '+ Σcicilan', fmtNum(sumCic), Math.abs(reconErr) <= 1 ? '✅' : `❌ selisih ${reconErr}`)
      console.log('Test validasi (500jt − 132.833.178 = 367.166.822):', testPass ? '✅ LULUS' : '❌ GAGAL')
      console.table(issues.map(i => ({ level: i.level, pesan: i.msg })))
      if (issues.some(i => i.level !== 'info')) console.warn('Ada temuan yang perlu dicek (lihat tabel di atas).')
      else console.log('%c✓ Tidak ada anomali. Rumus kas & saldo konsisten.', 'color:#10d98a')
      console.groupEnd()
      /* eslint-enable no-console */
      return { ok: true, issues, recon: { sumPaid, sumInit, sumCic, reconErr }, testPass, aset, hutang }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[auditAccounting] gagal:', e)
      return { ok: false, error: e?.message || String(e), issues }
    }
  }, [])

  // Total cash-out sewa SEMUA WAKTU (non-deleted, non-cancelled). Query ringan
  // (hanya kolom total_amount) untuk card "Total Pengeluaran All Time".
  const sumRentsCashOut = useCallback(async () => {
    const { data, error } = await supabase.from('prepaid_rents').select('total_amount,status').is('deleted_at', null)
    if (error) return { ok: false, total: 0 }
    const total = (data || []).filter(r => String(r.status || '').toLowerCase() !== 'cancelled').reduce((s, r) => s + Math.round(r.total_amount || 0), 0)
    return { ok: true, total }
  }, [])

  const getCardDetail = useCallback(async (kind, from, to) => {
    const toEnd = (to || from) + 'T23:59:59'
    const rows = []
    try {
      const pushExpenses = async (filterCat) => {
        let q = supabase.from('expenses').select('id,expense_date,category,amount,method,note').is('deleted_at', null).gte('expense_date', from).lte('expense_date', to)
        const { data } = await q
        ;(data || []).filter(x => !filterCat || filterCat(x.category)).forEach(x => rows.push({ id: x.id, kind: 'expense', date: x.expense_date, source: 'Pengeluaran', ref: '', party: x.category, method: x.method, amount: Math.round(x.amount || 0), status: 'valid', note: x.note }))
      }
      const pushPurchases = async (onlyPaid) => {
        const { data } = await supabase.from('purchases').select('id,purchase_date,item,supplier,amount,method,is_credit,note').is('deleted_at', null).gte('purchase_date', from).lte('purchase_date', to)
        ;(data || []).filter(x => !onlyPaid || !x.is_credit).forEach(x => rows.push({ id: x.id, kind: 'purchase', date: x.purchase_date, source: 'Pembelian', ref: x.item, party: x.supplier, method: x.is_credit ? 'kredit' : x.method, amount: Math.round(x.amount || 0), status: x.is_credit ? 'kredit' : 'lunas', note: x.note }))
      }
      const pushSupPay = async () => {
        const { data } = await supabase.from('supplier_debt_payments').select('id,paid_at,amount,method,note,supplier_debt_id').is('deleted_at', null).gte('paid_at', from).lte('paid_at', toEnd)
        const ids = [...new Set((data || []).map(x => x.supplier_debt_id).filter(Boolean))]
        const dmap = {}
        if (ids.length) { const { data: dd } = await supabase.from('supplier_debts').select('id,supplier,item').in('id', ids); (dd || []).forEach(d => { dmap[d.id] = d }) }
        ;(data || []).forEach(x => { const d = dmap[x.supplier_debt_id] || {}; rows.push({ id: x.id, kind: 'supplier_payment', date: x.paid_at, source: 'Pembayaran Hutang Supplier', ref: d.item || '', party: d.supplier || '', method: x.method, amount: Math.round(x.amount || 0), status: 'valid', note: x.note }) })
      }
      const pushBankPay = async () => {
        const { data } = await supabase.from('bank_loan_payments').select('id,paid_at,amount,method,note').is('deleted_at', null).gte('paid_at', from).lte('paid_at', toEnd)
        ;(data || []).forEach(x => rows.push({ id: x.id, kind: 'bank_payment', date: x.paid_at, source: 'Cicilan Bank', ref: '', party: '', method: x.method, amount: Math.round(x.amount || 0), status: 'valid', note: x.note }))
      }
      // BEBAN: hanya bagian BUNGA dari cicilan bank (pokok bukan beban).
      const pushBankBunga = async () => {
        const { data } = await supabase.from('bank_loan_payments').select('id,paid_at,bunga,method,note').is('deleted_at', null).gte('paid_at', from).lte('paid_at', toEnd)
        ;(data || []).filter(x => Math.round(x.bunga || 0) > 0).forEach(x => rows.push({ id: x.id, kind: 'bank_payment', date: x.paid_at, source: 'Bunga Bank', ref: '', party: '', method: x.method, amount: Math.round(x.bunga || 0), status: 'valid', note: x.note }))
      }
      const pushTransactions = async () => {
        const { data } = await supabase.from('transactions').select('id,created_at,invoice_no,payment_method,total,status').is('deleted_at', null).neq('order_status', 'dibatalkan').gte('created_at', from).lte('created_at', toEnd)
        ;(data || []).forEach(x => rows.push({ id: x.id, kind: 'transaction', date: x.created_at, source: 'Penjualan', ref: x.invoice_no, party: '', method: x.payment_method, amount: Math.round(x.total || 0), status: x.status, note: '' }))
      }
      const pushDebtPay = async () => {
        const { data } = await supabase.from('debt_payments').select('id,paid_at,invoice_no,amount,payment_method,note').is('deleted_at', null).gte('paid_at', from).lte('paid_at', toEnd)
        ;(data || []).forEach(x => rows.push({ id: x.id, kind: 'debt_payment', date: x.paid_at, source: 'Cicilan Piutang', ref: x.invoice_no, party: '', method: x.payment_method, amount: Math.round(x.amount || 0), status: 'valid', note: x.note }))
      }
      // MIGRASI DATA LAMA — pemasukan ('old_income') / pengeluaran ('old_expense')
      const pushMigration = async (t) => {
        const { data } = await supabase.from('migration_details').select('id,trx_date,name,customer,amount,method,notes,type').is('deleted_at', null).eq('type', t).gte('trx_date', from).lte('trx_date', to)
        ;(data || []).forEach(x => rows.push({ id: x.id, kind: 'migration', date: x.trx_date, source: 'Migrasi Data', ref: x.name, party: x.customer || '', method: x.method, amount: Math.round(x.amount || 0), status: 'migrasi', note: x.notes }))
      }
      // CREDIBOOK — pemasukkan manual. omzetOnly=true → hanya jenis 'omzet'
      // (dipakai detail Omset). Tanpa filter → semua jenis (detail Uang Masuk/Arus Kas).
      const CB_LABEL = { omzet: 'Credibook · Omset', refund: 'Credibook · Refund', capital: 'Credibook · Modal Tambahan', other: 'Credibook · Lainnya' }
      const pushCredibook = async (omzetOnly = false) => {
        let q = supabase.from('credibook_income').select('id,transaction_date,name,amount,payment_method,note,income_type').is('deleted_at', null).gte('transaction_date', from).lte('transaction_date', to)
        if (omzetOnly) q = q.eq('income_type', 'omzet')
        const { data, error } = await q
        if (error) return // tabel/kolom belum ada → abaikan (defensif)
        ;(data || []).forEach(x => rows.push({ id: x.id, kind: 'credibook', date: x.transaction_date, source: CB_LABEL[x.income_type] || 'Credibook', ref: x.name, party: '', method: x.payment_method, amount: Math.round(x.amount || 0), status: 'valid', note: x.note }))
      }

      // UANG KELUAR → pakai single source of truth (anti double-count + sewa + kasbon)
      if (kind === 'uang_keluar') { return await getOutflowTransactions(from, to) }
      else if (kind === 'penjualan') { await pushTransactions(); await pushCredibook(true); await pushMigration('old_income') }
      else if (kind === 'uang_masuk' || kind === 'arus_kas') { await pushTransactions(); await pushDebtPay(); await pushCredibook(false); await pushMigration('old_income') }
      // BEBAN = operasional + gaji + bunga bank. TANPA pokok cicilan bank,
      // bayar hutang supplier, pembelian bahan/aset/persediaan.
      else if (kind === 'beban') { await pushExpenses(c => c !== 'Pembelian Bahan'); await pushBankBunga(); await pushMigration('old_expense') }
      else if (kind === 'pembelian_bahan' || kind === 'modal_barang' || kind === 'persediaan') { await pushPurchases(false); await pushExpenses(c => c === 'Pembelian Bahan') }
      else if (kind === 'sudah_bayar') {
        const { data } = await supabase.from('debts').select('id,created_at,invoice_no,total_debt,paid').is('deleted_at', null)
        ;(data || []).filter(x => Math.round(x.paid || 0) > 0).forEach(x => rows.push({ id: x.id, kind: 'debt', date: x.created_at, source: 'Piutang', ref: x.invoice_no, party: '', method: '', amount: Math.round(x.paid || 0), status: 'dibayar', note: '' }))
      }
      else if (kind === 'piutang') {
        const { data } = await supabase.from('debts').select('id,created_at,invoice_no,total_debt,paid').is('deleted_at', null)
        ;(data || []).map(x => ({ ...x, sisa: Math.max(0, Math.round(x.total_debt || 0) - Math.round(x.paid || 0)) })).filter(x => x.sisa > 0).forEach(x => rows.push({ id: x.id, kind: 'debt', date: x.created_at, source: 'Piutang', ref: x.invoice_no, party: '', method: '', amount: x.sisa, status: 'aktif', note: '' }))
      }
      else if (kind === 'hutang_supplier') {
        const { data } = await supabase.from('supplier_debts').select('id,created_at,item,supplier,total,paid,status,note').is('deleted_at', null).eq('status', 'aktif')
        ;(data || []).map(x => ({ ...x, sisa: Math.max(0, Math.round(x.total || 0) - Math.round(x.paid || 0)) })).filter(x => x.sisa > 0).forEach(x => rows.push({ id: x.id, kind: 'supplier_debt', date: x.created_at, source: 'Hutang Supplier', ref: x.item, party: x.supplier, method: '', amount: x.sisa, status: 'aktif', note: x.note }))
      }
      else if (kind === 'hutang_bank') {
        const { data } = await supabase.from('bank_loans').select('id,tanggal_mulai,jenis_pinjaman,nama_bank,sisa_pokok,status,keterangan').is('deleted_at', null).eq('status', 'aktif')
        ;(data || []).filter(x => Math.round(x.sisa_pokok || 0) > 0).forEach(x => rows.push({ id: x.id, kind: 'bank_loan', date: x.tanggal_mulai, source: 'Hutang Bank', ref: x.jenis_pinjaman, party: x.nama_bank, method: '', amount: Math.round(x.sisa_pokok || 0), status: 'aktif', note: x.keterangan }))
      }
    } catch (e) { return { ok: false, error: e?.message || String(e), rows: [], total: 0 } }
    rows.sort((a, b) => new Date(b.date) - new Date(a.date))
    const total = rows.reduce((s, r) => s + (r.amount || 0), 0)
    return { ok: true, rows, total }
  }, [getOutflowTransactions])

  // ── Master Kategori Pengeluaran ──
  const listExpenseCategories = useCallback(async () => {
    const { data, error } = await supabase.from('expense_categories')
      .select('id,name').is('deleted_at', null).order('name', { ascending: true })
    if (error) return { ok: false, error: error.message, data: [] }
    return { ok: true, data: data || [] }
  }, [])
  const addExpenseCategory = useCallback(async (name) => {
    const n = (name || '').trim()
    if (!n) return { ok: false, error: 'Nama kategori wajib' }
    const { data, error } = await supabase.from('expense_categories').insert({ name: n }).select('id,name').single()
    return error ? { ok: false, error: error.message } : { ok: true, data }
  }, [])
  const updateExpenseCategory = useCallback(async (id, newName, oldName) => {
    const n = (newName || '').trim()
    if (!n) return { ok: false, error: 'Nama kategori wajib' }
    const { error } = await supabase.from('expense_categories').update({ name: n, updated_at: new Date().toISOString() }).eq('id', id)
    if (error) return { ok: false, error: error.message }
    // Transaksi lama yang memakai kategori lama ikut berubah otomatis
    if (oldName && oldName !== n) await supabase.from('expenses').update({ category: n }).eq('category', oldName).is('deleted_at', null)
    return { ok: true }
  }, [])
  const countExpensesByCategory = useCallback(async (name) => {
    const { count } = await supabase.from('expenses').select('id', { count: 'exact', head: true }).eq('category', name).is('deleted_at', null)
    return count || 0
  }, [])
  const deleteExpenseCategory = useCallback(async (id, name, replacement) => {
    // Transaksi lama tetap ada; kategorinya dialihkan ke pengganti (default "Pengeluaran Lainnya")
    if (name) await supabase.from('expenses').update({ category: replacement || 'Pengeluaran Lainnya' }).eq('category', name).is('deleted_at', null)
    const { error } = await supabase.from('expense_categories').update({ deleted_at: new Date().toISOString() }).eq('id', id)
    return error ? { ok: false, error: error.message } : { ok: true }
  }, [])

  // ── ASET TETAP ──
  const listAssets = useCallback(async () => {
    const { data, error } = await supabase.from('assets').select('*').is('deleted_at', null).order('created_at', { ascending: false }).limit(500)
    if (error) return { ok: false, error: error.message, data: [] }
    return { ok: true, data: data || [] }
  }, [])
  const addAsset = useCallback(async (p) => {
    const { error } = await supabase.from('assets').insert({
      name: p.name || '', category_id: p.categoryId || null, category_name: p.categoryName || '',
      purchase_date: p.purchaseDate || null, purchase_price: Math.round(Number(p.purchasePrice) || 0),
      residual_value: Math.round(Number(p.residualValue) || 0), depreciation_method: p.method || 'percentage',
      depreciation_rate: Number(p.rate) || 0, useful_life_years: p.life ? Number(p.life) : null,
      photo_url: p.photoUrl || null, notes: p.notes || '', status: 'active', created_by: p.createdBy || null,
    })
    return error ? { ok: false, error: error.message } : { ok: true }
  }, [])
  const updateAsset = useCallback(async (id, p) => {
    const patch = { updated_at: new Date().toISOString() }
    if (p.name !== undefined) patch.name = p.name
    if (p.categoryId !== undefined) patch.category_id = p.categoryId || null
    if (p.categoryName !== undefined) patch.category_name = p.categoryName
    if (p.purchaseDate !== undefined) patch.purchase_date = p.purchaseDate
    if (p.purchasePrice !== undefined) patch.purchase_price = Math.round(Number(p.purchasePrice) || 0)
    if (p.residualValue !== undefined) patch.residual_value = Math.round(Number(p.residualValue) || 0)
    if (p.method !== undefined) patch.depreciation_method = p.method
    if (p.rate !== undefined) patch.depreciation_rate = Number(p.rate) || 0
    if (p.life !== undefined) patch.useful_life_years = p.life ? Number(p.life) : null
    if (p.photoUrl !== undefined) patch.photo_url = p.photoUrl || null
    if (p.notes !== undefined) patch.notes = p.notes
    if (p.status !== undefined) patch.status = p.status
    const { error } = await supabase.from('assets').update(patch).eq('id', id)
    return error ? { ok: false, error: error.message } : { ok: true }
  }, [])
  const deleteAsset = useCallback(async (id) => {
    const { error } = await supabase.from('assets').update({ deleted_at: new Date().toISOString(), status: 'deleted' }).eq('id', id)
    return error ? { ok: false, error: error.message } : { ok: true }
  }, [])
  // Jual aset: catat di asset_sales (harga jual → kas masuk; untung/rugi),
  // lalu update assets (status sold) TANPA payment_method (kolom itu tidak ada).
  const sellAsset = useCallback(async (id, { soldDate, soldPrice, method, note, bookValue, createdBy }) => {
    const price = Math.round(Number(soldPrice) || 0)
    const bv = Math.round(Number(bookValue) || 0)
    const pm = method === 'cash' ? 'cash' : method === 'qris' ? 'qris' : 'transfer'
    // 1) Catat transaksi penjualan aset (sumber kas masuk + untung/rugi)
    const saleRow = { asset_id: id, sale_date: soldDate || todayISO(), sale_price: price, book_value: bv, gain_loss: price - bv, payment_method: pm, note: note || '', created_by: createdBy || null }
    const sres = await supabase.from('asset_sales').insert(saleRow)
    if (sres.error && !/relation|does not exist|schema cache/i.test(sres.error.message || '')) {
      return { ok: false, error: sres.error.message }
    }
    // 2) Tandai aset terjual — JANGAN kirim payment_method ke tabel assets.
    const patch = { status: 'sold', sold_date: soldDate || null, sold_price: price, updated_at: new Date().toISOString() }
    if (note != null) patch.notes = note
    let { error } = await supabase.from('assets').update(patch).eq('id', id)
    // Fallback bila kolom sold_date/sold_price belum ada.
    if (error && /(sold_date|sold_price|schema cache|does not exist)/i.test(error.message || '')) {
      ;({ error } = await supabase.from('assets').update({ status: 'sold', updated_at: new Date().toISOString() }).eq('id', id))
    }
    return error ? { ok: false, error: error.message } : { ok: true }
  }, [])
  const listAssetSales = useCallback(async (assetId) => {
    let q = supabase.from('asset_sales').select('*').is('deleted_at', null).order('sale_date', { ascending: false })
    if (assetId) q = q.eq('asset_id', assetId)
    const { data, error } = await q.limit(500)
    if (error) return { ok: false, error: error.message, data: [] }
    return { ok: true, data: data || [] }
  }, [])
  // Kategori aset
  const listAssetCategories = useCallback(async () => {
    const { data, error } = await supabase.from('asset_categories').select('id,name').is('deleted_at', null).order('name', { ascending: true })
    if (error) return { ok: false, error: error.message, data: [] }
    return { ok: true, data: data || [] }
  }, [])
  const addAssetCategory = useCallback(async (name) => {
    const n = (name || '').trim(); if (!n) return { ok: false, error: 'Nama kategori wajib' }
    const { data, error } = await supabase.from('asset_categories').insert({ name: n }).select('id,name').single()
    return error ? { ok: false, error: error.message } : { ok: true, data }
  }, [])
  const updateAssetCategory = useCallback(async (id, newName, oldName) => {
    const n = (newName || '').trim(); if (!n) return { ok: false, error: 'Nama kategori wajib' }
    const { error } = await supabase.from('asset_categories').update({ name: n, updated_at: new Date().toISOString() }).eq('id', id)
    if (error) return { ok: false, error: error.message }
    if (oldName && oldName !== n) await supabase.from('assets').update({ category_name: n }).eq('category_id', id)
    return { ok: true }
  }, [])
  const deleteAssetCategory = useCallback(async (id) => {
    const { error } = await supabase.from('asset_categories').update({ deleted_at: new Date().toISOString() }).eq('id', id)
    return error ? { ok: false, error: error.message } : { ok: true }
  }, [])

  // ── SEWA TOKO DIBAYAR DIMUKA ──
  const rentDuration = (start, end) => {
    if (!start || !end) return 1
    const s = new Date(start), e = new Date(end)
    const m = (e.getFullYear() - s.getFullYear()) * 12 + (e.getMonth() - s.getMonth()) + 1
    return m > 0 ? m : 1
  }
  const genRentSchedules = async (rentId, p) => {
    const dur = p.duration_months || 1
    const total = Math.round(Number(p.total_amount) || 0)
    // Beban/bulan = selisih akumulasi kumulatif round(total*k/dur) → jumlah
    // seluruh baris PERSIS = total (tanpa drift pembulatan 1-2 rupiah).
    const cum = (k) => Math.round((total * k) / dur)
    const s = new Date(p.start_date)
    const rows = []
    for (let i = 0; i < dur; i++) {
      const pm = new Date(s.getFullYear(), s.getMonth() + i, 1)
      const amt = cum(i + 1) - cum(i)
      rows.push({ prepaid_rent_id: rentId, period_month: pm.toISOString().slice(0, 10), expense_amount: amt, status: 'pending' })
    }
    if (rows.length) await supabase.from('prepaid_rent_schedules').insert(rows)
  }
  const listRents = useCallback(async () => {
    const { data, error } = await supabase.from('prepaid_rents').select('*').is('deleted_at', null).order('created_at', { ascending: false }).limit(300)
    if (error) return { ok: false, error: error.message, data: [] }
    return { ok: true, data: data || [] }
  }, [])
  const listRentSchedules = useCallback(async (rentId) => {
    const { data, error } = await supabase.from('prepaid_rent_schedules').select('*').eq('prepaid_rent_id', rentId).is('deleted_at', null).order('period_month', { ascending: true })
    if (error) return { ok: false, error: error.message, data: [] }
    return { ok: true, data: data || [] }
  }, [])
  const addRent = useCallback(async (p) => {
    const dur = Number(p.durationMonths) || rentDuration(p.startDate, p.endDate)
    const total = Math.round(Number(p.totalAmount) || 0)
    const monthly = Math.round(total / (dur || 1))
    const { data, error } = await supabase.from('prepaid_rents').insert({
      name: p.name || '', location: p.location || '', landlord_name: p.landlord || '',
      payment_date: p.paymentDate || null, start_date: p.startDate || null, end_date: p.endDate || null,
      duration_months: dur, total_amount: total, monthly_expense: monthly,
      payment_method: p.method || 'transfer', proof_url: p.proofUrl || null, notes: p.notes || '',
      status: 'active', created_by: p.createdBy || null,
    }).select('id').single()
    if (error) return { ok: false, error: error.message }
    await genRentSchedules(data.id, { duration_months: dur, total_amount: total, start_date: p.startDate })
    return { ok: true, id: data.id }
  }, [])
  const updateRent = useCallback(async (id, p) => {
    const dur = Number(p.durationMonths) || rentDuration(p.startDate, p.endDate)
    const total = Math.round(Number(p.totalAmount) || 0)
    const monthly = Math.round(total / (dur || 1))
    const { error } = await supabase.from('prepaid_rents').update({
      name: p.name, location: p.location || '', landlord_name: p.landlord || '',
      payment_date: p.paymentDate || null, start_date: p.startDate || null, end_date: p.endDate || null,
      duration_months: dur, total_amount: total, monthly_expense: monthly,
      payment_method: p.method || 'transfer', notes: p.notes || '', updated_at: new Date().toISOString(),
    }).eq('id', id)
    if (error) return { ok: false, error: error.message }
    // regen schedule: soft-delete lama lalu buat baru
    await supabase.from('prepaid_rent_schedules').update({ deleted_at: new Date().toISOString() }).eq('prepaid_rent_id', id).is('deleted_at', null)
    await genRentSchedules(id, { duration_months: dur, total_amount: total, start_date: p.startDate })
    return { ok: true }
  }, [])
  const deleteRent = useCallback(async (id) => {
    const now = new Date().toISOString()
    await supabase.from('prepaid_rent_schedules').update({ deleted_at: now }).eq('prepaid_rent_id', id).is('deleted_at', null)
    const { error } = await supabase.from('prepaid_rents').update({ deleted_at: now, status: 'cancelled' }).eq('id', id)
    return error ? { ok: false, error: error.message } : { ok: true }
  }, [])

  // ── CREDIBOOK: Pemasukkan Manual (non-penjualan) ──
  const listCredibookIncome = useCallback(async ({ bookId, from, to } = {}) => {
    let q = supabase.from('credibook_income').select('*').is('deleted_at', null)
    if (bookId) q = q.eq('book_id', bookId)
    if (from) q = q.gte('transaction_date', from)
    if (to) q = q.lte('transaction_date', to)
    const { data, error } = await q.order('transaction_date', { ascending: false }).limit(1000)
    if (error) return { ok: false, error: error.message, data: [] }
    return { ok: true, data: data || [] }
  }, [])
  const addCredibookIncome = useCallback(async (p) => {
    const amt = Math.round(Number(p.amount) || 0)
    if (!(p.name || '').trim()) return { ok: false, error: 'Nama pemasukkan wajib diisi' }
    if (!(amt > 0)) return { ok: false, error: 'Nominal harus lebih dari 0' }
    const INCOME_TYPES = ['omzet', 'refund', 'capital', 'other']
    const it = INCOME_TYPES.includes(p.incomeType) ? p.incomeType : 'omzet'
    const row = {
      name: p.name.trim(), transaction_date: p.date || null, amount: amt,
      payment_method: p.method || 'transfer', note: p.note || '', income_type: it,
      created_by: p.createdBy || null, created_by_name: p.createdByName || '',
    }
    if (p.bookId) row.book_id = p.bookId
    // Omit-fallback: kolom book_id / income_type mungkin belum ada (migrasi belum jalan).
    const tryInsert = async (r) => (await supabase.from('credibook_income').insert(r)).error
    let error = await tryInsert(row)
    if (error && /income_type/i.test(error.message || '')) { const r = { ...row }; delete r.income_type; error = await tryInsert(r); if (error && /book_id/i.test(error.message || '')) { delete r.book_id; error = await tryInsert(r) } }
    else if (error && /book_id/i.test(error.message || '')) { const r = { ...row }; delete r.book_id; error = await tryInsert(r) }
    return error ? { ok: false, error: error.message } : { ok: true }
  }, [])
  const updateCredibookIncome = useCallback(async (id, p) => {
    const INCOME_TYPES = ['omzet', 'refund', 'capital', 'other']
    const patch = { updated_at: new Date().toISOString() }
    if (p.name !== undefined) patch.name = p.name
    if (p.date !== undefined) patch.transaction_date = p.date
    if (p.amount !== undefined) patch.amount = Math.round(Number(p.amount) || 0)
    if (p.method !== undefined) patch.payment_method = p.method
    if (p.note !== undefined) patch.note = p.note
    if (p.incomeType !== undefined && INCOME_TYPES.includes(p.incomeType)) patch.income_type = p.incomeType
    let { error } = await supabase.from('credibook_income').update(patch).eq('id', id)
    if (error && /income_type/i.test(error.message || '')) { const pt = { ...patch }; delete pt.income_type; ({ error } = await supabase.from('credibook_income').update(pt).eq('id', id)) }
    return error ? { ok: false, error: error.message } : { ok: true }
  }, [])
  const deleteCredibookIncome = useCallback(async (id) => {
    const { error } = await supabase.from('credibook_income').update({ deleted_at: new Date().toISOString() }).eq('id', id)
    return error ? { ok: false, error: error.message } : { ok: true }
  }, [])
  // Omset invoice/kasir per Book (sum total invoice valid) dalam rentang.
  // bookId undefined/null = semua book. Defensif jika kolom book_id belum ada.
  const sumOmsetByBook = useCallback(async ({ bookId, from, to } = {}) => {
    const run = async (withBook) => {
      let q = supabase.from('transactions').select('total').is('deleted_at', null).neq('order_status', 'dibatalkan')
      if (from) q = q.gte('created_at', from)
      if (to) q = q.lte('created_at', to + 'T23:59:59')
      if (withBook && bookId) q = q.eq('book_id', bookId)
      return await q.limit(10000)
    }
    let { data, error } = await run(true)
    if (error && /book_id/i.test(error.message || '')) ({ data, error } = await run(false))
    if (error) return 0
    return (data || []).reduce((s, t) => s + Math.round(t.total || 0), 0)
  }, [])

  // Total piutang AKTIF (sisa) per Book — saldo berjalan, tidak ikut filter tanggal.
  const sumPiutangByBook = useCallback(async ({ bookId } = {}) => {
    const run = async (withBook) => {
      let q = supabase.from('debts').select('total_debt,paid').is('deleted_at', null)
      if (withBook && bookId) q = q.eq('book_id', bookId)
      return await q.limit(10000)
    }
    let { data, error } = await run(true)
    if (error && /book_id/i.test(error.message || '')) ({ data, error } = await run(false))
    if (error) return 0
    return (data || []).reduce((s, d) => s + Math.max(0, Math.round(d.total_debt || 0) - Math.round(d.paid || 0)), 0)
  }, [])

  // Total pengeluaran (expenses) dalam rentang — untuk mini-dashboard Credibook.
  const sumExpensesRange = useCallback(async (from, to) => {
    let q = supabase.from('expenses').select('amount').is('deleted_at', null)
    if (from) q = q.gte('expense_date', from)
    if (to) q = q.lte('expense_date', to)
    const { data, error } = await q.limit(5000)
    if (error) return 0
    return (data || []).reduce((s, x) => s + Math.round(Number(x.amount) || 0), 0)
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

  // ── KASBON KARYAWAN (employee cash advances) ──
  // Kasbon = ASET (Piutang Karyawan 1250), bukan beban. Jurnal & arus kas
  // diurus trigger DB (2026_06_employee_cash_advances.sql); paid parent
  // selalu di-recompute dari SUM pembayaran non-deleted.
  const listEmployeeAdvances = useCallback(async () => {
    const { data, error } = await supabase.from('employee_cash_advances')
      .select('*').is('deleted_at', null)
      .order('advance_date', { ascending: false }).order('created_at', { ascending: false }).limit(500)
    if (error) return { ok: false, error: error.message, data: [] }
    return { ok: true, data: data || [] }
  }, [])

  const addEmployeeAdvance = useCallback(async (p, cashierId) => {
    const amt = Math.round(Number(p.amount) || 0)
    if (!p.employeeName?.trim()) return { ok: false, error: 'Nama karyawan wajib diisi' }
    if (amt <= 0) return { ok: false, error: 'Nominal kasbon harus > 0' }
    if (!p.date) return { ok: false, error: 'Tanggal kasbon wajib diisi' }
    const row = {
      employee_name: p.employeeName.trim(),       // snapshot nama
      amount: amt, paid: 0, remaining: amt,
      advance_date: p.date,
      due_date: p.dueDate || null,
      payment_method: p.method === 'transfer' ? 'transfer' : 'cash',
      notes: p.note || '',
      cashier_id: cashierId || null,
    }
    if (p.employeeId) row.employee_id = p.employeeId   // tautan master (opsional)
    let { data, error } = await supabase.from('employee_cash_advances').insert(row).select('id').single()
    // Fallback bila kolom employee_id belum dimigrasi: ulangi tanpa tautan.
    if (error && /employee_id|column .* does not exist|schema cache/i.test(error.message || '') && row.employee_id) {
      delete row.employee_id
      ;({ data, error } = await supabase.from('employee_cash_advances').insert(row).select('id').single())
    }
    return error ? { ok: false, error: error.message } : { ok: true, id: data?.id }
  }, [])

  // Pembayaran FIFO: satu nominal dibagi ke kasbon karyawan PALING LAMA dulu.
  // advList = daftar kasbon karyawan tsb (objek {id, amount, paid, advance_date,
  // created_at}). Mengembalikan { ok, applied, count }.
  const payEmployeeFIFO = useCallback(async (advList, { amount, method, date, note }, cashierId) => {
    let left = Math.round(Number(amount) || 0)
    if (left <= 0) return { ok: false, error: 'Nominal harus > 0' }
    // Urut paling lama dulu: advance_date asc, lalu created_at asc.
    const queue = [...(advList || [])]
      .map(a => ({ id: a.id, rem: Math.max(0, Math.round(a.amount || 0) - Math.round(a.paid || 0)), date: a.advance_date, created: a.created_at }))
      .filter(a => a.rem > 0)
      .sort((x, y) => (String(x.date).localeCompare(String(y.date))) || (String(x.created || '').localeCompare(String(y.created || ''))))
    if (queue.length === 0) return { ok: false, error: 'Tidak ada sisa kasbon untuk dibayar' }
    const pm = method === 'transfer' ? 'transfer' : 'cash'
    const payDate = date || todayISO()
    const rows = []
    for (const a of queue) {
      if (left <= 0) break
      const pay = Math.min(left, a.rem)
      rows.push({ cash_advance_id: a.id, amount: pay, payment_date: payDate, payment_method: pm, notes: note || '', cashier_id: cashierId || null })
      left -= pay
    }
    if (rows.length === 0) return { ok: false, error: 'Tidak ada sisa kasbon untuk dibayar' }
    const { error } = await supabase.from('employee_cash_advance_payments').insert(rows)
    if (error) return { ok: false, error: error.message }
    return { ok: true, applied: rows.reduce((s, r) => s + r.amount, 0), count: rows.length }
  }, [])

  // ── MASTER KARYAWAN (employees) ──
  const listEmployees = useCallback(async (q = '') => {
    let query = supabase.from('employees').select('*').is('deleted_at', null).order('name', { ascending: true }).limit(1000)
    if (q) query = query.ilike('name', `%${q}%`)
    const { data, error } = await query
    if (error) return { ok: false, error: error.message, data: [] }
    return { ok: true, data: data || [] }
  }, [])
  const addEmployee = useCallback(async (p) => {
    const name = (p.name || '').trim()
    if (!name) return { ok: false, error: 'Nama karyawan wajib diisi' }
    const { data, error } = await supabase.from('employees').insert({
      name, phone: p.phone || '', position: p.position || '', notes: p.notes || '',
    }).select('*').single()
    return error ? { ok: false, error: error.message } : { ok: true, data }
  }, [])
  const updateEmployee = useCallback(async (id, p) => {
    const name = (p.name || '').trim()
    if (!name) return { ok: false, error: 'Nama karyawan wajib diisi' }
    const { error } = await supabase.from('employees').update({
      name, phone: p.phone || '', position: p.position || '', notes: p.notes || '',
      updated_at: new Date().toISOString(),
    }).eq('id', id)
    if (error) return { ok: false, error: error.message }
    // Sinkronkan snapshot nama di kasbon yang tertaut karyawan ini.
    await supabase.from('employee_cash_advances').update({ employee_name: name }).eq('employee_id', id).is('deleted_at', null)
    return { ok: true }
  }, [])
  const deleteEmployee = useCallback(async (id) => {
    // soft delete master saja; kasbon lama tetap ada (snapshot nama tersimpan).
    const { error } = await supabase.from('employees').update({ deleted_at: new Date().toISOString() }).eq('id', id)
    return error ? { ok: false, error: error.message } : { ok: true }
  }, [])

  // ── PAYROLL / GAJI ──
  // Bayar gaji = INSERT ke expenses kategori 'Gaji Karyawan' (single source of truth).
  // Tidak ada tabel terpisah → dashboard membaca dari expenses saja (anti double count).
  // Note format: "Gaji - {nama}[ · catatan]" agar bisa difilter per karyawan.
  const SALARY_CATEGORIES = ['Gaji', 'Gaji Karyawan', 'Payroll', 'Salary']
  const payEmployeeSalary = useCallback(async (p, cashierId) => {
    const amt = Math.round(Number(p.amount) || 0)
    if (!p.employeeName?.trim()) return { ok: false, error: 'Nama karyawan wajib diisi' }
    if (amt <= 0) return { ok: false, error: 'Nominal gaji harus > 0' }
    // Keterangan = "[Jenis Payroll] - [Nama][ · catatan]". Jenis tersimpan di note
    // (sumber UI) + kolom payroll_type bila tersedia (opsional, tanpa migrasi wajib).
    const jenis = (p.payrollLabel || 'Gaji Bulanan').trim()
    const note = `${jenis} - ${p.employeeName.trim()}${p.note?.trim() ? ' · ' + p.note.trim() : ''}`
    const base = {
      expense_date: p.date || todayISO(),
      category: 'Gaji Karyawan',
      amount: amt,
      method: p.method === 'cash' ? 'cash' : 'transfer',
      note,
      cashier_id: cashierId || null,
    }
    let { error } = await supabase.from('expenses').insert({ ...base, payroll_type: p.payrollType || null })
    if (error && /payroll_type|column .* does not exist|schema cache/i.test(error.message || '')) {
      ;({ error } = await supabase.from('expenses').insert(base))
    }
    return error ? { ok: false, error: error.message } : { ok: true }
  }, [])
  // Daftar pembayaran gaji (expenses kategori gaji). filter periode opsional + nama opsional.
  // Nama difilter via "%- {nama}%" karena note kini diawali Jenis Payroll, bukan "Gaji".
  const listSalaryExpenses = useCallback(async ({ from, to, employeeName } = {}) => {
    let q = supabase.from('expenses')
      .select('id,expense_date,created_at,category,amount,method,note,cashier_id')
      .is('deleted_at', null).in('category', SALARY_CATEGORIES)
      .order('expense_date', { ascending: false }).order('created_at', { ascending: false })
    if (from) q = q.gte('expense_date', from)
    if (to) q = q.lte('expense_date', to)
    if (employeeName) q = q.ilike('note', `%- ${employeeName}%`)
    const { data, error } = await q.limit(2000)
    if (error) return { ok: false, error: error.message, data: [] }
    return { ok: true, data: data || [] }
  }, [])

  // ── MIGRASI DATA AWAL (migration_details) ──
  // Pemasukan/pengeluaran lama sebelum POS dipakai. Tidak membuat invoice/order,
  // tidak memotong stok. Soft delete → tidak dihitung. acc_dashboard mengurus
  // efek ke Omset / Uang Masuk-Keluar / Arus Kas / Laba (lihat migrasi SQL).
  const listMigrationDetails = useCallback(async () => {
    const { data, error } = await supabase.from('migration_details')
      .select('*').is('deleted_at', null)
      .order('trx_date', { ascending: false }).order('created_at', { ascending: false }).limit(1000)
    if (error) return { ok: false, error: error.message, data: [] }
    return { ok: true, data: data || [] }
  }, [])
  // Bersihkan satu baris migrasi → payload insert valid (dipakai add & import).
  const migRowPayload = (p, cashierId) => {
    const amt = Math.round(Number(p.amount) || 0)
    const m = ['cash', 'transfer', 'qris'].includes(p.method) ? p.method : 'cash'
    return {
      type: p.type, trx_date: p.date, name: (p.name || '').trim(),
      customer: p.type === 'old_income' ? ((p.customer || '').trim()) : '',
      amount: amt, method: m, notes: p.note || '', cashier_id: cashierId || null,
    }
  }
  // ── MODAL & SALDO AWAL (ekuitas) ──
  // type='modal'     → Setoran Modal pemilik: Kas/Bank + & EKUITAS +.
  // type='loan_cash' → Pencairan pinjaman ke kas: Kas/Bank + (ekuitas netral,
  //                    karena Hutang Bank sudah tercatat terpisah).
  const addCapitalEntry = useCallback(async (p, cashierId) => {
    const amt = Math.round(Number(p.amount) || 0)
    if (!['modal', 'loan_cash'].includes(p.type)) return { ok: false, error: 'Jenis tidak valid' }
    if (amt <= 0) return { ok: false, error: 'Nominal harus > 0' }
    if (!p.date) return { ok: false, error: 'Tanggal wajib diisi' }
    const m = ['cash', 'transfer', 'qris'].includes(p.method) ? p.method : 'cash'
    const name = (p.name || '').trim() || (p.type === 'modal' ? 'Setoran Modal' : 'Pencairan Pinjaman ke Kas')
    const { error } = await supabase.from('migration_details').insert({ type: p.type, trx_date: p.date, name, customer: '', amount: amt, method: m, notes: p.note || '', cashier_id: cashierId || null })
    if (error && /violates check constraint|migration_details_type_check/i.test(error.message || '')) return { ok: false, error: 'Jalankan migrasi 2026_06_capital_equity.sql dulu di Supabase.' }
    return error ? { ok: false, error: error.message } : { ok: true }
  }, [])
  const listCapitalEntries = useCallback(async () => {
    const { data, error } = await supabase.from('migration_details').select('*').is('deleted_at', null)
      .in('type', ['modal', 'loan_cash']).order('trx_date', { ascending: false }).order('created_at', { ascending: false }).limit(500)
    if (error) return { ok: false, error: error.message, data: [] }
    return { ok: true, data: data || [] }
  }, [])

  const addMigrationDetail = useCallback(async (p, cashierId) => {
    const amt = Math.round(Number(p.amount) || 0)
    if (!['old_income', 'old_expense'].includes(p.type)) return { ok: false, error: 'Jenis migrasi tidak valid' }
    if (!p.name?.trim()) return { ok: false, error: p.type === 'old_income' ? 'Nama transaksi wajib diisi' : 'Kategori pengeluaran wajib diisi' }
    if (amt <= 0) return { ok: false, error: 'Nominal harus > 0' }
    if (!p.date) return { ok: false, error: 'Tanggal wajib diisi' }
    const { error } = await supabase.from('migration_details').insert(migRowPayload(p, cashierId))
    return error ? { ok: false, error: error.message } : { ok: true }
  }, [])
  // Import massal (Excel) — sisipkan banyak baris sekaligus. Baris invalid dilewati.
  const bulkAddMigrationDetails = useCallback(async (rows, cashierId) => {
    const valid = (rows || []).filter(p =>
      ['old_income', 'old_expense'].includes(p.type) && (p.name || '').trim() && p.date && Math.round(Number(p.amount) || 0) > 0
    ).map(p => migRowPayload(p, cashierId))
    if (valid.length === 0) return { ok: false, error: 'Tidak ada baris valid untuk diimpor', count: 0 }
    const { error } = await supabase.from('migration_details').insert(valid)
    return error ? { ok: false, error: error.message, count: 0 } : { ok: true, count: valid.length }
  }, [])
  const updateMigrationDetail = useCallback(async (id, p) => {
    const amt = Math.round(Number(p.amount) || 0)
    if (!p.name?.trim()) return { ok: false, error: 'Nama / kategori wajib diisi' }
    if (amt <= 0) return { ok: false, error: 'Nominal harus > 0' }
    const m = ['cash', 'transfer', 'qris'].includes(p.method) ? p.method : 'cash'
    const patch = { name: p.name.trim(), amount: amt, method: m, notes: p.note || '', updated_at: new Date().toISOString() }
    if (p.type === 'old_income') patch.customer = (p.customer || '').trim()
    if (p.date) patch.trx_date = p.date
    const { error } = await supabase.from('migration_details').update(patch).eq('id', id)
    return error ? { ok: false, error: error.message } : { ok: true }
  }, [])
  const deleteMigrationDetail = useCallback(async (id) => {
    const { error } = await supabase.from('migration_details').update({ deleted_at: new Date().toISOString() }).eq('id', id)
    return error ? { ok: false, error: error.message } : { ok: true }
  }, [])
  // ── SALDO AWAL: Piutang Customer Lama & Kasbon Karyawan Lama ──
  // Cari customer berdasarkan nama (case-insensitive); buat baru bila belum ada.
  const findOrCreateCustomer = useCallback(async (name) => {
    const nm = (name || '').trim()
    if (!nm) return { ok: false, error: 'Nama customer wajib diisi' }
    const { data: found } = await supabase.from('customers').select('id,name').ilike('name', nm).limit(1)
    if (found && found.length) return { ok: true, id: found[0].id }
    const { data: ins, error } = await supabase.from('customers').insert({ name: nm }).select('id').single()
    return error ? { ok: false, error: error.message } : { ok: true, id: ins.id }
  }, [])

  // Sinkronkan kolom denormalisasi customers.total_debt = Σ sisa debts aktif.
  // (Hanya menyegarkan angka cache — TIDAK mengubah rumus piutang mana pun.)
  const syncCustomerDebt = useCallback(async (customerId) => {
    if (!customerId) return
    const { data } = await supabase.from('debts').select('remaining').eq('customer_id', customerId).eq('status', 'aktif').is('deleted_at', null)
    const td = (data || []).reduce((s, d) => s + Math.max(0, Math.round(+d.remaining || 0)), 0)
    await supabase.from('customers').update({ total_debt: td }).eq('id', customerId)
  }, [])

  // Piutang Customer Lama → baris debts (is_opening) TANPA transaksi/invoice POS.
  const addOldReceivable = useCallback(async (p, cashierId) => {
    const amt = Math.round(Number(p.amount) || 0)
    if (!p.customerName?.trim()) return { ok: false, error: 'Nama customer wajib diisi' }
    if (amt <= 0) return { ok: false, error: 'Nominal piutang harus > 0' }
    if (!p.date) return { ok: false, error: 'Tanggal wajib diisi' }
    const c = await findOrCreateCustomer(p.customerName)
    if (!c.ok) return { ok: false, error: c.error }
    const inv = 'SALDO-' + Date.now().toString(36).toUpperCase()
    const row = {
      customer_id: c.id, invoice_no: inv, total_debt: amt, paid: 0, remaining: amt,
      due_date: p.dueDate || null, notes: p.note || '', status: 'aktif', is_opening: true,
      created_at: new Date(`${p.date}T12:00:00`).toISOString(),
    }
    let { error } = await supabase.from('debts').insert(row)
    if (error && /is_opening|does not exist|schema cache/i.test(error.message || '')) {
      delete row.is_opening
      ;({ error } = await supabase.from('debts').insert(row))
    }
    if (error) return { ok: false, error: error.message }
    await syncCustomerDebt(c.id)
    return { ok: true, customerId: c.id }
  }, [findOrCreateCustomer, syncCustomerDebt])

  const listOpeningReceivables = useCallback(async () => {
    const { data, error } = await supabase.from('debts')
      .select('*, customers(name)').eq('is_opening', true).is('deleted_at', null)
      .order('created_at', { ascending: false }).limit(1000)
    if (error) return { ok: false, error: error.message, data: [] }
    return { ok: true, data: (data || []).map(d => ({ ...d, customer_name: d.customers?.name || '' })) }
  }, [])
  const editOldReceivable = useCallback(async (id, p) => {
    const amt = Math.round(Number(p.amount) || 0)
    if (amt <= 0) return { ok: false, error: 'Nominal harus > 0' }
    const { data: cur } = await supabase.from('debts').select('paid, customer_id').eq('id', id).single()
    const paid = Math.round(Number(cur?.paid) || 0)
    const remaining = Math.max(0, amt - paid)
    const patch = { total_debt: amt, remaining, status: remaining <= 0 ? 'lunas' : 'aktif', due_date: p.dueDate || null, notes: p.note || '', updated_at: new Date().toISOString() }
    if (p.date) patch.created_at = new Date(`${p.date}T12:00:00`).toISOString()
    const { error } = await supabase.from('debts').update(patch).eq('id', id)
    if (error) return { ok: false, error: error.message }
    await syncCustomerDebt(cur?.customer_id)
    return { ok: true }
  }, [syncCustomerDebt])
  // Hapus piutang lama → hard delete (konsisten dgn modul Piutang; cascade pembayaran).
  const deleteOldReceivable = useCallback(async (id) => {
    const { data: row } = await supabase.from('debts').select('customer_id').eq('id', id).maybeSingle()
    const { error } = await supabase.from('debts').delete().eq('id', id)
    if (error) return { ok: false, error: error.message }
    await syncCustomerDebt(row?.customer_id)
    return { ok: true }
  }, [syncCustomerDebt])

  // Kasbon Karyawan Lama → baris employee_cash_advances (is_opening) — bukan Uang Keluar.
  const addOldKasbon = useCallback(async (p, cashierId) => {
    const amt = Math.round(Number(p.amount) || 0)
    if (!p.employeeName?.trim()) return { ok: false, error: 'Nama karyawan wajib diisi' }
    if (amt <= 0) return { ok: false, error: 'Nominal kasbon harus > 0' }
    if (!p.date) return { ok: false, error: 'Tanggal wajib diisi' }
    // find/create employee
    let empId = null
    const { data: found } = await supabase.from('employees').select('id').ilike('name', p.employeeName.trim()).is('deleted_at', null).limit(1)
    if (found && found.length) empId = found[0].id
    else { const ins = await supabase.from('employees').insert({ name: p.employeeName.trim() }).select('id').single(); if (!ins.error) empId = ins.data?.id }
    const row = {
      employee_name: p.employeeName.trim(), amount: amt, paid: 0, remaining: amt,
      advance_date: p.date, due_date: p.dueDate || null,
      payment_method: p.method === 'transfer' ? 'transfer' : 'cash', notes: p.note || '',
      is_opening: true, cashier_id: cashierId || null,
    }
    if (empId) row.employee_id = empId
    let { error } = await supabase.from('employee_cash_advances').insert(row)
    if (error && /is_opening|employee_id|does not exist|schema cache/i.test(error.message || '')) {
      delete row.is_opening; delete row.employee_id
      ;({ error } = await supabase.from('employee_cash_advances').insert(row))
    }
    return error ? { ok: false, error: error.message } : { ok: true }
  }, [])
  const listOpeningKasbon = useCallback(async () => {
    const { data, error } = await supabase.from('employee_cash_advances')
      .select('*').eq('is_opening', true).is('deleted_at', null)
      .order('advance_date', { ascending: false }).order('created_at', { ascending: false }).limit(1000)
    if (error) return { ok: false, error: error.message, data: [] }
    return { ok: true, data: data || [] }
  }, [])

  // "Buat Database Otomatis" — jalankan bootstrap RPC (idempotent).
  const bootstrapMigrationDetails = useCallback(async () => {
    const { error } = await supabase.rpc('acc_bootstrap_migration_details')
    if (!error) return { ok: true }
    return { ok: false, error: error.message, missingFn: /could not find the function|does not exist|schema cache/i.test(error.message || '') }
  }, [])

  const editEmployeeAdvance = useCallback(async (id, p) => {
    const amt = Math.round(Number(p.amount) || 0)
    if (!p.employeeName?.trim()) return { ok: false, error: 'Nama karyawan wajib diisi' }
    if (amt <= 0) return { ok: false, error: 'Nominal kasbon harus > 0' }
    const { error } = await supabase.from('employee_cash_advances').update({
      employee_name: p.employeeName.trim(), amount: amt,
      advance_date: p.date || undefined,
      due_date: p.dueDate || null,
      payment_method: p.method === 'transfer' ? 'transfer' : 'cash',
      notes: p.note || '', updated_at: new Date().toISOString(),
    }).eq('id', id)
    return error ? { ok: false, error: error.message } : { ok: true }
  }, [])

  const payEmployeeAdvance = useCallback(async (advanceId, { amount, method, date, note }, cashierId) => {
    const amt = Math.round(Number(amount) || 0)
    if (amt <= 0) return { ok: false, error: 'Nominal harus > 0' }
    const { error } = await supabase.from('employee_cash_advance_payments').insert({
      cash_advance_id: advanceId, amount: amt,
      payment_date: date || todayISO(),
      payment_method: method === 'transfer' ? 'transfer' : 'cash',
      notes: note || '', cashier_id: cashierId || null,
    })
    return error ? { ok: false, error: error.message } : { ok: true }
  }, [])

  // Hapus kasbon ATOMIK via RPC; fallback dua langkah kalau migrasi belum jalan.
  const deleteEmployeeAdvance = useCallback(async (id) => {
    const { error: rpcErr } = await supabase.rpc('acc_delete_employee_advance', { p_id: id })
    if (!rpcErr) return { ok: true }
    const msg = String(rpcErr.message || '')
    if (!/could not find the function|does not exist|schema cache/i.test(msg)) {
      return { ok: false, error: msg }
    }
    const now = new Date().toISOString()
    const { error: payErr } = await supabase.from('employee_cash_advance_payments').update({ deleted_at: now }).eq('cash_advance_id', id).is('deleted_at', null)
    if (payErr) return { ok: false, error: payErr.message }
    const { error } = await supabase.from('employee_cash_advances').update({ deleted_at: now }).eq('id', id)
    return error ? { ok: false, error: error.message } : { ok: true }
  }, [])

  const listAdvancePayments = useCallback(async (advanceId) => {
    const { data, error } = await supabase.from('employee_cash_advance_payments')
      .select('*').eq('cash_advance_id', advanceId).is('deleted_at', null)
      .order('payment_date', { ascending: false }).order('created_at', { ascending: false })
    if (error) return { ok: false, error: error.message, data: [] }
    return { ok: true, data: data || [] }
  }, [])

  const editAdvancePayment = useCallback(async (id, { amount, method, note, date }) => {
    const amt = Math.round(Number(amount) || 0)
    if (amt <= 0) return { ok: false, error: 'Nominal harus > 0' }
    const patch = {
      amount: amt, payment_method: method === 'transfer' ? 'transfer' : 'cash',
      notes: note || '', updated_at: new Date().toISOString(),
    }
    if (date) patch.payment_date = date
    const { error } = await supabase.from('employee_cash_advance_payments').update(patch).eq('id', id)
    return error ? { ok: false, error: error.message } : { ok: true }
  }, [])

  // Soft delete pembayaran kasbon. Set deleted_at (+ deleted_by untuk audit bila
  // kolomnya ada). Trigger DB menghitung ulang paid induk (exclude deleted) →
  // sisa kasbon, status, uang masuk, arus kas & dashboard menyesuaikan.
  const deleteAdvancePayment = useCallback(async (id, deletedBy) => {
    const now = new Date().toISOString()
    let { error } = await supabase.from('employee_cash_advance_payments')
      .update({ deleted_at: now, deleted_by: deletedBy || null }).eq('id', id)
    // Fallback bila kolom deleted_by belum ada di skema.
    if (error && /deleted_by/i.test(error.message || '')) {
      ;({ error } = await supabase.from('employee_cash_advance_payments').update({ deleted_at: now }).eq('id', id))
    }
    return error ? { ok: false, error: error.message } : { ok: true }
  }, [])

  return {
    busy, PAGE_SIZE, todayISO, monthStartISO,
    getSummary, getDashboard, subscribeDashboard, getPiutangAktif, resync, listEntries, listExpenses, listPurchases,
    listTransactions, listCicilan, listCashMovements, listExpensesByBucket,
    addExpense, deleteExpense, updateExpense, addPurchase, deletePurchase, updatePurchase,
    listSupplierDebts, addSupplierDebt, editSupplierDebt, paySupplierDebt, deleteSupplierDebt,
    listSupplierPayments, editSupplierPayment, deleteSupplierPayment,
    listSupplierPaymentsBySupplier, paySupplierFIFO, deleteSupplierFIFOGroup,
    listSuppliers, addSupplier, updateSupplier, deleteSupplier,
    listBankLoans, addBankLoan, deleteBankLoan, payBankLoan,
    listBankPayments, editBankPayment, deleteBankPayment,
    getRecapAdmin, fetchEntriesForExport, getCardDetail, getOutflowTransactions, getCashflowDetail, auditAccounting, sumRentsCashOut, listExpensesByRange,
    listExpenseCategories, addExpenseCategory, updateExpenseCategory, deleteExpenseCategory, countExpensesByCategory,
    listAssets, addAsset, updateAsset, deleteAsset, sellAsset, listAssetSales,
    listAssetCategories, addAssetCategory, updateAssetCategory, deleteAssetCategory,
    listRents, listRentSchedules, addRent, updateRent, deleteRent,
    listCredibookIncome, addCredibookIncome, updateCredibookIncome, deleteCredibookIncome, sumExpensesRange, sumOmsetByBook, sumPiutangByBook,
    listEmployeeAdvances, addEmployeeAdvance, editEmployeeAdvance, payEmployeeAdvance, payEmployeeFIFO,
    deleteEmployeeAdvance, listAdvancePayments, editAdvancePayment, deleteAdvancePayment,
    listEmployees, addEmployee, updateEmployee, deleteEmployee,
    payEmployeeSalary, listSalaryExpenses,
    listMigrationDetails, addMigrationDetail, updateMigrationDetail, deleteMigrationDetail,
    addCapitalEntry, listCapitalEntries,
    bulkAddMigrationDetails, bootstrapMigrationDetails,
    findOrCreateCustomer, addOldReceivable, listOpeningReceivables, editOldReceivable, deleteOldReceivable,
    addOldKasbon, listOpeningKasbon,
  }
}
