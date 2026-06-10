export function formatRupiah(amount) {
  return new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(Number(amount) || 0)
}

export function formatNumber(n) {
  return new Intl.NumberFormat('id-ID').format(Number(n) || 0)
}

export function formatCompact(n) {
  const v = Number(n) || 0
  if (v >= 1_000_000_000) return (v / 1_000_000_000).toFixed(1).replace(/\.0$/, '') + 'M'
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'Jt'
  if (v >= 1_000) return (v / 1_000).toFixed(0) + 'rb'
  return String(v)
}

// ── Penyusutan Aset Tetap ──
// Umur aset = tahun penuh (floor) sejak tanggal beli.
export function assetAgeYears(purchaseDate, now = new Date()) {
  if (!purchaseDate) return 0
  const pd = new Date(purchaseDate), d = new Date(now)
  let age = d.getFullYear() - pd.getFullYear()
  const before = (d.getMonth() < pd.getMonth()) || (d.getMonth() === pd.getMonth() && d.getDate() < pd.getDate())
  if (before) age -= 1
  return age < 0 ? 0 : age
}

// Hitung nilai buku saat ini dari data mentah aset (TIDAK disimpan statis).
// method: 'none' | 'percentage' | 'straight'
export function calculateAssetBookValue(a, now = new Date()) {
  const price = Math.round(Number(a.purchase_price) || 0)
  const residual = Math.round(Number(a.residual_value) || 0)
  const method = a.depreciation_method || 'percentage'
  const rate = Number(a.depreciation_rate) || 0
  const life = Number(a.useful_life_years) || 0
  const age = assetAgeYears(a.purchase_date, now)
  let perYear = 0
  if (method === 'percentage') perYear = Math.round(price * rate / 100)
  else if (method === 'straight') perYear = life > 0 ? Math.round((price - residual) / life) : 0
  let book = method === 'none' ? price : price - perYear * age
  if (book < residual) book = residual
  if (book > price) book = price
  const totalDep = price - book
  const depleted = method !== 'none' && book <= residual && totalDep > 0
  return { age, perYear, totalDep, bookValue: book, residual, price, method, rate, life, depleted }
}

// Tabel simulasi nilai buku per tahun (untuk detail aset).
export function assetDepreciationSchedule(a, maxYears = 12) {
  const price = Math.round(Number(a.purchase_price) || 0)
  const residual = Math.round(Number(a.residual_value) || 0)
  const method = a.depreciation_method || 'percentage'
  const rate = Number(a.depreciation_rate) || 0
  const life = Number(a.useful_life_years) || 0
  let perYear = 0
  if (method === 'percentage') perYear = Math.round(price * rate / 100)
  else if (method === 'straight') perYear = life > 0 ? Math.round((price - residual) / life) : 0
  const rows = []
  let n = method === 'none' ? 0 : (method === 'straight' && life > 0 ? life : Math.min(maxYears, perYear > 0 ? Math.ceil((price - residual) / perYear) : 0))
  n = Math.min(Math.max(n, 0), maxYears)
  for (let y = 0; y <= n; y++) {
    let book = method === 'none' ? price : price - perYear * y
    if (book < residual) book = residual
    rows.push({ year: y, book })
  }
  return rows
}

// ── RUMUS RESMI LABA BERSIH (satu sumber untuk seluruh aplikasi) ──
// Laba Bersih = Omset − Total Pengeluaran − Beban Sewa berjalan
export function netProfit(omset, pengeluaran, bebanSewa = 0) {
  return Math.round((Number(omset) || 0) - (Number(pengeluaran) || 0) - (Number(bebanSewa) || 0))
}

// ── Sewa Toko Dibayar Dimuka (amortisasi) ──
// Durasi bulan inklusif antara start & end.
export function rentDurationMonths(start, end) {
  if (!start || !end) return 0
  const s = new Date(start), e = new Date(end)
  const m = (e.getFullYear() - s.getFullYear()) * 12 + (e.getMonth() - s.getMonth()) + 1
  return m > 0 ? m : 0
}

// Jumlah bulan yang SUDAH berjalan (accrued) per tanggal `now` (cap di durasi).
// Bulan berjalan dihitung penuh 1 beban begitu memasuki bulan tsb.
export function rentMonthsElapsed(rent, now = new Date()) {
  if (!rent.start_date) return 0
  const s = new Date(rent.start_date), d = new Date(now)
  const startMonth = new Date(s.getFullYear(), s.getMonth(), 1)
  const curMonth = new Date(d.getFullYear(), d.getMonth(), 1)
  if (curMonth < startMonth) return 0 // sewa belum mulai
  const m = (d.getFullYear() - s.getFullYear()) * 12 + (d.getMonth() - s.getMonth()) + 1
  const dur = Number(rent.duration_months) || rentDurationMonths(rent.start_date, rent.end_date)
  return Math.max(0, Math.min(m, dur))
}

