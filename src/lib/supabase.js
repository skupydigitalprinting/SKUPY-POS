import { createClient } from '@supabase/supabase-js'
import { createAuthStorage, AUTH_STORAGE_KEY } from './authStorage'
import { resolveAuthMode } from './authMode'
import { createSessionTransport } from './sessionTransport'
import { createDataSession } from './dataSession'
import { uploadPrivateInvoice } from './invoiceStorage'

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY
export const authMode = resolveAuthMode(import.meta.env, typeof window !== 'undefined' ? window.location.origin : '')
export const secureAuthEnabled = authMode !== 'legacy'
const storageAdapter = kind => ({
  getItem: key => window[kind].getItem(key),
  setItem: (key, value) => window[kind].setItem(key, value),
  removeItem: key => window[kind].removeItem(key),
})
export const authStorage = createAuthStorage({ local: storageAdapter('localStorage'), session: storageAdapter('sessionStorage') })
const nativeFetch = (...args) => globalThis.fetch(...args)
const dataTransport = createSessionTransport(nativeFetch)

export const isSupabaseConfigured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY)

if (!isSupabaseConfigured && typeof window !== 'undefined') {
  // Log once at startup so missing env is visible in DevTools
  // eslint-disable-next-line no-console
  console.warn(
    '[Skupy] VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY is missing. ' +
    'Copy .env.example → .env and fill in your Supabase credentials.'
  )
}

export const supabase = createClient(
  SUPABASE_URL || 'https://placeholder.supabase.co',
  SUPABASE_ANON_KEY || 'public-anon-placeholder',
  secureAuthEnabled ? {
    auth: { storage: authStorage, storageKey: AUTH_STORAGE_KEY, persistSession: true, detectSessionInUrl: false },
    global: { fetch: (input, init) => {
      if (authMode === 'blocked') return Promise.reject(new DOMException('Konfigurasi login belum valid.', 'AbortError'))
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
      // Only Auth and the verified profile RPC may run before the business UI mounts.
      if (url.origin === new URL(SUPABASE_URL).origin &&
          (url.pathname.startsWith('/auth/v1/') || url.pathname === '/rest/v1/rpc/pos_current_profile')) return nativeFetch(input, init)
      return dataTransport.fetch(input, init)
    } },
  } : undefined
)

const dataSession = createDataSession({ primary: supabase, transport: dataTransport,
  url: SUPABASE_URL, key: SUPABASE_ANON_KEY, factory: createClient })
const resetListeners = new Set()
let businessDataActive = !secureAuthEnabled
export function isDataSessionActive() { return businessDataActive }
export function onDataSessionReset(listener) { resetListeners.add(listener); return () => resetListeners.delete(listener) }
export function getDataClient() { return secureAuthEnabled ? dataSession.getClient() : supabase }
export function activateDataSession(user) { dataSession.activate(user); businessDataActive = true }
export function invalidateDataSession() {
  businessDataActive = false
  dataSession.invalidate()
  _bucketReady = false
  resetListeners.forEach(listener => listener())
  void supabase.removeAllChannels().catch(() => {})
}

export const LOGOS_BUCKET = 'logos'
export const INVOICES_BUCKET = 'invoices'
// Satu sumber kebenaran nama bucket produk — jangan hard-code di tempat lain.
export const PRODUCTS_BUCKET = 'products'

// Pesan setup yang sama dipakai di beberapa tempat.
const BUCKET_SETUP_HINT =
  secureAuthEnabled ? 'Penyimpanan gambar belum siap. Hubungi owner untuk memeriksa konfigurasi Storage.' :
  `Bucket "${PRODUCTS_BUCKET}" belum ada di Supabase. Buat dengan salah satu cara: ` +
  `(1) jalankan supabase/migrations/2026_06_products_storage_bucket.sql di SQL Editor, atau ` +
  `(2) Supabase Dashboard → Storage → New bucket → nama "${PRODUCTS_BUCKET}" → centang Public.`

// Cache agar pengecekan bucket tidak diulang tiap upload.
let _bucketReady = false

/**
 * Pastikan bucket `products` ada. Best-effort:
 *   1. cek via getBucket
 *   2. kalau belum ada, COBA buat (butuh privilege; di anon biasanya gagal)
 * Mengembalikan { ok, error, hint }. TIDAK melempar — pemanggil yang memutuskan.
 */
