-- ═══════════════════════════════════════════════════════════════════
-- KATEGORI PRODUK (product_categories) — single source of truth di DB.
-- Idempotent. Sebelumnya kategori hanya di localStorage (per-browser) →
-- hilang saat ganti device / clear cache / deploy ulang. Sekarang tersimpan
-- permanen di Supabase; localStorage hanya cache offline.
--
-- id = slug (mis. 'jersey') → SAMA dengan products.category, jadi produk lama
-- tetap termapping. Soft delete (deleted_at) → produk lama tetap menampilkan
-- nama kategori terakhir.
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.product_categories (
  id          text PRIMARY KEY,
  label       text NOT NULL,
  icon        text DEFAULT '📦',
  sort_order  int DEFAULT 0,
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now(),
  deleted_at  timestamptz
);
CREATE INDEX IF NOT EXISTS idx_prodcat_deleted ON public.product_categories (deleted_at);

ALTER TABLE public.product_categories ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "anon all product_categories" ON public.product_categories FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.product_categories TO anon, authenticated;

-- ---------- SEED kategori bawaan (hanya bila belum ada) ----------
INSERT INTO public.product_categories (id, label, icon, sort_order) VALUES
  ('jersey','Jersey','👕',1),
  ('kaos','Kaos','👚',2),
  ('banner','Banner','🚩',3),
  ('sticker','Sticker','✨',4),
  ('printing','Printing','🖨️',5),
  ('accessories','Accessories','🎒',6),
  ('other','Other','📦',7)
ON CONFLICT (id) DO NOTHING;

NOTIFY pgrst, 'reload schema';