// Akumulasi beban sewa s/d bulan ke-k (0..dur). SATU pembulatan dari total —
// BUKAN menjumlahkan beban bulanan yang sudah dibulatkan. Ini kunci anti-bug
// "Rp 50.000.002 / Rp 41.250.001": rumus kumulatif round(total*k/dur) tidak
// pernah menumpuk error pembulatan 1-2 rupiah.
export function rentAccruedAt(total, dur, k) {
  const T = Math.round(Number(total) || 0)
  const D = Number(dur) || 1
  const K = Math.max(0, Math.min(Number(k) || 0, D))
  if (K >= D) return T                       // selesai → seluruh sewa jadi beban
  return Math.round((T * K) / D)             // pembulatan final hanya sekali
}

// Ringkasan amortisasi sewa pada tanggal `now`. Semua nilai integer rupiah.
//   Sisa Dibayar Dimuka = Total − (Akumulasi Beban s/d bulan berjalan)
//   dihitung sekali dari total → tidak ada selisih 1-2 rupiah, tidak negatif,
//   tidak melebihi total.
export function rentAmortization(rent, now = new Date()) {
  const total = Math.round(Number(rent.total_amount) || 0)
  const dur = Number(rent.duration_months) || rentDurationMonths(rent.start_date, rent.end_date) || 1
  const monthly = Math.round(total / dur)                       // beban/bulan (tampilan)
  const elapsed = Math.max(0, Math.min(rentMonthsElapsed(rent, now), dur))
  const done = elapsed >= dur
  const accrued = rentAccruedAt(total, dur, elapsed)            // SATU pembulatan dari total
  const prepaid = Math.max(0, Math.min(total, total - accrued)) // integer, 0..total
  // Log debug sementara — aktifkan di console: window.__RENT_DEBUG__ = true
  if (typeof window !== 'undefined' && window.__RENT_DEBUG__) {
    console.debug('[rentAmortization]', {
      name: rent.name, total_rent_paid: total, monthly_expense: monthly,
      months_elapsed: elapsed, accumulated_expense: accrued, prepaid_remaining: prepaid,
    })
  }
  return { total, dur, monthly, elapsed, accrued, prepaid, done }
}

// Beban sewa untuk bulan berjalan (bulan ke-e). Diambil sebagai selisih
// akumulasi kumulatif: accrued(e) − accrued(e−1) → integer, konsisten dgn jadwal.
export function rentBebanBulanIni(rent, now = new Date()) {
  const e = rentMonthsElapsed(rent, now)
  const dur = Number(rent.duration_months) || rentDurationMonths(rent.start_date, rent.end_date)
  if (!(e >= 1 && e <= dur)) return 0
  const total = Math.round(Number(rent.total_amount) || 0)
  return rentAccruedAt(total, dur, e) - rentAccruedAt(total, dur, e - 1)
}

// Tabel jadwal amortisasi (period_month, beban, status) untuk durasi penuh.
// Beban tiap bulan = selisih akumulasi kumulatif round(total*k/dur) −
// round(total*(k-1)/dur). Jumlah seluruh baris PERSIS = total (tanpa drift),
// dan akumulasi m bulan pertama = round(total*m/dur) konsisten dgn rentAmortization.
export function rentSchedule(rent, now = new Date()) {
  const dur = Number(rent.duration_months) || rentDurationMonths(rent.start_date, rent.end_date)
  const total = Math.round(Number(rent.total_amount) || 0)
  const s = new Date(rent.start_date)
  const elapsed = rentMonthsElapsed(rent, now)
  const rows = []
  for (let i = 0; i < dur; i++) {
    const pm = new Date(s.getFullYear(), s.getMonth() + i, 1)
    const amt = rentAccruedAt(total, dur, i + 1) - rentAccruedAt(total, dur, i)
    const status = (i + 1) < elapsed ? 'done' : (i + 1) === elapsed ? 'accrued' : 'pending'
    rows.push({ idx: i + 1, periodMonth: pm, amount: amt, status })
  }
  return rows
}

