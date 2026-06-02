-- ─────────────────────────────────────────────────────────────
-- Bersihkan foto produk LAMA yang kelewat besar (penyebab
-- "canceling statement due to statement timeout" saat boot).
--
-- Konteks:
--   Sebelum fitur kompresi gambar (v53), foto produk disimpan
--   sebagai base64 mentah — bisa 2–6 MB per baris. SELECT banyak
--   baris sekaligus jadi melampaui statement_timeout Supabase (~8s).
--
-- Aplikasi sudah diperbaiki agar TIDAK memuat kolom `image` saat boot
-- (gambar di-hydrate di latar belakang), jadi app tetap bisa hidup.
-- Migrasi ini OPSIONAL tapi disarankan: ia mengosongkan gambar yang
-- terlalu besar supaya database ringan & cepat. Produk yang gambarnya
-- dikosongkan akan memakai gambar fallback sampai di-upload ulang
-- (upload baru otomatis dikompres jadi kecil).
--
-- Cara pakai: buka Supabase → SQL Editor → tempel & Run.
-- ─────────────────────────────────────────────────────────────

-- Lihat dulu berapa baris yang akan terdampak (ambang ~200 KB base64):
-- SELECT id, name, length(image) AS img_len
-- FROM public.products
-- WHERE image IS NOT NULL AND length(image) > 200000
-- ORDER BY img_len DESC;

-- Kosongkan gambar yang lebih besar dari ~200 KB (kira-kira 200000 karakter base64).
UPDATE public.products
SET image = ''
WHERE image IS NOT NULL
  AND length(image) > 200000;
