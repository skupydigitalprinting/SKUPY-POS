-- ─────────────────────────────────────────────────────────────
-- Index created_at untuk products & customers.
--
-- Alasan: query boot mengambil data dengan ORDER BY created_at DESC
-- LIMIT 500. Tanpa index pada created_at, Postgres harus menyortir
-- seluruh tabel tiap kali — makin lambat seiring data bertambah, dan
-- bisa ikut memicu statement timeout. Index ini membuat ORDER BY ...
-- LIMIT jadi instan.
--
-- Idempotent & aman dijalankan kapan saja.
-- Cara pakai: Supabase → SQL Editor → tempel & Run.
-- ─────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_products_created_at
  ON public.products (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_customers_created_at
  ON public.customers (created_at DESC);

-- Refresh cache schema PostgREST
NOTIFY pgrst, 'reload schema';
