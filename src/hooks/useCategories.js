// ─────────────────────────────────────────────────────────────
// useCategories — kategori produk. SUMBER UTAMA: tabel Supabase
// `product_categories`. TIDAK memakai localStorage sebagai cache permanen
// (cache lama dibersihkan). Default hanya dipakai untuk paint pertama
// sebelum DB merespons / bila DB benar-benar kosong.
//
// Reaktif lewat useSyncExternalStore + realtime Supabase: tambah/edit/
// nonaktifkan kategori → SEMUA komponen (Produk, Kasir, Dashboard, Pengaturan)
// langsung update tanpa refresh.
// ─────────────────────────────────────────────────────────────
import { useSyncExternalStore, useEffect } from 'react'
import { PRODUCT_CATEGORIES } from '../data/dummyData'
import { supabase, isSupabaseConfigured } from '../lib/supabase'

// Bersihkan cache lama localStorage (kategori tidak lagi disimpan permanen).
try { localStorage.removeItem('skupy_categories_v1') } catch { /* ignore */ }

export const ALL_CATEGORY = { id: 'all', label: 'Semua', icon: '🎨' }

function seed() {
  return PRODUCT_CATEGORIES.map((c) => ({ id: c.id, label: c.label, icon: c.icon, color: null, thumbnail: null, active: true }))
}

// cats = kategori AKTIF (untuk dropdown/filter, reaktif).
let cats = seed()
// metaById = meta SEMUA kategori (termasuk nonaktif & terhapus) → produk lama
// tetap menampilkan nama/icon kategori terakhir.
let metaById = Object.fromEntries(cats.map((c) => [c.id, { label: c.label, icon: c.icon, color: c.color }]))
const listeners = new Set()

function emit() { listeners.forEach((l) => l()) }
function subscribe(cb) { listeners.add(cb); return () => listeners.delete(cb) }
function getSnapshot() { return cats }
function mergeMeta(rows) {
  metaById = { ...metaById, ...Object.fromEntries(rows.map((c) => [c.id, { label: c.label, icon: c.icon || '📦', color: c.color || null }])) }
}
function setCats(next, metaRows) {
  cats = next
  if (metaRows) mergeMeta(metaRows)
  else mergeMeta(next.map((c) => ({ id: c.id, label: c.label, icon: c.icon, color: c.color })))
  emit()
}

// ── DB sebagai sumber utama ──
let dbLoaded = false
async function loadProductCategories() {
  if (!isSupabaseConfigured) return
  try {
    // Ambil SEMUA baris (termasuk nonaktif & terhapus) untuk peta nama/icon,
    // supaya produk lama tetap menampilkan nama kategori terakhir.
    const { data, error } = await supabase
      .from('product_categories').select('*')
      .order('sort_order', { ascending: true }).order('label', { ascending: true })
    if (error || !Array.isArray(data)) return
    mergeMeta(data)
    const active = data
      .filter((c) => !c.deleted_at && c.is_active !== false)
      .map((c) => ({ id: c.id, label: c.label, icon: c.icon || '📦', color: c.color || null, thumbnail: c.thumbnail_url || null, active: true }))
    dbLoaded = true
    if (data.length) { cats = active; emit() }
  } catch { /* offline → tetap pakai default in-memory */ }
}
// alias kompatibilitas
export function refreshCategories() { return loadProductCategories() }
export { loadProductCategories }

