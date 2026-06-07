-- ═══════════════════════════════════════════════════════════════════
-- ASET TETAP + PENYUSUTAN (assets, asset_categories)
-- Nilai buku TIDAK disimpan statis — dihitung di frontend dari
-- purchase_price/date/method/rate/life/residual (selalu realtime tiap tahun).
-- Idempotent. Jalankan di Supabase → SQL Editor.
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.asset_categories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);

CREATE TABLE IF NOT EXISTS public.assets (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                text NOT NULL,
  category_id         uuid,
  category_name       text,
  purchase_date       date NOT NULL,
  purchase_price      numeric NOT NULL DEFAULT 0,
  residual_value      numeric DEFAULT 0,
  depreciation_method text DEFAULT 'percentage',   -- none | percentage | straight
  depreciation_rate   numeric DEFAULT 0,           -- % per tahun (untuk percentage)
  useful_life_years   integer,                     -- umur manfaat (untuk straight)
  photo_url           text,
  notes               text,
  status              text DEFAULT 'active',        -- active | depleted | sold | broken | deleted
  sold_date           date,
  sold_price          numeric,
  payment_method      text,
  created_by          uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz
);

CREATE INDEX IF NOT EXISTS idx_assets_deleted  ON public.assets (deleted_at);
CREATE INDEX IF NOT EXISTS idx_assets_status   ON public.assets (status);
CREATE INDEX IF NOT EXISTS idx_asset_cat_del   ON public.asset_categories (deleted_at);

ALTER TABLE public.assets            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.asset_categories  ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN CREATE POLICY "anon all assets"           ON public.assets           FOR ALL USING (true) WITH CHECK (true); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY "anon all asset_categories" ON public.asset_categories FOR ALL USING (true) WITH CHECK (true); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Seed kategori default (hanya jika kosong)
INSERT INTO public.asset_categories (name)
SELECT x FROM unnest(ARRAY[
  'Mesin Produksi', 'Komputer & Elektronik', 'Kendaraan', 'Peralatan Toko',
  'Furniture', 'Renovasi', 'Software', 'Lainnya'
]) AS x
WHERE NOT EXISTS (SELECT 1 FROM public.asset_categories);

GRANT ALL ON public.assets           TO anon, authenticated;
GRANT ALL ON public.asset_categories TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
