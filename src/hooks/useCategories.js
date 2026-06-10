// ─────────────────────────────────────────────────────────────
// useCategories — kategori produk (CRUD). SUMBER UTAMA: tabel Supabase
// `product_categories`. localStorage hanya CACHE OFFLINE supaya UI tidak
// kosong sebelum DB merespons. Pola: optimistic update (UI langsung berubah)
// + tulis ke DB di background → realtime dalam sesi, persisten lintas device.
//
// Memakai useSyncExternalStore agar SEMUA komponen (Produk, Kasir, Dashboard)
// ikut ter-update otomatis saat kategori berubah — tanpa reload halaman.
// ─────────────────────────────────────────────────────────────
import { useSyncExternalStore, useEffect } from 'react'
import { PRODUCT_CATEGORIES } from '../data/dummyData'
import { supabase, isSupabaseConfigured } from '../lib/supabase'

const KEY = 'skupy_categories_v1'

// Kategori "Semua" untuk bar filter — tidak bisa diedit / dihapus.
export const ALL_CATEGORY = { id: 'all', label: 'Semua', icon: '🎨' }

function seed() {
  // Default mengikuti kategori bawaan (tanpa "Semua").
  return PRODUCT_CATEGORIES.map((c) => ({ id: c.id, label: c.label, icon: c.icon }))
}

function load() {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return seed()
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed) && parsed.length) {
      return parsed
        .filter((c) => c && c.id && c.id !== 'all')
        .map((c) => ({ id: String(c.id), label: String(c.label || c.id), icon: c.icon || '📦' }))
    }
    return seed()
  } catch {
    return seed()
  }
}

let cats = load()
// Map id→label dari SEMUA kategori (termasuk yang sudah dihapus) supaya produk
// lama tetap menampilkan nama kategori terakhir walau kategori dihapus.
let labelById = Object.fromEntries(cats.map((c) => [c.id, c.label]))
const listeners = new Set()

function persist() {
  try { localStorage.setItem(KEY, JSON.stringify(cats)) } catch { /* ignore */ }
}
function emit() {
  persist()
  listeners.forEach((l) => l())
}
function subscribe(cb) {
  listeners.add(cb)
  return () => listeners.delete(cb)
}
function getSnapshot() { return cats }
function setCats(next) {
  cats = next
  // gabungkan (jangan buang label lama) → label kategori terhapus tetap dikenal
  labelById = { ...labelById, ...Object.fromEntries(next.map((c) => [c.id, c.label])) }
  emit()
}

// ── DB sebagai sumber utama ──
let dbLoaded = false
async function loadFromDB() {
  if (!isSupabaseConfigured) return
  try {
    const { data, error } = await supabase
      .from('product_categories').select('*')
      .order('sort_order', { ascending: true }).order('label', { ascending: true })
    if (error || !Array.isArray(data)) return
    // label map dari SEMUA baris (termasuk deleted) → produk lama tetap ada nama
    labelById = { ...labelById, ...Object.fromEntries(data.map((c) => [c.id, c.label])) }
    const active = data.filter((c) => !c.deleted_at).map((c) => ({ id: c.id, label: c.label, icon: c.icon || '📦' }))
    dbLoaded = true
    if (active.length) { cats = active; emit() }
  } catch { /* offline → tetap pakai cache localStorage */ }
}
// muat sekali saat modul dievaluasi (app start)
loadFromDB()
export function refreshCategories() { return loadFromDB() }

function slugify(s) {
  return (
    String(s).toLowerCase().trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'kategori'
  )
}

export function addCategory({ label, icon }) {
  const name = (label || '').trim()
  if (!name) return { ok: false, error: 'Nama kategori wajib diisi' }
  if (cats.some((c) => c.label.toLowerCase() === name.toLowerCase())) {
    return { ok: false, error: 'Kategori dengan nama itu sudah ada' }
  }
  let id = slugify(name)
  if (cats.some((c) => c.id === id) || labelById[id]) {
    let n = 2
    while (cats.some((c) => c.id === `${id}-${n}`) || labelById[`${id}-${n}`]) n++
    id = `${id}-${n}`
  }
  const icn = (icon || '').trim() || '📦'
  setCats([...cats, { id, label: name, icon: icn }])
  // tulis ke DB (background) — upsert + restore deleted_at=null bila id pernah dipakai
  if (isSupabaseConfigured) {
    supabase.from('product_categories')
      .upsert({ id, label: name, icon: icn, sort_order: cats.length, deleted_at: null, updated_at: new Date().toISOString() })
      .then(({ error }) => { if (error) console.warn('[categories] gagal simpan ke DB:', error.message) })
  }
  return { ok: true, id }
}

export function updateCategory(id, { label, icon }) {
  const name = label != null ? String(label).trim() : null
  if (name === '') return { ok: false, error: 'Nama kategori tidak boleh kosong' }
  if (name && cats.some((c) => c.id !== id && c.label.toLowerCase() === name.toLowerCase())) {
    return { ok: false, error: 'Kategori dengan nama itu sudah ada' }
  }
  const next = cats.map((c) =>
    c.id === id
      ? { ...c, label: name || c.label, icon: icon != null ? (String(icon).trim() || c.icon) : c.icon }
      : c,
  )
  setCats(next)
  if (isSupabaseConfigured) {
    const c = next.find((x) => x.id === id)
    if (c) supabase.from('product_categories')
      .upsert({ id, label: c.label, icon: c.icon, updated_at: new Date().toISOString() })
      .then(({ error }) => { if (error) console.warn('[categories] gagal update di DB:', error.message) })
  }
  return { ok: true }
}

export function deleteCategory(id) {
  if (cats.length <= 1) return { ok: false, error: 'Minimal harus ada 1 kategori' }
  // hapus dari dropdown; labelById tetap menyimpan nama → produk lama aman
  setCats(cats.filter((c) => c.id !== id))
  if (isSupabaseConfigured) {
    supabase.from('product_categories').update({ deleted_at: new Date().toISOString() }).eq('id', id)
      .then(({ error }) => { if (error) console.warn('[categories] gagal hapus di DB:', error.message) })
  }
  return { ok: true }
}

// Getter biasa (untuk util non-React seperti excelExport).
export function getCategories() { return cats }
export function getCatLabel(id) {
  return labelById[id] || cats.find((c) => c.id === id)?.label || id || '-'
}

// Hook React — reaktif terhadap perubahan kategori. Sekali mount memicu
// loadFromDB() untuk memastikan data DB tersinkron (mis. setelah login).
export function useCategories() {
  const categories = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  useEffect(() => { if (!dbLoaded) loadFromDB() }, [])
  return { categories, addCategory, updateCategory, deleteCategory }
}
