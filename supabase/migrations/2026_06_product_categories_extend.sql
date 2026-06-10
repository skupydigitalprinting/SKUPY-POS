-- ═══════════════════════════════════════════════════════════════════
-- KATEGORI PRODUK — perluasan: warna, thumbnail, status aktif/nonaktif.
-- Jalankan SETELAH 2026_06_product_categories.sql. Idempotent.
--
-- Skema dipertahankan: id = slug (text) yang SAMA dengan products.category
-- (snapshot), supaya produk lama tetap termapping & nama kategori terakhir
-- tetap tampil. Kolom baru bersifat opsional.
-- ═══════════════════════════════════════════════════════════════════
ALTER TABLE public.product_categories ADD COLUMN IF NOT EXISTS color         text;
ALTER TABLE public.product_categories ADD COLUMN IF NOT EXISTS thumbnail_url text;
ALTER TABLE public.product_categories ADD COLUMN IF NOT EXISTS is_active     boolean DEFAULT true;
CREATE INDEX IF NOT EXISTS idx_prodcat_active ON public.product_categories (is_active);

-- Pastikan kategori bawaan tetap ada (kalau tabel baru dibuat di migrasi ini).
INSERT INTO public.product_categories (id, label, icon, sort_order, is_active) VALUES
  ('jersey','Jersey','👕',1,true),
  ('kaos','Kaos','👚',2,true),
  ('banner','Banner','🚩',3,true),
  ('sticker','Sticker','✨',4,true),
  ('printing','Printing','🖨️',5,true),
  ('accessories','Accessories','🎒',6,true),
  ('other','Other','📦',7,true)
ON CONFLICT (id) DO NOTHING;

-- Baris lama (is_active NULL) → anggap aktif.
UPDATE public.product_categories SET is_active = true WHERE is_active IS NULL;

NOTIFY pgrst, 'reload schema';
