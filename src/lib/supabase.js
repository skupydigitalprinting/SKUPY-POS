import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY

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
  SUPABASE_ANON_KEY || 'public-anon-placeholder'
)

export const LOGOS_BUCKET = 'logos'
export const INVOICES_BUCKET = 'invoices'
export const PRODUCTS_BUCKET = 'products'

/**
 * Upload a product image (compressed WebP/JPEG blob) to the public
 * `products` bucket. Returns the public URL to store in products.image.
 */
export async function uploadProductImage(blob, name = 'produk') {
  if (!blob) throw new Error('Gambar kosong')
  const ext = (blob.type && blob.type.includes('webp')) ? 'webp' : 'jpg'
  const safe = String(name).replace(/[^a-z0-9_-]/gi, '').toLowerCase() || 'produk'
  const filename = `${safe}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.${ext}`
  const { error } = await supabase.storage
    .from(PRODUCTS_BUCKET)
    .upload(filename, blob, {
      upsert: true,
      contentType: blob.type || `image/${ext}`,
      cacheControl: '31536000', // 1 tahun — gambar produk jarang berubah
    })
  if (error) throw error
  const { data } = supabase.storage.from(PRODUCTS_BUCKET).getPublicUrl(filename)
  return data.publicUrl
}

/** Delete a product image by its public URL (best-effort). */
export async function deleteProductImage(publicUrl) {
  if (!publicUrl) return
  const m = String(publicUrl).match(/\/storage\/v1\/object\/public\/products\/(.+)$/)
  if (!m) return
  const path = decodeURIComponent(m[1])
  try { await supabase.storage.from(PRODUCTS_BUCKET).remove([path]) } catch { /* ignore */ }
}

/**
 * Upload a logo image to the public `logos` bucket.
 * Returns the public URL of the uploaded file.
 */
export async function uploadLogo(file, name = 'logo') {
  if (!file) throw new Error('File kosong')
  const ext = (file.name?.split('.').pop() || 'png').toLowerCase()
  const safe = name.replace(/[^a-z0-9_-]/gi, '').toLowerCase() || 'logo'
  const filename = `${safe}-${Date.now()}.${ext}`

  const { error } = await supabase.storage
    .from(LOGOS_BUCKET)
    .upload(filename, file, {
      upsert: true,
      contentType: file.type || `image/${ext}`,
      cacheControl: '3600',
    })

  if (error) throw error

  const { data } = supabase.storage.from(LOGOS_BUCKET).getPublicUrl(filename)
  return data.publicUrl
}

/**
 * Upload an invoice image (PNG blob) to the public `invoices` bucket.
 * Returns the public URL. Used by WhatsApp share so the message includes a link.
 */
export async function uploadInvoiceImage(blob, invoiceNo = 'invoice') {
  if (!blob) throw new Error('PNG kosong')
  const safe = String(invoiceNo).replace(/[^A-Za-z0-9_-]/g, '-')
  const filename = `${safe}-${Date.now()}.png`
  const { error } = await supabase.storage
    .from(INVOICES_BUCKET)
    .upload(filename, blob, {
      upsert: true,
      contentType: 'image/png',
      cacheControl: '3600',
    })
  if (error) throw error
  const { data } = supabase.storage.from(INVOICES_BUCKET).getPublicUrl(filename)
  return data.publicUrl
}

/**
 * Delete a logo by its public URL.
 */
export async function deleteLogo(publicUrl) {
  if (!publicUrl) return
  // Parse object path out of public URL: .../object/public/logos/<path>
  const m = publicUrl.match(/\/storage\/v1\/object\/public\/logos\/(.+)$/)
  if (!m) return
  const path = decodeURIComponent(m[1])
  await supabase.storage.from(LOGOS_BUCKET).remove([path])
}
