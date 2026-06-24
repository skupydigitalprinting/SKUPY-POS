-- ═══════════════════════════════════════════════════════════════════
-- MASTER DATA KARYAWAN (employees)
-- Jalankan SETELAH 2026_06_employee_cash_advances.sql. Idempotent.
--
-- Tujuan:
--   • Simpan daftar karyawan sekali → input kasbon berikutnya tinggal pilih.
--   • employee_cash_advances dapat tautan employee_id (opsional) + tetap
--     menyimpan employee_name sebagai SNAPSHOT (tahan walau master diubah).
--   • Pengelompokan kasbon per karyawan memakai employee_id bila ada,
--     fallback ke nama (di sisi aplikasi).
-- ═══════════════════════════════════════════════════════════════════

-- ---------- TABEL: employees ----------
CREATE TABLE IF NOT EXISTS public.employees (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  phone       text DEFAULT '',
  position    text DEFAULT '',
  notes       text DEFAULT '',
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now(),
  deleted_at  timestamptz
);
CREATE INDEX IF NOT EXISTS idx_employees_name    ON public.employees (name);
CREATE INDEX IF NOT EXISTS idx_employees_deleted ON public.employees (deleted_at);

-- ---------- KOLOM TAUTAN di employee_cash_advances ----------
-- employee_name (snapshot) sudah ada dari migrasi sebelumnya.
ALTER TABLE public.employee_cash_advances
  ADD COLUMN IF NOT EXISTS employee_id uuid REFERENCES public.employees(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_eca_employee ON public.employee_cash_advances (employee_id);

-- ---------- RLS + GRANT (pola sama modul accounting lain) ----------
ALTER TABLE public.employees ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "anon all employees" ON public.employees FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.employees TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
