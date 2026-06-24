-- ═══════════════════════════════════════════════════════════════════
-- SEWA TOKO DIBAYAR DIMUKA + AMORTISASI (prepaid_rents, prepaid_rent_schedules)
-- Uang keluar = total saat dibayar; beban laba/rugi = per bulan berjalan.
-- Sisa "Sewa Dibayar Dimuka" = total − beban yang sudah berjalan.
-- Idempotent. Jalankan di Supabase → SQL Editor.
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.prepaid_rents (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL,
  location         text,
  landlord_name    text,
  payment_date     date NOT NULL,
  start_date       date NOT NULL,
  end_date         date NOT NULL,
  duration_months  integer NOT NULL DEFAULT 1,
  total_amount     numeric NOT NULL DEFAULT 0,
  monthly_expense  numeric NOT NULL DEFAULT 0,
  payment_method   text DEFAULT 'transfer',
  proof_url        text,
  notes            text,
  status           text DEFAULT 'active',          -- active | done | cancelled
  created_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz
);

CREATE TABLE IF NOT EXISTS public.prepaid_rent_schedules (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prepaid_rent_id  uuid REFERENCES public.prepaid_rents(id) ON DELETE CASCADE,
  period_month     date NOT NULL,
  expense_amount   numeric NOT NULL DEFAULT 0,
  status           text DEFAULT 'pending',          -- pending | accrued | done
  expense_id       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz
);

CREATE INDEX IF NOT EXISTS idx_prepaid_rents_deleted ON public.prepaid_rents (deleted_at);
CREATE INDEX IF NOT EXISTS idx_prepaid_sched_rent    ON public.prepaid_rent_schedules (prepaid_rent_id);
CREATE INDEX IF NOT EXISTS idx_prepaid_sched_deleted ON public.prepaid_rent_schedules (deleted_at);

ALTER TABLE public.prepaid_rents           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.prepaid_rent_schedules  ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN CREATE POLICY "anon all prepaid_rents"     ON public.prepaid_rents          FOR ALL USING (true) WITH CHECK (true); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY "anon all prepaid_sched"     ON public.prepaid_rent_schedules FOR ALL USING (true) WITH CHECK (true); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT ALL ON public.prepaid_rents          TO anon, authenticated;
GRANT ALL ON public.prepaid_rent_schedules TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
