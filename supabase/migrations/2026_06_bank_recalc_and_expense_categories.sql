-- ═══════════════════════════════════════════════════════════════════
-- 1) FIX HUTANG BANK: recalculate sisa_pokok dari SUM(amount) pembayaran aktif
--    + 2) MASTER KATEGORI PENGELUARAN (expense_categories)
-- Idempotent. Jalankan PALING AKHIR di Supabase SQL Editor.
-- ═══════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────
-- BAGIAN 1: BANK LOAN RECALCULATION (sumber bug sisa pokok)
-- ─────────────────────────────────────────────────────────────
ALTER TABLE public.bank_loans ADD COLUMN IF NOT EXISTS pokok_awal numeric;

-- Set pokok_awal = pokok awal pinjaman = sisa sekarang + total pembayaran aktif.
-- Stabil & idempotent: bila dijalankan ulang, sisa selalu konsisten.
UPDATE public.bank_loans b
   SET pokok_awal = COALESCE(b.sisa_pokok,0)
     + COALESCE((SELECT sum(round(p.amount)) FROM public.bank_loan_payments p
                 WHERE p.loan_id = b.id AND p.deleted_at IS NULL),0)
 WHERE pokok_awal IS NULL OR pokok_awal < COALESCE(b.sisa_pokok,0);

-- Fungsi recalculation terpusat: remaining = pokok_awal − Σ(amount aktif)
CREATE OR REPLACE FUNCTION public.acc_recalc_bank_loan(p_loan uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_awal numeric; v_paid numeric; v_sisa numeric;
BEGIN
  SELECT COALESCE(pokok_awal, sisa_pokok, 0) INTO v_awal FROM public.bank_loans WHERE id = p_loan;
  SELECT COALESCE(sum(round(amount)),0) INTO v_paid
    FROM public.bank_loan_payments WHERE loan_id = p_loan AND deleted_at IS NULL;
  v_sisa := greatest(0, COALESCE(v_awal,0) - v_paid);
  UPDATE public.bank_loans
     SET sisa_pokok = v_sisa,
         status = CASE WHEN v_sisa <= 0 THEN 'lunas' ELSE 'aktif' END
   WHERE id = p_loan;
END; $$;
GRANT EXECUTE ON FUNCTION public.acc_recalc_bank_loan(uuid) TO anon, authenticated;

-- Trigger pembayaran bank: recompute dari SUM(amount) — seluruh nominal = pokok.
-- Insert/Update/Delete/soft-delete semua memanggil recalc → sisa pokok selalu benar.
CREATE OR REPLACE FUNCTION public.acc_fn_post_bank_payment()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_amt numeric; v_cash text; v_loan uuid; v_pid uuid;
BEGIN
  v_pid  := COALESCE(NEW.id, OLD.id);
  v_loan := COALESCE(NEW.loan_id, OLD.loan_id);
  DELETE FROM public.accounting_entries WHERE source_type='bank_payment' AND source_id=v_pid;
  DELETE FROM public.cash_movements     WHERE source_type='bank_payment' AND source_id=v_pid;
  IF (TG_OP <> 'DELETE') AND NEW.deleted_at IS NULL THEN
    v_amt := round(coalesce(NEW.amount,0));
    IF v_amt > 0 THEN
      v_cash := public.acc_cash_code(NEW.method);
      -- Dr 2100 Hutang Bank / Cr Kas-Bank (seluruh nominal = pokok)
      INSERT INTO public.accounting_entries(entry_date,source_type,source_id,account_code,debit,credit,description,cashier_id)
      VALUES (NEW.paid_at::date,'bank_payment',NEW.id,'2100',v_amt,0,'Pembayaran pokok hutang bank',NEW.cashier_id);
      INSERT INTO public.accounting_entries(entry_date,source_type,source_id,account_code,debit,credit,description,cashier_id)
      VALUES (NEW.paid_at::date,'bank_payment',NEW.id,v_cash,0,v_amt,'Pembayaran hutang bank',NEW.cashier_id);
      INSERT INTO public.cash_movements(moved_at,direction,method,amount,source_type,source_id,note,cashier_id)
      VALUES (NEW.paid_at,'out',coalesce(NEW.method,'transfer'),v_amt,'bank_payment',NEW.id,'Cicilan bank',NEW.cashier_id);
    END IF;
  END IF;
  PERFORM public.acc_recalc_bank_loan(v_loan);
  RETURN COALESCE(NEW, OLD);
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'bank_payment: %', SQLERRM;
  RETURN COALESCE(NEW, OLD);
END; $$;
DROP TRIGGER IF EXISTS acc_trg_bank_payment ON public.bank_loan_payments;
CREATE TRIGGER acc_trg_bank_payment
AFTER INSERT OR UPDATE OR DELETE ON public.bank_loan_payments
FOR EACH ROW EXECUTE FUNCTION public.acc_fn_post_bank_payment();

-- Recalc semua pinjaman sekali agar konsisten dengan model baru
DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT id FROM public.bank_loans LOOP
    PERFORM public.acc_recalc_bank_loan(r.id);
  END LOOP;
END $$;

-- ─────────────────────────────────────────────────────────────
-- BAGIAN 2: MASTER KATEGORI PENGELUARAN
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.expense_categories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);
CREATE INDEX IF NOT EXISTS idx_expense_categories_deleted ON public.expense_categories (deleted_at);

ALTER TABLE public.expense_categories ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "anon all expense_categories" ON public.expense_categories FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Seed kategori default (hanya jika tabel kosong)
INSERT INTO public.expense_categories (name)
SELECT x FROM unnest(ARRAY[
  'Gaji Karyawan','Listrik','Air','Internet','Transportasi','BBM','Makan & Minum',
  'Pembelian Bahan','Perawatan Mesin','Sewa','Pajak','Cicilan Bank','Hutang Supplier',
  'Operasional','Pengeluaran Lainnya'
]) AS x
WHERE NOT EXISTS (SELECT 1 FROM public.expense_categories);

GRANT ALL ON public.expense_categories TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
