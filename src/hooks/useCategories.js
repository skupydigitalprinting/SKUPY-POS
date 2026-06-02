// ─────────────────────────────────────────────────────────────
// useCategories — kategori produk yang bisa diedit user (CRUD).
//
// Disimpan di localStorage (key: skupy_categories_v1) supaya tetap ada
// setelah refresh, tanpa perlu mengubah skema database.
//
// Memakai useSyncExternalStore agar SEMUA komponen (Produk, Kasir,
// Dashboard) ikut ter-update otomatis saat kategori berubah — tidak
// perlu reload halaman.
// ─────────────────────────────────────────────────────────────
import { useSyncExternalStore } from 'react'
import { PRODUCT_CATEGORIES } from '../data/dummyData'

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
  if (cats.some((c) => c.id === id)) {
    let n = 2
    while (cats.some((c) => c.id === `${id}-${n}`)) n++
    id = `${id}-${n}`
  }
  cats = [...cats, { id, label: name, icon: (icon || '').trim() || '📦' }]
  emit()
  return { ok: true, id }
}

export function updateCategory(id, { label, icon }) {
  const name = label != null ? String(label).trim() : null
  if (name === '') return { ok: false, error: 'Nama kategori tidak boleh kosong' }
  if (name && cats.some((c) => c.id !== id && c.label.toLowerCase() === name.toLowerCase())) {
    return { ok: false, error: 'Kategori dengan nama itu sudah ada' }
  }
  cats = cats.map((c) =>
    c.id === id
      ? { ...c, label: name || c.label, icon: icon != null ? (String(icon).trim() || c.icon) : c.icon }
      : c,
  )
  emit()
  return { ok: true }
}

export function deleteCategory(id) {
  if (cats.length <= 1) return { ok: false, error: 'Minimal harus ada 1 kategori' }
  cats = cats.filter((c) => c.id !== id)
  emit()
  return { ok: true }
}

// Getter biasa (untuk util non-React seperti excelExport).
export function getCategories() { return cats }
export function getCatLabel(id) {
  return cats.find((c) => c.id === id)?.label || id || '-'
}

// Hook React — reaktif terhadap perubahan kategori.
export function useCategories() {
  const categories = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  return { categories, addCategory, updateCategory, deleteCategory }
}