// Rupiah ringkas untuk mobile: Rp246Jt, Rp1,4Jt, Rp950Rb (koma ala Indonesia).
export function formatRupiahShort(amount) {
  const v = Math.round(Number(amount) || 0)
  const sign = v < 0 ? '-' : ''
  const a = Math.abs(v)
  if (a >= 1_000_000_000) return `${sign}Rp${(a / 1_000_000_000).toFixed(1).replace('.', ',').replace(/,0$/, '')}M`
  if (a >= 1_000_000) return `${sign}Rp${(a / 1_000_000).toFixed(1).replace('.', ',').replace(/,0$/, '')}Jt`
  if (a >= 1_000) return `${sign}Rp${Math.round(a / 1_000)}Rb`
  return `${sign}Rp${a}`
}

export function formatDate(dateStr, opts = {}) {
  return new Date(dateStr).toLocaleDateString('id-ID', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    ...opts,
  })
}

export function formatDateTime(dateStr) {
  return new Date(dateStr).toLocaleString('id-ID', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function timeAgo(dateStr) {
  const diff = (Date.now() - new Date(dateStr).getTime()) / 1000
  if (diff < 60) return 'baru saja'
  if (diff < 3600) return Math.floor(diff / 60) + ' menit lalu'
  if (diff < 86400) return Math.floor(diff / 3600) + ' jam lalu'
  if (diff < 604800) return Math.floor(diff / 86400) + ' hari lalu'
  return formatDate(dateStr)
}

export function generateId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

export function classNames(...classes) {
  return classes.filter(Boolean).join(' ')
}

// Gambar default produk: logo Skupy (bukan lagi foto Unsplash).
// Dipakai untuk produk tanpa foto & sebagai fallback onError.
export const DEFAULT_PRODUCT_IMAGE = '/skupy-logo.png'

// ─────────────────────────────────────────────────────────────
// UANG — selalu integer rupiah. Jangan pernah pakai float untuk uang.
//   • toMoney(n)        → bulatkan ke integer rupiah (hindari drift float)
//   • parseCurrency(v)  → "Rp16.938.240" / 16938240.0000004 → 16938240
// ─────────────────────────────────────────────────────────────
export function toMoney(n) {
  const v = Math.round(Number(n) || 0)
  return Number.isFinite(v) ? v : 0
}

export function parseCurrency(value) {
  // Angka (mungkin float drift) → langsung dibulatkan, JANGAN di-stringify
  // lalu strip titik (itu yang bikin "16938240.0000004" → 16938240000000004).
  if (typeof value === 'number') return toMoney(value)
  // String berformat: ambil digit saja (titik = pemisah ribuan).
  return Number(String(value).replace(/[^\d]/g, '')) || 0
}

// Format ribuan id-ID TANPA "Rp" (untuk value input uang).
// 1000000 → "1.000.000". String berformat juga aman (di-parse dulu).
export function formatCurrency(value) {
  const n = parseCurrency(value)
  return n ? new Intl.NumberFormat('id-ID').format(n) : ''
}

export function toBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

/**
 * Kompres & resize gambar di sisi browser sebelum disimpan.
 * Tujuan: foto 2–4MB jadi puluhan KB → insert ke database jauh lebih cepat.
 *
 * @param {File} file        file gambar dari input
 * @param {object} opts      { maxSize: sisi terpanjang (px), quality: 0..1 }
 * @returns {Promise<string>} data URL (JPEG) terkompres
 */
export function compressImage(file, { maxSize = 800, quality = 0.72 } = {}) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const img = new Image()
      img.onload = () => {
        let { width, height } = img
        if (width > maxSize || height > maxSize) {
          if (width >= height) {
            height = Math.round((height * maxSize) / width)
            width = maxSize
          } else {
            width = Math.round((width * maxSize) / height)
            height = maxSize
          }
        }
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        const ctx = canvas.getContext('2d')
        ctx.drawImage(img, 0, 0, width, height)
        try {
          resolve(canvas.toDataURL('image/jpeg', quality))
        } catch (err) {
          // Kalau canvas gagal (mis. gambar CORS), pakai data URL asli.
          resolve(reader.result)
        }
      }
      img.onerror = () => resolve(reader.result)
      img.src = reader.result
    }
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

/**
 * Kompres & resize gambar menjadi BLOB (untuk di-upload ke Supabase Storage).
 * Default: WebP, lebar maks 1200px, kualitas 75% → target < ~200KB.
 * Otomatis fallback ke JPEG kalau browser tidak mendukung WebP.
 *
 * @param {File|Blob} file
 * @param {object} opts { maxSize, quality, type, cover }
 *   - cover: kalau true, crop ke kotak maxSize×maxSize (dipakai untuk thumbnail)
 * @returns {Promise<Blob>}
 */
export function compressImageToBlob(file, { maxSize = 1200, quality = 0.75, type = 'image/webp', cover = false } = {}) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const img = new Image()
      img.onload = () => {
        const canvas = document.createElement('canvas')
        const ctx = canvas.getContext('2d')

        if (cover) {
          // Thumbnail kotak: crop tengah lalu skala ke maxSize×maxSize
          const side = maxSize
          canvas.width = side
          canvas.height = side
          const scale = Math.max(side / img.width, side / img.height)
          const dw = img.width * scale
          const dh = img.height * scale
          ctx.drawImage(img, (side - dw) / 2, (side - dh) / 2, dw, dh)
        } else {
          let { width, height } = img
          if (width > maxSize || height > maxSize) {
            if (width >= height) { height = Math.round((height * maxSize) / width); width = maxSize }
            else { width = Math.round((width * maxSize) / height); height = maxSize }
          }
          canvas.width = width
          canvas.height = height
          ctx.drawImage(img, 0, 0, width, height)
        }

        const done = (blob) => {
          if (blob) return resolve(blob)
          // Fallback JPEG kalau WebP tidak didukung
          canvas.toBlob(
            (b2) => b2 ? resolve(b2) : reject(new Error('Gagal mengompres gambar')),
            'image/jpeg', quality,
          )
        }
        canvas.toBlob(done, type, quality)
      }
      img.onerror = () => reject(new Error('Gagal memuat gambar'))
      img.src = reader.result
    }
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

