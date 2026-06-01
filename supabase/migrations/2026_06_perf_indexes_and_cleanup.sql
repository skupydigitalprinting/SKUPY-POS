-- =====================================================================
-- Skupy POS — Migration: Performance Tuning (indexes + items cleanup)
-- =====================================================================
-- Tujuan : Menurunkan loading awal & latency refresh halaman.
--          Mengecilkan ukuran tabel `transactions` dengan menghapus
--          field `image` (base64) dari kolom JSONB items.
--
-- Cara pakai : Tempel di Supabase SQL Editor → Run. Idempotent.
-- =====================================================================

-- 1) Index lengkap (semua yang ada di spec user) -----------------------
-- Banyak yang sudah ada dari migrasi sebelumnya; CREATE INDEX IF NOT
-- EXISTS akan no-op untuk yang duplicate.
CREATE INDEX IF NOT EXISTS idx_transactions_invoice_no   ON public.transactions (invoice_no);
CREATE INDEX IF NOT EXISTS idx_transactions_customer_id  ON public.transactions (customer_id);
CREATE INDEX IF NOT EXISTS idx_transactions_cashier_id   ON public.transactions (cashier_id);
CREATE INDEX IF NOT EXISTS idx_transactions_status       ON public.transactions (status);
CREATE INDEX IF NOT EXISTS idx_transactions_created_at_desc
  ON public.transactions (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_debts_invoice_no          ON public.debts (invoice_no);
CREATE INDEX IF NOT EXISTS idx_debts_customer_id         ON public.debts (customer_id);
CREATE INDEX IF NOT EXISTS idx_debts_cashier_id          ON public.debts (cashier_id);
CREATE INDEX IF NOT EXISTS idx_debts_status              ON public.debts (status);

CREATE INDEX IF NOT EXISTS idx_debt_payments_debt_id     ON public.debt_payments (debt_id);
CREATE INDEX IF NOT EXISTS idx_debt_payments_cashier_id  ON public.debt_payments (cashier_id);
CREATE INDEX IF NOT EXISTS idx_debt_payments_paid_at_desc
  ON public.debt_payments (paid_at DESC);

CREATE INDEX IF NOT EXISTS idx_customers_phone           ON public.customers (phone);

-- 2) Bersihkan items JSONB di transactions lama ------------------------
-- Hapus key `image` dan `stock` dari setiap item dalam JSONB array.
-- Aman untuk semua row — jq-like operation native Postgres.
--
-- Sebelum: { name, price, qty, image: "data:image/png;base64,...", stock }
-- Sesudah: { name, price, qty }
--
-- Ini bisa menurunkan ukuran tabel signifikan kalau ada banyak invoice
-- dengan item ber-foto base64.
UPDATE public.transactions
   SET items = (
     SELECT jsonb_agg(item - 'image' - 'stock')
       FROM jsonb_array_elements(items) item
   )
 WHERE items IS NOT NULL
   AND jsonb_array_length(items) > 0
   AND items::text LIKE '%"image"%';  -- skip yang sudah bersih (idempotent)

-- 3) VACUUM (reklaim disk space setelah UPDATE besar) -------------------
-- Postgres tidak otomatis shrink table setelah UPDATE; VACUUM membersihkan
-- dead tuples. Kalau privilege tidak cukup, abaikan.
DO $$
BEGIN
  BEGIN
    EXECUTE 'VACUUM (ANALYZE) public.transactions';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'VACUUM butuh permission; skip. Tidak masalah, autovacuum akan handle.';
  WHEN OTHERS THEN
    RAISE NOTICE 'VACUUM gagal: %', SQLERRM;
  END;
END $$;

-- 4) Statistik untuk planner ------------------------------------------
-- ANALYZE membantu query planner pilih index yang tepat.
ANALYZE public.transactions;
ANALYZE public.debts;
ANALYZE public.debt_payments;
ANALYZE public.customers;
ANALYZE public.products;

-- 5) Refresh PostgREST schema cache ------------------------------------
NOTIFY pgrst, 'reload schema';

-- =====================================================================
-- Selesai. Performa setelah migrasi:
--   • Tabel transactions lebih ramping → SELECT lebih cepat
--   • Index lengkap → semua filter & sort akurat
--   • Statistik fresh → query planner pakai index yang tepat
-- =====================================================================
