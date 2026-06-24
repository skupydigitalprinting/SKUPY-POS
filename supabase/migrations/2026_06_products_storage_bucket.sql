-- ─────────────────────────────────────────────────────────────
-- Bucket Storage 'products' untuk foto produk.
--
-- Foto produk kini di-upload ke Supabase Storage (bukan base64 di DB),
-- lalu hanya public URL-nya yang disimpan di products.image. Ini bikin
-- tabel ringan & query cepat.
--
-- Idempotent. Cara pakai: Supabase → SQL Editor → Run.
-- ─────────────────────────────────────────────────────────────

INSERT INTO storage.buckets (id, name, public)
VALUES ('products', 'products', true)
ON CONFLICT (id) DO NOTHING;

DO $$ BEGIN CREATE POLICY "Public read products"   ON storage.objects FOR SELECT USING (bucket_id = 'products'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY "Public upload products" ON storage.objects FOR INSERT WITH CHECK (bucket_id = 'products'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY "Public update products" ON storage.objects FOR UPDATE USING (bucket_id = 'products'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY "Public delete products" ON storage.objects FOR DELETE USING (bucket_id = 'products'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

NOTIFY pgrst, 'reload schema';
