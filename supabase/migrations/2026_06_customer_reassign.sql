-- ═══════════════════════════════════════════════════════════════════
-- PINDAH CUSTOMER (Piutang & Order) — perbaiki relasi customer pada nota
-- yang sudah ada, plus log audit & soft-delete customer.
-- Idempotent. TIDAK mengubah nominal/invoice/rumus — hanya relasi customer.
-- ═══════════════════════════════════════════════════════════════════

-- ---------- Snapshot kolom customer ----------
ALTER TABLE public.transactions  ADD COLUMN IF NOT EXISTS customer_name  text;
ALTER TABLE public.debts         ADD COLUMN IF NOT EXISTS customer_name  text;
ALTER TABLE public.debts         ADD COLUMN IF NOT EXISTS customer_phone text;
ALTER TABLE public.debt_payments ADD COLUMN IF NOT EXISTS customer_id    uuid;
ALTER TABLE public.debt_payments ADD COLUMN IF NOT EXISTS customer_name  text;

-- ---------- Soft delete customer (cegah hard delete bila masih ada transaksi) ----------
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- ---------- Index customer_id ----------
CREATE INDEX IF NOT EXISTS idx_transactions_customer_id  ON public.transactions  (customer_id);
CREATE INDEX IF NOT EXISTS idx_debts_customer_id2        ON public.debts         (customer_id);
CREATE INDEX IF NOT EXISTS idx_debt_payments_customer_id ON public.debt_payments (customer_id);
CREATE INDEX IF NOT EXISTS idx_customers_deleted_at      ON public.customers     (deleted_at);

-- ---------- LOG: receivable_customer_changes ----------
CREATE TABLE IF NOT EXISTS public.receivable_customer_changes (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  old_customer_id        uuid,
  old_customer_name      text,
  new_customer_id        uuid,
  new_customer_name      text,
  affected_invoice_count int DEFAULT 0,
  affected_debt_count    int DEFAULT 0,
  changed_by             uuid,
  changed_by_name        text,
  changed_at             timestamptz DEFAULT now(),
  notes                  text DEFAULT ''
);

-- ---------- LOG: order_customer_changes ----------
CREATE TABLE IF NOT EXISTS public.order_customer_changes (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_no        text,
  order_id          uuid,
  old_customer_id   uuid,
  old_customer_name text,
  new_customer_id   uuid,
  new_customer_name text,
  changed_by        uuid,
  changed_by_name   text,
  changed_at        timestamptz DEFAULT now(),
  notes             text DEFAULT ''
);

-- ---------- RLS + GRANT untuk tabel log ----------
ALTER TABLE public.receivable_customer_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_customer_changes      ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN CREATE POLICY "anon all receivable_customer_changes" ON public.receivable_customer_changes FOR ALL USING (true) WITH CHECK (true); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY "anon all order_customer_changes"      ON public.order_customer_changes      FOR ALL USING (true) WITH CHECK (true); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.receivable_customer_changes, public.order_customer_changes TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