// muat sekali saat modul dievaluasi + langganan realtime
loadProductCategories()
let realtimeStarted = false
function startRealtime() {
  if (realtimeStarted || !isSupabaseConfigured) return
  realtimeStarted = true
  try {
    supabase.channel('product-categories-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'product_categories' }, () => { loadProductCategories() })
      .subscribe()
  } catch { /* realtime opsional */ }
}
startRealtime()

function slugify(s) {
  return (
    String(s).toLowerCase().trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'kategori'
  )
}

export function addCategory({ label, icon, color, thumbnail, active = true }) {
  const name = (label || '').trim()
  if (!name) return { ok: false, error: 'Nama kategori wajib diisi' }
  if (cats.some((c) => c.label.toLowerCase() === name.toLowerCase())) {
    return { ok: false, error: 'Kategori dengan nama itu sudah ada' }
  }
  let id = slugify(name)
  if (cats.some((c) => c.id === id) || metaById[id]) {
    let n = 2
    while (cats.some((c) => c.id === `${id}-${n}`) || metaById[`${id}-${n}`]) n++
    id = `${id}-${n}`
  }
  const icn = (icon || '').trim() || '📦'
  const item = { id, label: name, icon: icn, color: color || null, thumbnail: thumbnail || null, active: !!active }
  mergeMeta([{ id, label: name, icon: icn, color: color || null }])
  if (active) setCats([...cats, item])
  else emit()
  if (isSupabaseConfigured) {
    supabase.from('product_categories')
      .upsert({ id, label: name, icon: icn, color: color || null, thumbnail_url: thumbnail || null, is_active: !!active, sort_order: cats.length, deleted_at: null, updated_at: new Date().toISOString() })
      .then(({ error }) => { if (error) console.warn('[categories] gagal simpan ke DB:', error.message) })
  }
  return { ok: true, id }
}

export function updateCategory(id, { label, icon, color, thumbnail, active }) {
  const name = label != null ? String(label).trim() : null
  if (name === '') return { ok: false, error: 'Nama kategori tidak boleh kosong' }
  if (name && cats.some((c) => c.id !== id && c.label.toLowerCase() === name.toLowerCase())) {
    return { ok: false, error: 'Kategori dengan nama itu sudah ada' }
  }
  // selalu segarkan meta (nama/icon terbaru) → list & dashboard ikut berubah
  const prevMeta = metaById[id] || {}
  mergeMeta([{ id, label: name || prevMeta.label || id, icon: (icon != null ? String(icon).trim() : '') || prevMeta.icon || '📦', color: color !== undefined ? color : prevMeta.color }])
  const exists = cats.some((c) => c.id === id)
  let next
  if (active === false) {
    next = cats.filter((c) => c.id !== id)
  } else if (active === true && !exists) {
    const m = metaById[id]
    next = [...cats, { id, label: m.label, icon: m.icon, color: m.color || null, thumbnail: thumbnail || null, active: true }]
  } else {
    next = cats.map((c) => c.id === id ? {
      ...c,
      label: name || c.label,
      icon: icon != null ? (String(icon).trim() || c.icon) : c.icon,
      color: color !== undefined ? (color || null) : c.color,
      thumbnail: thumbnail !== undefined ? (thumbnail || null) : c.thumbnail,
    } : c)
  }
  setCats(next)
  if (isSupabaseConfigured) {
    const payload = { id, updated_at: new Date().toISOString() }
    if (name) payload.label = name
    if (icon !== undefined) payload.icon = (String(icon).trim() || '📦')
    if (color !== undefined) payload.color = color || null
    if (thumbnail !== undefined) payload.thumbnail_url = thumbnail || null
    if (active !== undefined) payload.is_active = !!active
    supabase.from('product_categories').upsert(payload)
      .then(({ error }) => { if (error) console.warn('[categories] gagal update di DB:', error.message) })
  }
  return { ok: true }
}

export function setCategoryActive(id, active) {
  return updateCategory(id, { active: !!active })
}

export function deleteCategory(id) {
  if (cats.length <= 1) return { ok: false, error: 'Minimal harus ada 1 kategori aktif' }
  setCats(cats.filter((c) => c.id !== id)) // metaById tetap simpan nama → produk lama aman
  if (isSupabaseConfigured) {
    supabase.from('product_categories').update({ deleted_at: new Date().toISOString() }).eq('id', id)
      .then(({ error }) => { if (error) console.warn('[categories] gagal hapus di DB:', error.message) })
  }
  return { ok: true }
}

// Daftar LENGKAP (aktif + nonaktif, non-deleted) untuk halaman manajemen.
export async function listAllCategories() {
  if (!isSupabaseConfigured) return getCategories().map((c) => ({ ...c, active: c.active !== false }))
  try {
    const { data, error } = await supabase
      .from('product_categories').select('*').is('deleted_at', null)
      .order('sort_order', { ascending: true }).order('label', { ascending: true })
    if (error || !Array.isArray(data)) return getCategories()
    mergeMeta(data)
    return data.map((c) => ({ id: c.id, label: c.label, icon: c.icon || '📦', color: c.color || null, thumbnail: c.thumbnail_url || null, active: c.is_active !== false }))
  } catch { return getCategories() }
}

// Getter biasa (untuk util non-React seperti excelExport).
export function getCategories() { return cats }
export function getCatLabel(id) {
  return metaById[id]?.label || cats.find((c) => c.id === id)?.label || id || '-'
}
// Meta lengkap (label, icon, color) — termasuk kategori nonaktif/terhapus.
export function getCatMeta(id) {
  const m = metaById[id]
  if (m) return { label: m.label, icon: m.icon || '📦', color: m.color || null }
  const c = cats.find((x) => x.id === id)
  return { label: c?.label || id || '-', icon: c?.icon || '📦', color: c?.color || null }
}

export function useCategories() {
  const categories = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  useEffect(() => { if (!dbLoaded) loadProductCategories(); startRealtime() }, [])
  return { categories, addCategory, updateCategory, deleteCategory, setCategoryActive, listAllCategories, refreshCategories, loadProductCategories }
}
