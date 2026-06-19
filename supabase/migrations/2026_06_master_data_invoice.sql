-- =====================================================================
-- Skupy POS — MASTER DATA INVOICE (alamat, kontak, rekening) + profil admin
-- =====================================================================
-- Owner input master sekali; saat atur admin tinggal pilih. Invoice mengambil
-- data sesuai profil admin pembuat + SNAPSHOT ke transaksi (histori aman).
-- Additive + idempotent + non-destruktif. Tidak mengubah rumus accounting.
-- =====================================================================

-- 1) Master Alamat Toko
CREATE TABLE IF NOT EXISTS public.store_locations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_name text NOT NULL,
  store_name    text,
  address       text NOT NULL,
  city          text,
  note          text,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);
ALTER TABLE public.store_locations ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN CREATE POLICY "anon all store_locations" ON public.store_locations FOR ALL USING (true) WITH CHECK (true); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT ALL ON public.store_locations TO anon, authenticated;

-- 2) Master Kontak / Telepon
CREATE TABLE IF NOT EXISTS public.store_contacts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_name text NOT NULL,
  phone        text,
  whatsapp     text,
  note         text,
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz
);
ALTER TABLE public.store_contacts ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN CREATE POLICY "anon all store_contacts" ON public.store_contacts FOR ALL USING (true) WITH CHECK (true); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT ALL ON public.store_contacts TO anon, authenticated;

-- 3) Master Rekening Bank (level toko)
CREATE TABLE IF NOT EXISTS public.store_bank_accounts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bank_name      text NOT NULL,
  account_number text NOT NULL,
  account_holder text NOT NULL,
  note           text,
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz
);
ALTER TABLE public.store_bank_accounts ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN CREATE POLICY "anon all store_bank_accounts" ON public.store_bank_accounts FOR ALL USING (true) WITH CHECK (true); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT ALL ON public.store_bank_accounts TO anon, authenticated;

-- 4) Profil Invoice Admin (relasi admin → master data)
CREATE TABLE IF NOT EXISTS public.admin_invoice_profiles (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id        uuid NOT NULL,
  location_id     uuid REFERENCES public.store_locations(id),
  contact_id      uuid REFERENCES public.store_contacts(id),
  bank_account_id uuid REFERENCES public.store_bank_accounts(id),
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);
ALTER TABLE public.admin_invoice_profiles ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN CREATE POLICY "anon all admin_invoice_profiles" ON public.admin_invoice_profiles FOR ALL USING (true) WITH CHECK (true); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT ALL ON public.admin_invoice_profiles TO anon, authenticated;
-- Satu profil aktif per admin.
CREATE UNIQUE INDEX IF NOT EXISTS uq_aip_admin ON public.admin_invoice_profiles(admin_id) WHERE deleted_at IS NULL;

-- 5) Snapshot toko/alamat/telepon pada transactions (histori invoice aman).
--    Snapshot rekening (bank_name/bank_account_number/bank_account_holder)
--    sudah ada dari migrasi admin_bank_accounts.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='transactions') THEN
    BEGIN ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS store_name_snapshot text; EXCEPTION WHEN others THEN NULL; END;
    BEGIN ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS address_snapshot text; EXCEPTION WHEN others THEN NULL; END;
    BEGIN ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS phone_snapshot text; EXCEPTION WHEN others THEN NULL; END;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
