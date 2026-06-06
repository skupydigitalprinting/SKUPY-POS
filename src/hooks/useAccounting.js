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

  return {
    busy, PAGE_SIZE, todayISO, monthStartISO,
    getSummary, listEntries, listExpenses, listPurchases,
    addExpense, deleteExpense, addPurchase, deletePurchase,
  }
}
