-- =====================================================================
-- Skupy POS — REKENING BANK PER ADMIN (admin_bank_accounts)
-- =====================================================================
-- Tiap admin bisa punya >1 rekening; hanya 1 default aktif per admin.
-- Invoice menampilkan rekening sesuai admin pembuat transaksi. Snapshot
-- rekening disimpan di transactions agar invoice lama tidak berubah.
-- Additive + idempotent + non-destruktif. Tidak mengubah rumus accounting.
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.admin_bank_accounts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id       uuid NOT NULL,
  bank_name      text NOT NULL,
  account_number text NOT NULL,
  account_holder text NOT NULL,
  branch         text,
  note           text,
  is_active      boolean NOT NULL DEFAULT true,
  is_default     boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz
);
ALTER TABLE public.admin_bank_accounts ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN CREATE POLICY "anon all admin_bank_accounts" ON public.admin_bank_accounts FOR ALL USING (true) WITH CHECK (true); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT ALL ON public.admin_bank_accounts TO anon, authenticated;

CREATE INDEX IF NOT EXISTS idx_aba_admin ON public.admin_bank_accounts(admin_id) WHERE deleted_at IS NULL;
-- Hanya boleh ada 1 rekening DEFAULT aktif per admin (enforce di DB).
CREATE UNIQUE INDEX IF NOT EXISTS uq_aba_default_per_admin
  ON public.admin_bank_accounts(admin_id)
  WHERE is_default = true AND deleted_at IS NULL;

-- ───── Snapshot rekening pada transactions (histori invoice tetap aman) ─────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='transactions') THEN
    BEGIN ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS bank_account_id uuid; EXCEPTION WHEN others THEN NULL; END;
    BEGIN ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS bank_name text; EXCEPTION WHEN others THEN NULL; END;
    BEGIN ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS bank_account_number text; EXCEPTION WHEN others THEN NULL; END;
    BEGIN ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS bank_account_holder text; EXCEPTION WHEN others THEN NULL; END;
    BEGIN ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS created_by_admin_id uuid; EXCEPTION WHEN others THEN NULL; END;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