/**
 * Generates a stylized QR-like pattern SVG (deterministic from input string).
 * Not a real QR code, but visually represents a payment QR for invoice printing.
 */
export function generateQRPattern(text, size = 21) {
  // Simple hash-based grid generator
  let h = 0
  for (let i = 0; i < text.length; i++) {
    h = (h * 31 + text.charCodeAt(i)) >>> 0
  }
  const grid = []
  for (let y = 0; y < size; y++) {
    grid[y] = []
    for (let x = 0; x < size; x++) {
      // Three position anchors (corners)
      const inAnchor = (
        (x < 7 && y < 7) ||
        (x >= size - 7 && y < 7) ||
        (x < 7 && y >= size - 7)
      )
      if (inAnchor) {
        const isOuter = (x === 0 || x === 6 || y === 0 || y === 6) ||
                        (x === size - 7 || x === size - 1 || (y === 0 || y === 6)) ||
                        ((x === 0 || x === 6) && y >= size - 7) ||
                        (y === size - 7 || y === size - 1)
        const inAnchorCorner =
          (x < 7 && y < 7 && ((x === 0 || x === 6 || y === 0 || y === 6))) ||
          (x >= size - 7 && y < 7 && ((x === size - 7 || x === size - 1 || y === 0 || y === 6))) ||
          (x < 7 && y >= size - 7 && ((x === 0 || x === 6 || y === size - 7 || y === size - 1)))
        const inAnchorCenter =
          (x >= 2 && x <= 4 && y >= 2 && y <= 4) ||
          (x >= size - 5 && x <= size - 3 && y >= 2 && y <= 4) ||
          (x >= 2 && x <= 4 && y >= size - 5 && y <= size - 3)
        grid[y][x] = inAnchorCorner || inAnchorCenter
      } else {
        h = (h * 1664525 + 1013904223) >>> 0
        grid[y][x] = ((h >> (x % 16)) & 1) === 1
      }
    }
  }
  return grid
}

export const STATUS_MAP = {
  pending: { label: 'Pending', color: 'amber', hex: '#f59e0b' },
  proses: { label: 'Proses', color: 'blue', hex: '#3b82f6' },
  selesai: { label: 'Selesai', color: 'green', hex: '#10d98a' },
  lunas: { label: 'Lunas', color: 'accent', hex: '#a78bfa' },
}

// ---------- ROLE (Owner / Staff Admin / Staff Kasir) ----------

// Daftar role yang valid di aplikasi. Disimpan di DB sebagai string pendek.
//   owner → akses penuh (dashboard + laba-rugi + pengaturan)
//   admin → Staff Admin (lihat seluruh dashboard, tanpa laba-rugi & pengaturan)
//   staff → Staff Kasir (tanpa dashboard)
export const ROLE_OPTIONS = [
  { id: 'owner', label: 'Owner' },
  { id: 'admin', label: 'Staff Admin' },
  { id: 'staff', label: 'Staff Kasir' },
]

