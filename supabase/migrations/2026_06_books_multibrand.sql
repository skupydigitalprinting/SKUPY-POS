-- =====================================================================
-- Skupy POS — Fitur BOOK (multi-brand pembukuan penjualan)
-- =====================================================================
-- Memisahkan PENJUALAN per brand/book (Kasir, Order, Invoice, Customer,
-- Omset, Piutang) sambil Accounting tetap GABUNGAN.
--   • books               : master brand/book
--   • admin_book_access    : hak akses kasir per book
--   • book_id              : ditambahkan ke transactions, customers, debts,
--                            debt_payments. Data lama → otomatis book SKUPY.
-- Additive + idempotent + non-destruktif. Tidak mengubah rumus accounting.
-- =====================================================================

-- ───── Tabel books ─────
CREATE TABLE IF NOT EXISTS public.books (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  brand_name  text,
  prefix      text,                 -- prefix invoice opsional, mis. SKP / THW
  logo_url    text,
  description text,
  is_active   boolean NOT NULL DEFAULT true,
  is_default  boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);
ALTER TABLE public.books ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN CREATE POLICY "anon all books" ON public.books FOR ALL USING (true) WITH CHECK (true); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT ALL ON public.books TO anon, authenticated;

-- ───── Hak akses kasir per book ─────
CREATE TABLE IF NOT EXISTS public.admin_book_access (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id   uuid NOT NULL,
  book_id    uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (admin_id, book_id)
);
ALTER TABLE public.admin_book_access ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN CREATE POLICY "anon all admin_book_access" ON public.admin_book_access FOR ALL USING (true) WITH CHECK (true); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT ALL ON public.admin_book_access TO anon, authenticated;

-- ───── Seed book default: SKUPY (default) + THEWA ─────
INSERT INTO public.books (name, brand_name, prefix, is_default, is_active)
SELECT 'SKUPY', 'SKUPY', 'SKP', true, true
WHERE NOT EXISTS (SELECT 1 FROM public.books WHERE upper(name) = 'SKUPY' AND deleted_at IS NULL);

INSERT INTO public.books (name, brand_name, prefix, is_default, is_active)
SELECT 'THEWA', 'THEWA', 'THW', false, true
WHERE NOT EXISTS (SELECT 1 FROM public.books WHERE upper(name) = 'THEWA' AND deleted_at IS NULL);

-- Pastikan tepat 1 book default (SKUPY).
UPDATE public.books SET is_default = false WHERE is_default = true AND upper(name) <> 'SKUPY';
UPDATE public.books SET is_default = true  WHERE upper(name) = 'SKUPY' AND deleted_at IS NULL;

-- ───── Kolom book_id ke tabel penjualan + backfill ke SKUPY ─────
DO $do$
DECLARE v_skupy uuid;
BEGIN
  SELECT id INTO v_skupy FROM public.books WHERE upper(name)='SKUPY' AND deleted_at IS NULL LIMIT 1;

  -- transactions
  ALTER TABLE public.transactions   ADD COLUMN IF NOT EXISTS book_id uuid;
  UPDATE public.transactions   SET book_id = v_skupy WHERE book_id IS NULL;
  -- customers
  ALTER TABLE public.customers      ADD COLUMN IF NOT EXISTS book_id uuid;
  UPDATE public.customers      SET book_id = v_skupy WHERE book_id IS NULL;
  -- debts
  ALTER TABLE public.debts          ADD COLUMN IF NOT EXISTS book_id uuid;
  UPDATE public.debts          SET book_id = v_skupy WHERE book_id IS NULL;
  -- debt_payments
  ALTER TABLE public.debt_payments  ADD COLUMN IF NOT EXISTS book_id uuid;
  UPDATE public.debt_payments  SET book_id = v_skupy WHERE book_id IS NULL;
END $do$;

CREATE INDEX IF NOT EXISTS idx_transactions_book  ON public.transactions  (book_id);
CREATE INDEX IF NOT EXISTS idx_customers_book      ON public.customers     (book_id);
CREATE INDEX IF NOT EXISTS idx_debts_book          ON public.debts         (book_id);
CREATE INDEX IF NOT EXISTS idx_debt_payments_book  ON public.debt_payments (book_id);

NOTIFY pgrst, 'reload schema';
