# Laporan Optimasi Performa — Skupy POS (v58)

Tanggal: 4 Juni 2026

Catatan: build produksi belum bisa dijalankan di lingkungan ini (registry npm
diblokir), jadi angka peningkatan di bawah adalah **estimasi** berdasarkan
ukuran payload & jumlah render yang dipangkas. Silakan ukur final dengan
`npm run build` lalu Lighthouse.

---

## 1. Query yang dipercepat

| Area | Sebelum | Sesudah |
|------|---------|---------|
| Boot produk | `SELECT *` (termasuk base64 gambar, bisa MB/baris) tanpa limit | `SELECT` kolom ringan tanpa `image`, `LIMIT 500`, gambar di-hydrate di latar belakang |
| Gambar produk | Base64 disimpan di kolom `products.image` (bikin tabel berat) | Hanya **public URL** ke Supabase Storage (tabel jadi ringan) |
| Produk list render | Render semua baris sekaligus | Pagination 50/halaman (DOM jauh lebih ringan) |
| Order list render | Render semua transaksi hasil filter | Render 50 terbaru + "Muat lebih banyak" |
| Sortir `ORDER BY created_at` | Tanpa index pada products/customers | Index `created_at DESC` ditambahkan |

## 2. Index database yang dibuat (migration)

File: `supabase/migrations/2026_06_performance_indexes_full.sql`
(juga dimasukkan ke `schema.sql` untuk instalasi baru)

- transactions: `invoice_no`, `customer_id`, `created_at DESC`, `status`, `order_status`
- debts: `customer_id`, `invoice_no`, `status`, `due_date`
- customers: `name`, `created_at DESC`
- products: `category`, `name` (baru), `created_at DESC`

Plus bucket Storage `products` (publik) di
`supabase/migrations/2026_06_products_storage_bucket.sql`.

## 3. Komponen yang dioptimasi

- **Upload gambar (Produk)** — field "paste URL" dihapus. Alur baru: pilih file →
  kompres + resize ke **WebP 1200px / kualitas 75%** (target < 200KB) → upload ke
  Supabase Storage → simpan public URL → preview otomatis (dengan spinner
  "Mengupload & mengompres"). Tombol simpan terkunci selama upload.
- **`ProductImage`** — `loading="lazy"` + `decoding="async"` → gambar hanya dimuat
  saat masuk layar.
- **Code splitting (App)** — semua halaman (Dashboard, Kasir, Produk, Order,
  Customers, Piutang) dan modal **Settings** di-`React.lazy`. Hanya halaman aktif
  yang di-download. Settings hanya dimuat saat owner membukanya.
- **Invoice (html2canvas)** — di-`lazy` di Kasir & Order; chunk berat hanya
  terunduh saat user benar-benar mencetak invoice.
- **Vite build** — `manualChunks` memisahkan `react`, `recharts`, `supabase`,
  `xlsx`, `html2canvas` ke chunk sendiri (cache jangka panjang + bundle awal kecil).
- **Produk & Order** — pagination 50 item + reset otomatis saat filter/cari berubah.
- **Hapus package tak terpakai** — `framer-motion` dihapus dari dependencies (0 import).

## 4. Perkiraan peningkatan performa

- **Bundle awal (JS first load):** −55% s/d −70% (recharts/xlsx/html2canvas/Settings/
  halaman non-aktif tidak lagi ikut di bundle utama). Paling terasa di Safari iPhone.
- **Boot data:** jauh lebih cepat & stabil — gambar tidak lagi ikut di query awal,
  menghilangkan penyebab utama "statement timeout".
- **Render Produk/Order saat data banyak:** −80%+ DOM node pada load pertama
  (50 vs ratusan/ribuan), scroll & interaksi lebih ringan.
- **Ukuran tabel `products`:** turun drastis untuk produk baru (URL ~100 byte vs
  base64 ~150KB–4MB per baris).

## 5. File yang diubah

Kode:
- `src/lib/supabase.js` — `PRODUCTS_BUCKET`, `uploadProductImage`, `deleteProductImage`
- `src/utils/helpers.js` — `compressImageToBlob` (WebP, fallback JPEG, mode thumbnail)
- `src/pages/Produk.jsx` — upload ke Storage, hapus field URL, pagination 50
- `src/pages/Order.jsx` — Invoice lazy, pagination 50
- `src/pages/Kasir.jsx` — Invoice lazy
- `src/components/ui.jsx` — `ProductImage` lazy/async
- `src/App.jsx` — code splitting halaman + Settings (lazy + Suspense)
- `vite.config.js` — manualChunks + target build
- `package.json` — hapus `framer-motion`

Database:
- `supabase/schema.sql` — bucket `products` + index `products.name`
- `supabase/migrations/2026_06_products_storage_bucket.sql`
- `supabase/migrations/2026_06_performance_indexes_full.sql`

## 6. Bottleneck yang masih tersisa (jujur)

Beberapa item brief belum diimplementasikan penuh karena butuh **rearsitektur besar**
(aplikasi saat ini memuat semua data ke satu store di awal) dan berisiko ke
kebenaran data tanpa pengujian build. Yang sudah ada sebagian besar **sudah
dimitigasi**, tapi belum "server-side murni":

- **#6 Search Order via query database** — saat ini search masih memfilter data
  yang sudah dimuat (dibatasi 500 transaksi terbaru), bukan query DB per ketik.
  Untuk dataset sangat besar, perlu pindah ke `ilike` + pagination server-side.
- **#7 Piutang lazy fetch detail** — ringkasan per-customer sudah ditampilkan dulu,
  tapi detail invoice memakai data yang sudah ada di store (riwayat pembayaran
  memang baru di-fetch saat diklik). Lazy-fetch penuh per customer belum.
- **#8 Dashboard aggregate query** — total omzet/piutang/order masih dihitung di
  browser (via `useMemo`, jadi tidak dihitung ulang tiap render). Versi paling
  cepat butuh RPC `SUM()` di Postgres. Belum dibuat agar tidak ada risiko break
  bila fungsi RPC belum ada di DB user.
- **#9 Polling cache 60 detik** — belum ditambah; sengaja, karena sudah ada
  **realtime subscription** yang push perubahan. Polling malah bisa menambah beban.
- **#3 Thumbnail 300×300 terpisah** — diaproksimasi dengan satu WebP kecil
  (≤200KB) + lazy-loading, untuk menghindari migrasi kolom baru yang berisiko ke
  proses simpan produk. Bisa ditambah kolom `image_thumb` bila diinginkan.

### Rekomendasi lanjutan (kalau mau lanjut ke server-side penuh)
1. RPC Postgres `dashboard_summary()` mengembalikan total omzet/piutang/order/customer.
2. Endpoint produk & order dengan `range()` (pagination) + `ilike` (search) server-side.
3. Kolom `products.image_thumb` untuk thumbnail 300×300 khusus daftar.

Semua perubahan di atas idempotent & backward-compatible. Jalankan dua file
migration SQL di Supabase SQL Editor, lalu `npm install` (framer-motion hilang) →
`npm run dev` / `npm run build`.
