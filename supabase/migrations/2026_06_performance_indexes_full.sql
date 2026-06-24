-- ─────────────────────────────────────────────────────────────
-- Audit & lengkapi index untuk performa query (anti statement timeout).
-- Semua IF NOT EXISTS → aman dijalankan kapan saja, idempotent.
-- Cara pakai: Supabase → SQL Editor → Run.
-- ─────────────────────────────────────────────────────────────

-- TRANSACTIONS
CREATE INDEX IF NOT EXISTS idx_transactions_invoice_no    ON public.transactions (invoice_no);
CREATE INDEX IF NOT EXISTS idx_transactions_customer      ON public.transactions (customer_id);
CREATE INDEX IF NOT EXISTS idx_transactions_created_at    ON public.transactions (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_status        ON public.transactions (status);
CREATE INDEX IF NOT EXISTS idx_transactions_order_status  ON public.transactions (order_status);

-- DEBTS
CREATE INDEX IF NOT EXISTS idx_debts_customer    ON public.debts (customer_id);
CREATE INDEX IF NOT EXISTS idx_debts_invoice_no  ON public.debts (invoice_no);
CREATE INDEX IF NOT EXISTS idx_debts_status      ON public.debts (status);
CREATE INDEX IF NOT EXISTS idx_debts_due_date    ON public.debts (due_date);

-- CUSTOMERS
CREATE INDEX IF NOT EXISTS idx_customers_name        ON public.customers (name);
CREATE INDEX IF NOT EXISTS idx_customers_created_at  ON public.customers (created_at DESC);

-- PRODUCTS
CREATE INDEX IF NOT EXISTS idx_products_category    ON public.products (category);
CREATE INDEX IF NOT EXISTS idx_products_name        ON public.products (name);
CREATE INDEX IF NOT EXISTS idx_products_created_at  ON public.products (created_at DESC);

NOTIFY pgrst, 'reload schema';