export async function ensureProductsBucket(client = getDataClient()) {
  if (secureAuthEnabled) return { ok: true }
  if (_bucketReady) return { ok: true }
  try {
    const { data: existing } = await client.storage.getBucket(PRODUCTS_BUCKET)
    if (existing) { _bucketReady = true; return { ok: true } }

    // Coba auto-create (hanya berhasil kalau key punya izin, mis. service role
    // atau policy storage.buckets mengizinkan). Di anon umumnya 403 → fallback.
    const { error: createErr } = await client.storage.createBucket(PRODUCTS_BUCKET, {
      public: true,
    })
    if (!createErr) { _bucketReady = true; return { ok: true } }

    // eslint-disable-next-line no-console
    console.error('Storage ensureProductsBucket failed', createErr)
    return { ok: false, error: createErr.message, hint: BUCKET_SETUP_HINT }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('Storage ensureProductsBucket exception', e)
    return { ok: false, error: e?.message || String(e), hint: BUCKET_SETUP_HINT }
  }
}

/**
 * Upload a product image (compressed WebP/JPEG blob) to the public
 * `products` bucket. Returns the public URL to store in products.image.
 */
export async function uploadProductImage(blob, name = 'produk', client = getDataClient()) {
  if (!blob) throw new Error('Gambar kosong')
  // Best-effort: pastikan bucket ada (auto-create kalau punya izin).
  await ensureProductsBucket(client)

  const ext = (blob.type && blob.type.includes('webp')) ? 'webp' : 'jpg'
  const safe = String(name).replace(/[^a-z0-9_-]/gi, '').toLowerCase() || 'produk'
  const filename = `${safe}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.${ext}`
  const { error } = await client.storage
    .from(PRODUCTS_BUCKET)
    .upload(filename, blob, {
      upsert: true,
      contentType: blob.type || `image/${ext}`,
      cacheControl: '31536000', // 1 tahun — gambar produk jarang berubah
    })
  if (error) {
    // eslint-disable-next-line no-console
    console.error('Storage upload failed', error)
    if (/bucket not found/i.test(error.message || '') || error.statusCode === '404') {
      throw new Error(BUCKET_SETUP_HINT)
    }
    if (/row-level security|rls|not authorized|403/i.test(error.message || '')) {
      throw new Error(
        'Unggahan ditolak. Pastikan sesi login masih aktif atau hubungi owner untuk memeriksa hak akses Storage.'
      )
    }
    throw error
  }
  const { data } = client.storage.from(PRODUCTS_BUCKET).getPublicUrl(filename)
  return data.publicUrl
}

/** Delete a product image by its public URL (best-effort). */
export async function deleteProductImage(publicUrl, client = getDataClient()) {
  if (!publicUrl) return
  const m = String(publicUrl).match(/\/storage\/v1\/object\/public\/products\/(.+)$/)
  if (!m) return
  const path = decodeURIComponent(m[1])
  try { await client.storage.from(PRODUCTS_BUCKET).remove([path]) } catch { /* ignore */ }
}

/**
 * Upload a logo image to the public `logos` bucket.
 * Returns the public URL of the uploaded file.
 */
export async function uploadLogo(file, name = 'logo', client = getDataClient()) {
  if (!file) throw new Error('File kosong')
  const ext = (file.name?.split('.').pop() || 'png').toLowerCase()
  const safe = name.replace(/[^a-z0-9_-]/gi, '').toLowerCase() || 'logo'
  const filename = `${safe}-${Date.now()}.${ext}`

  const { error } = await client.storage
    .from(LOGOS_BUCKET)
    .upload(filename, file, {
      upsert: true,
      contentType: file.type || `image/${ext}`,
      cacheControl: '3600',
    })

  if (error) throw error

  const { data } = client.storage.from(LOGOS_BUCKET).getPublicUrl(filename)
  return data.publicUrl
}

/**
 * Secure mode binds invoice objects to visible transactions and signs temporary links.
 * Legacy mode is retained until the database and Storage cutover are complete.
 */
export async function uploadInvoiceImage(blob, invoiceNo = 'invoice', client = getDataClient()) {
  if (secureAuthEnabled) return uploadPrivateInvoice(client, blob, invoiceNo)
  if (!blob) throw new Error('PNG kosong')
  const safe = String(invoiceNo).replace(/[^A-Za-z0-9_-]/g, '-')
  const filename = `${safe}-${Date.now()}.png`
  const { error } = await client.storage
    .from(INVOICES_BUCKET)
    .upload(filename, blob, {
      upsert: true,
      contentType: 'image/png',
      cacheControl: '3600',
    })
  if (error) throw error
  const { data } = client.storage.from(INVOICES_BUCKET).getPublicUrl(filename)
  return data.publicUrl
}

/**
 * Delete a logo by its public URL.
 */
export async function deleteLogo(publicUrl, client = getDataClient()) {
  if (!publicUrl) return
  // Parse object path out of public URL: .../object/public/logos/<path>
  const m = publicUrl.match(/\/storage\/v1\/object\/public\/logos\/(.+)$/)
  if (!m) return
  const path = decodeURIComponent(m[1])
  await client.storage.from(LOGOS_BUCKET).remove([path])
}
