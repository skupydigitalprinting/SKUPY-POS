-- ═══════════════════════════════════════════════════════════════════
-- KEPEMILIKAN CUSTOMER (PIC / Penanggung Jawab)
-- Idempotent. TIDAK mengubah invoice/transaksi/piutang/nominal — hanya
-- menambah kolom kepemilikan + backfill aman.
--   • owner_user_id = PIC customer (kasir hanya lihat customer miliknya).
--   • created_by tetap = pembuat (badge "Dibuat oleh").
-- ═══════════════════════════════════════════════════════════════════

-- ---------- Kolom PIC di customers ----------
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS owner_user_id  uuid;
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS owner_username text;
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS owner_name     text;
CREATE INDEX IF NOT EXISTS idx_customers_owner_user_id ON public.customers (owner_user_id);

-- ---------- Kolom PIC di transactions (untuk laporan per PIC) ----------
ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS owner_user_id uuid;
ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS owner_name    text;
CREATE INDEX IF NOT EXISTS idx_transactions_owner_user_id ON public.transactions (owner_user_id);

-- ---------- BACKFILL customer lama ----------
-- 1) owner = created_by bila ada
UPDATE public.customers SET owner_user_id = created_by
  WHERE owner_user_id IS NULL AND created_by IS NOT NULL;
-- 2) sisanya → Owner pertama (Admin Utama)
UPDATE public.customers SET owner_user_id = (
    SELECT id FROM public.admins WHERE role = 'owner' ORDER BY created_at ASC LIMIT 1
  )
  WHERE owner_user_id IS NULL;
-- 3) isi snapshot username/name dari admins
UPDATE public.customers c
  SET owner_username = a.username,
      owner_name     = COALESCE(NULLIF(a.name,''), a.username)
  FROM public.admins a
  WHERE c.owner_user_id = a.id
    AND (c.owner_username IS NULL OR c.owner_name IS NULL);

-- ---------- LOG: customer_owner_changes ----------
CREATE TABLE IF NOT EXISTS public.customer_owner_changes (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id    uuid,
  customer_name  text,
  old_owner_id   uuid,
  old_owner_name text,
  new_owner_id   uuid,
  new_owner_name text,
  changed_by     uuid,
  changed_by_name text,
  changed_at     timestamptz DEFAULT now()
);
ALTER TABLE public.customer_owner_changes ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN CREATE POLICY "anon all customer_owner_changes" ON public.customer_owner_changes FOR ALL USING (true) WITH CHECK (true); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.customer_owner_changes TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
