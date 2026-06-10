-- ═══════════════════════════════════════════════════════════════════
-- REALTIME untuk product_categories — agar perubahan kategori (INSERT/
-- UPDATE/DELETE) langsung terkirim ke semua klien tanpa refresh.
-- Idempotent (aman diulang).
-- ═══════════════════════════════════════════════════════════════════
ALTER TABLE public.product_categories REPLICA IDENTITY FULL;

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.product_categories;
EXCEPTION
  WHEN duplicate_object THEN NULL;   -- sudah jadi anggota publikasi
  WHEN undefined_object THEN NULL;   -- publikasi supabase_realtime tidak ada
END $$;

NOTIFY pgrst, 'reload schema';