export const ROLE_LABELS = {
  owner: 'Owner',
  admin: 'Staff Admin',
  staff: 'Staff Kasir',
  cashier: 'Staff Kasir', // kompatibilitas data lama
}

export function roleLabel(role) {
  return ROLE_LABELS[role] || 'Staff Kasir'
}

// Role yang boleh membuka halaman Dashboard.
export function canViewDashboard(role) {
  return role === 'owner' || role === 'admin'
}

// ---------- UNIT (PCS / Meter / Yard) ----------

export const UNIT_OPTIONS = [
  { id: 'pcs',   label: 'PCS',   short: 'pcs',   decimal: false },
  { id: 'meter', label: 'Meter', short: 'm',     decimal: true  },
  { id: 'yard',  label: 'Yard',  short: 'yd',    decimal: true  },
]

/** Returns the unit config (or PCS fallback). */
export function getUnit(unit) {
  return UNIT_OPTIONS.find(u => u.id === (unit || 'pcs').toLowerCase()) || UNIT_OPTIONS[0]
}

/** True if the unit supports decimals (meter/yard). */
export function unitAllowsDecimal(unit) {
  return getUnit(unit).decimal
}

/**
 * Format a quantity for display, e.g. 1.5 → "1,5 Meter", 3 → "3 PCS",
 * 1500 → "1.500 PCS", 10000 → "10.000 PCS" (Indonesian thousand
 * separator). Decimal units (meter/yard) use comma as decimal separator
 * and still apply the thousand grouping to the integer part.
 */
export function formatQty(qty, unit = 'pcs') {
  const u = getUnit(unit)
  const n = Number(qty) || 0
  const intl = new Intl.NumberFormat('id-ID')
  let str
  if (u.decimal) {
    if (Number.isInteger(n)) {
      str = intl.format(n)
    } else {
      const int = Math.trunc(n)
      const dec = Math.abs(n - int).toFixed(2).slice(2).replace(/0+$/, '')
      const intStr = intl.format(int)
      str = dec ? `${intStr},${dec}` : intStr
    }
  } else {
    str = intl.format(Math.round(n))
  }
  return `${str} ${u.label}`
}

/**
 * Parse a quantity string into a number.
 * - Accepts Indonesian comma ("1,5") and dot ("1.5")
 * - Returns 0 for invalid input
 */
export function parseQty(str, allowDecimal = false) {
  if (str === '' || str == null) return 0
  const normalized = String(str).trim().replace(',', '.').replace(/[^\d.]/g, '')
  if (!normalized) return 0
  const n = allowDecimal ? parseFloat(normalized) : parseInt(normalized, 10)
  return Number.isFinite(n) && n >= 0 ? n : 0
}

export function nextInvoiceNo(existing = []) {
  const year = new Date().getFullYear()
  const yearTrx = existing.filter(t => (t.invoiceNo || '').includes(`INV-${year}`))
  const num = yearTrx.length + 1
  return `INV-${year}-${String(num).padStart(4, '0')}`
}

/** Escape a value for CSV cells */
function csvEscape(v) {
  if (v === null || v === undefined) return ''
  const s = String(v)
  if (/[",\n;]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

/**
 * Build a CSV string from headers + rows of values.
 * Adds a BOM so Excel reads UTF-8 correctly.
 */
export function toCSV(headers, rows) {
  const lines = [headers.map(csvEscape).join(',')]
  for (const row of rows) lines.push(row.map(csvEscape).join(','))
  return '﻿' + lines.join('\n')
}

/** Trigger a browser file download with the given content */
export function downloadFile(filename, content, mime = 'text/csv;charset=utf-8') {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Returns YYYY-MM-DD for an input[type=date] value */
export function toDateInputValue(d) {
  if (!d) return ''
  const dt = d instanceof Date ? d : new Date(d)
  const yyyy = dt.getFullYear()
  const mm = String(dt.getMonth() + 1).padStart(2, '0')
  const dd = String(dt.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

/** Returns range [start, end] for the given YYYY-MM month */
export function monthRange(yyyyMm) {
  const [y, m] = yyyyMm.split('-').map(Number)
  const start = new Date(y, m - 1, 1, 0, 0, 0)
  const end = new Date(y, m, 0, 23, 59, 59)
  return [start, end]
}

/** Indonesian month name from YYYY-MM */
export function monthLabel(yyyyMm) {
  const [y, m] = yyyyMm.split('-').map(Number)
  return new Date(y, m - 1, 1).toLocaleDateString('id-ID', { month: 'long', year: 'numeric' })
}
