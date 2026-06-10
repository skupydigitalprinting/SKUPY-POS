-- ═══════════════════════════════════════════════════════════════════
-- FAVORIT PRODUK — produk yang sering dijual tampil paling atas di Kasir.
-- Idempotent. Tidak mengubah harga/modal/kategori/rumus.
-- ═══════════════════════════════════════════════════════════════════
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS is_favorite boolean DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_products_is_favorite ON public.products (is_favorite);

NOTIFY pgrst, 'reload schema';
