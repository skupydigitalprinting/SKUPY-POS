-- ═══════════════════════════════════════════════════════════════════
-- KASBON KARYAWAN (employee cash advances)
-- Jalankan SETELAH semua migrasi accounting lain (paling akhir bersama
-- 2026_06_supplier_debt_fixes.sql). Idempotent.
--
-- Konsep akuntansi:
--   • Kasbon = ASET (Piutang Karyawan, akun 1250) — BUKAN beban/gaji,
--     tidak mengurangi laba bersih.
--   • Saat kasbon cair : Dr 1250 Piutang Karyawan / Cr Kas-Bank
--                        + cash_movements OUT  (Uang Keluar bertambah)
--   • Saat dibayar     : Dr Kas-Bank / Cr 1250
--                        + cash_movements IN   (Uang Masuk bertambah)
--   • paid di parent SELALU dihitung ulang dari SUM pembayaran
--     non-deleted (pola sama dengan hutang supplier — idempotent).
-- ═══════════════════════════════════════════════════════════════════

-- ---------- AKUN: Piutang Karyawan ----------
INSERT INTO public.accounts (code, name, type, normal) VALUES
  ('1250','Piutang Karyawan','asset','debit')
ON CONFLICT (code) DO NOTHING;

-- ---------- TABEL ----------
CREATE TABLE IF NOT EXISTS public.employee_cash_advances (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_name  text NOT NULL,
  amount         numeric NOT NULL DEFAULT 0,
  paid           numeric NOT NULL DEFAULT 0,
  remaining      numeric NOT NULL DEFAULT 0,
  advance_date   date NOT NULL DEFAULT now()::date,
  due_date       date,
  payment_method text DEFAULT 'cash',          -- cash | transfer
  notes          text DEFAULT '',
  status         text DEFAULT 'aktif',         -- aktif | lunas (otomatis)
  cashier_id     uuid,
  created_at     timestamptz DEFAULT now(),
  updated_at     timestamptz DEFAULT now(),
  deleted_at     timestamptz
);
CREATE INDEX IF NOT EXISTS idx_eca_status  ON public.employee_cash_advances (status);
CREATE INDEX IF NOT EXISTS idx_eca_deleted ON public.employee_cash_advances (deleted_at);
CREATE INDEX IF NOT EXISTS idx_eca_date    ON public.employee_cash_advances (advance_date);

CREATE TABLE IF NOT EXISTS public.employee_cash_advance_payments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cash_advance_id uuid REFERENCES public.employee_cash_advances(id) ON DELETE CASCADE,
  payment_date    date NOT NULL DEFAULT now()::date,
  amount          numeric NOT NULL DEFAULT 0,
  payment_method  text DEFAULT 'cash',         -- cash | transfer
  notes           text DEFAULT '',
  cashier_id      uuid,
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now(),
  deleted_at      timestamptz
);
CREATE INDEX IF NOT EXISTS idx_ecap_adv     ON public.employee_cash_advance_payments (cash_advance_id);
CREATE INDEX IF NOT EXISTS idx_ecap_deleted ON public.employee_cash_advance_payments (deleted_at);

-- ---------- TRIGGER: kasbon cair (Dr 1250 / Cr Kas-Bank + uang keluar) ----------
CREATE OR REPLACE FUNCTION public.acc_fn_post_employee_advance()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_amt numeric; v_cash text;
BEGIN
  IF (TG_OP='DELETE') THEN
    DELETE FROM public.accounting_entries WHERE source_type='employee_advance' AND source_id=OLD.id;
    DELETE FROM public.cash_movements     WHERE source_type='employee_advance' AND source_id=OLD.id;
    RETURN OLD;
  END IF;
  NEW.remaining := greatest(0, round(coalesce(NEW.amount,0)) - round(coalesce(NEW.paid,0)));
  NEW.status := CASE WHEN NEW.remaining <= 0 THEN 'lunas' ELSE 'aktif' END;
  NEW.updated_at := now();
  BEGIN
    DELETE FROM public.accounting_entries WHERE source_type='employee_advance' AND source_id=NEW.id;
    DELETE FROM public.cash_movements     WHERE source_type='employee_advance' AND source_id=NEW.id;
    v_amt := round(coalesce(NEW.amount,0));
    v_cash := public.acc_cash_code(NEW.payment_method);
    IF v_amt > 0 AND NEW.deleted_at IS NULL THEN
      INSERT INTO public.accounting_entries(entry_date,source_type,source_id,account_code,debit,credit,description,cashier_id)
      VALUES (coalesce(NEW.advance_date, now()::date),'employee_advance',NEW.id,'1250',v_amt,0,'Kasbon '||coalesce(NEW.employee_name,''),NEW.cashier_id);
      INSERT INTO public.accounting_entries(entry_date,source_type,source_id,account_code,debit,credit,description,cashier_id)
      VALUES (coalesce(NEW.advance_date, now()::date),'employee_advance',NEW.id,v_cash,0,v_amt,'Kas/Bank keluar (kasbon)',NEW.cashier_id);
      INSERT INTO public.cash_movements(moved_at,direction,method,amount,source_type,source_id,note,cashier_id)
      VALUES (coalesce(NEW.advance_date::timestamptz, now()),'out',coalesce(NEW.payment_method,'cash'),v_amt,'employee_advance',NEW.id,'Kasbon '||coalesce(NEW.employee_name,''),NEW.cashier_id);
    END IF;
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'employee_advance journal: %', SQLERRM; END;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS acc_trg_employee_advance ON public.employee_cash_advances;
CREATE TRIGGER acc_trg_employee_advance
BEFORE INSERT OR UPDATE OF amount, paid, advance_date, payment_method, deleted_at OR DELETE
ON public.employee_cash_advances
FOR EACH ROW EXECUTE FUNCTION public.acc_fn_post_employee_advance();

-- ---------- TRIGGER: pembayaran kasbon (Dr Kas-Bank / Cr 1250 + uang masuk) ----------
CREATE OR REPLACE FUNCTION public.acc_fn_post_employee_advance_payment()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_amt numeric; v_cash text; v_adv uuid; v_pid uuid;
BEGIN
  v_pid := COALESCE(NEW.id, OLD.id);
  v_adv := COALESCE(NEW.cash_advance_id, OLD.cash_advance_id);
  DELETE FROM public.accounting_entries WHERE source_type='employee_advance_payment' AND source_id=v_pid;
  DELETE FROM public.cash_movements     WHERE source_type='employee_advance_payment' AND source_id=v_pid;
  IF (TG_OP <> 'DELETE') AND NEW.deleted_at IS NULL THEN
    v_amt := round(coalesce(NEW.amount,0));
    v_cash := public.acc_cash_code(NEW.payment_method);
    IF v_amt > 0 THEN
      INSERT INTO public.accounting_entries(entry_date,source_type,source_id,account_code,debit,credit,description,cashier_id)
      VALUES (coalesce(NEW.payment_date, now()::date),'employee_advance_payment',NEW.id,v_cash,v_amt,0,'Pembayaran kasbon',NEW.cashier_id);
      INSERT INTO public.accounting_entries(entry_date,source_type,source_id,account_code,debit,credit,description,cashier_id)
      VALUES (coalesce(NEW.payment_date, now()::date),'employee_advance_payment',NEW.id,'1250',0,v_amt,'Pelunasan piutang karyawan',NEW.cashier_id);
      INSERT INTO public.cash_movements(moved_at,direction,method,amount,source_type,source_id,note,cashier_id)
      VALUES (coalesce(NEW.payment_date::timestamptz, now()),'in',coalesce(NEW.payment_method,'cash'),v_amt,'employee_advance_payment',NEW.id,'Pembayaran kasbon',NEW.cashier_id);
    END IF;
  END IF;
  -- recompute paid parent dari SUM pembayaran non-deleted (idempotent)
  UPDATE public.employee_cash_advances
    SET paid = (SELECT COALESCE(sum(round(amount)),0) FROM public.employee_cash_advance_payments WHERE cash_advance_id=v_adv AND deleted_at IS NULL)
    WHERE id = v_adv;
  RETURN COALESCE(NEW, OLD);
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'employee_advance_payment: %', SQLERRM;
  RETURN COALESCE(NEW, OLD);
END; $$;

DROP TRIGGER IF EXISTS acc_trg_employee_advance_payment ON public.employee_cash_advance_payments;
CREATE TRIGGER acc_trg_employee_advance_payment
AFTER INSERT OR UPDATE OR DELETE ON public.employee_cash_advance_payments
FOR EACH ROW EXECUTE FUNCTION public.acc_fn_post_employee_advance_payment();

-- ---------- RPC: hapus kasbon ATOMIK (soft delete kasbon + pembayarannya) ----------
CREATE OR REPLACE FUNCTION public.acc_delete_employee_advance(p_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_now timestamptz := now();
BEGIN
  UPDATE public.employee_cash_advance_payments
    SET deleted_at = v_now
    WHERE cash_advance_id = p_id AND deleted_at IS NULL;
  UPDATE public.employee_cash_advances
    SET deleted_at = v_now
    WHERE id = p_id AND deleted_at IS NULL;
END; $$;
GRANT EXECUTE ON FUNCTION public.acc_delete_employee_advance(uuid) TO anon, authenticated;

-- ---------- RLS + GRANT (pola sama dengan modul accounting lain) ----------
ALTER TABLE public.employee_cash_advances         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employee_cash_advance_payments ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN CREATE POLICY "anon all employee_cash_advances"         ON public.employee_cash_advances         FOR ALL USING (true) WITH CHECK (true); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY "anon all employee_cash_advance_payments" ON public.employee_cash_advance_payments FOR ALL USING (true) WITH CHECK (true); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.employee_cash_advances, public.employee_cash_advance_payments TO anon, authenticated;

-- ---------- acc_dashboard: + piutang_karyawan, kasbon mempengaruhi
--            Uang Masuk / Uang Keluar / Saldo Kas / Saldo Rekening ----------
CREATE OR REPLACE FUNCTION public.acc_dashboard(p_from date, p_to date)
RETURNS json LANGUAGE sql STABLE AS $$
  WITH cic_all AS (
    SELECT invoice_no, sum(round(amount)) AS cic
    FROM public.debt_payments WHERE deleted_at IS NULL AND invoice_no IS NOT NULL GROUP BY invoice_no
  ),
  txp AS (
    SELECT t.payment_method, round(t.total) AS total,
           GREATEST(0, round(t.paid) - COALESCE(ca.cic,0)) AS init_paid
    FROM public.transactions t LEFT JOIN cic_all ca ON ca.invoice_no = t.invoice_no
    WHERE COALESCE(t.order_status,'') <> 'dibatalkan' AND t.deleted_at IS NULL
      AND t.created_at::date BETWEEN p_from AND p_to
  ),
  txall AS (
    SELECT t.payment_method, GREATEST(0, round(t.paid) - COALESCE(ca.cic,0)) AS init_paid
    FROM public.transactions t LEFT JOIN cic_all ca ON ca.invoice_no = t.invoice_no
    WHERE COALESCE(t.order_status,'') <> 'dibatalkan' AND t.deleted_at IS NULL
      AND t.created_at::date <= p_to
  ),
  dpp    AS (SELECT * FROM public.debt_payments WHERE deleted_at IS NULL AND paid_at::date BETWEEN p_from AND p_to),
  dpall  AS (SELECT * FROM public.debt_payments WHERE deleted_at IS NULL AND paid_at::date <= p_to),
  sdp    AS (SELECT * FROM public.supplier_debt_payments WHERE deleted_at IS NULL AND paid_at::date BETWEEN p_from AND p_to),
  sdpall AS (SELECT * FROM public.supplier_debt_payments WHERE deleted_at IS NULL AND paid_at::date <= p_to),
  blp    AS (SELECT * FROM public.bank_loan_payments WHERE deleted_at IS NULL AND paid_at::date BETWEEN p_from AND p_to),
  blpall AS (SELECT * FROM public.bank_loan_payments WHERE deleted_at IS NULL AND paid_at::date <= p_to),
  exp    AS (SELECT * FROM public.expenses  WHERE deleted_at IS NULL),
  pur    AS (SELECT * FROM public.purchases WHERE deleted_at IS NULL),
  -- KASBON KARYAWAN
  eca    AS (SELECT * FROM public.employee_cash_advances WHERE deleted_at IS NULL AND advance_date BETWEEN p_from AND p_to),
  ecaall AS (SELECT * FROM public.employee_cash_advances WHERE deleted_at IS NULL AND advance_date <= p_to),
  ecp    AS (SELECT * FROM public.employee_cash_advance_payments WHERE deleted_at IS NULL AND payment_date BETWEEN p_from AND p_to),
  ecpall AS (SELECT * FROM public.employee_cash_advance_payments WHERE deleted_at IS NULL AND payment_date <= p_to)
  SELECT json_build_object(
    'penjualan',        (SELECT COALESCE(sum(total),0) FROM txp),
    'uang_masuk_total', (SELECT COALESCE(sum(init_paid),0) FROM txp) + (SELECT COALESCE(sum(round(amount)),0) FROM dpp)
                        + (SELECT COALESCE(sum(round(amount)),0) FROM ecp),
    'cash',     (SELECT COALESCE(sum(init_paid),0) FROM txp WHERE payment_method IN ('cash','hutang')) + (SELECT COALESCE(sum(round(amount)),0) FROM dpp WHERE payment_method='cash')
                + (SELECT COALESCE(sum(round(amount)),0) FROM ecp WHERE payment_method='cash'),
    'transfer', (SELECT COALESCE(sum(init_paid),0) FROM txp WHERE payment_method='transfer') + (SELECT COALESCE(sum(round(amount)),0) FROM dpp WHERE payment_method='transfer')
                + (SELECT COALESCE(sum(round(amount)),0) FROM ecp WHERE payment_method='transfer'),
    'qris',     (SELECT COALESCE(sum(init_paid),0) FROM txp WHERE payment_method='qris') + (SELECT COALESCE(sum(round(amount)),0) FROM dpp WHERE payment_method='qris'),
    'cicilan',  (SELECT COALESCE(sum(round(amount)),0) FROM dpp),
    'penerimaan_piutang', (SELECT COALESCE(sum(init_paid),0) FROM txp WHERE payment_method='hutang') + (SELECT COALESCE(sum(round(amount)),0) FROM dpp),
    'pengeluaran_total', (SELECT COALESCE(sum(round(amount)),0) FROM exp WHERE expense_date BETWEEN p_from AND p_to)
                         + (SELECT COALESCE(sum(round(amount)),0) FROM pur WHERE COALESCE(is_credit,false)=false AND purchase_date BETWEEN p_from AND p_to)
                         + (SELECT COALESCE(sum(round(amount)),0) FROM sdp)
                         + (SELECT COALESCE(sum(round(amount)),0) FROM blp)
                         + (SELECT COALESCE(sum(round(amount)),0) FROM eca),
    'pembelian_bahan',   (SELECT COALESCE(sum(round(amount)),0) FROM pur WHERE purchase_date BETWEEN p_from AND p_to)
                         + (SELECT COALESCE(sum(round(amount)),0) FROM exp WHERE category='Pembelian Bahan' AND expense_date BETWEEN p_from AND p_to),
    'gaji',        (SELECT COALESCE(sum(round(amount)),0) FROM exp WHERE category IN ('Gaji','Gaji Karyawan') AND expense_date BETWEEN p_from AND p_to),
    'operasional', (SELECT COALESCE(sum(round(amount)),0) FROM exp WHERE category NOT IN ('Gaji','Gaji Karyawan','Pembelian Bahan') AND expense_date BETWEEN p_from AND p_to),
    'beban_bunga', (SELECT COALESCE(sum(round(bunga)),0) FROM blp),
    'piutang_aktif', (SELECT COALESCE(sum(greatest(0, round(total_debt)-round(paid))),0) FROM public.debts WHERE deleted_at IS NULL),
    'sudah_bayar',   (SELECT COALESCE(sum(round(paid)),0) FROM public.debts WHERE deleted_at IS NULL),
    'hutang_supplier', (SELECT COALESCE(sum(greatest(0, round(total)-round(paid))),0) FROM public.supplier_debts WHERE status='aktif' AND deleted_at IS NULL),
    'hutang_bank',     (SELECT COALESCE(sum(round(sisa_pokok)),0) FROM public.bank_loans WHERE status='aktif' AND deleted_at IS NULL),
    'cicilan_bank',    (SELECT COALESCE(sum(round(amount)),0) FROM blp),
    'pinjaman_aktif',  (SELECT COUNT(*) FROM public.bank_loans WHERE status='aktif' AND deleted_at IS NULL),
    'persediaan',      (SELECT COALESCE(sum(round(amount)),0) FROM pur WHERE purchase_date <= p_to),
    -- PIUTANG KARYAWAN = total sisa kasbon yang masih aktif (non-deleted)
    'piutang_karyawan', (SELECT COALESCE(sum(greatest(0, round(amount)-round(paid))),0) FROM public.employee_cash_advances WHERE status='aktif' AND deleted_at IS NULL),
    'kasbon_keluar',    (SELECT COALESCE(sum(round(amount)),0) FROM eca),
    'kasbon_masuk',     (SELECT COALESCE(sum(round(amount)),0) FROM ecp),
    'saldo_kas', (
      (SELECT COALESCE(sum(init_paid),0) FROM txall WHERE payment_method IN ('cash','hutang'))
      + (SELECT COALESCE(sum(round(amount)),0) FROM dpall WHERE payment_method='cash')
      + (SELECT COALESCE(sum(round(amount)),0) FROM ecpall WHERE payment_method='cash')
      - (SELECT COALESCE(sum(round(amount)),0) FROM exp WHERE method='cash' AND expense_date <= p_to)
      - (SELECT COALESCE(sum(round(amount)),0) FROM pur WHERE method='cash' AND COALESCE(is_credit,false)=false AND purchase_date <= p_to)
      - (SELECT COALESCE(sum(round(amount)),0) FROM sdpall WHERE method='cash')
      - (SELECT COALESCE(sum(round(amount)),0) FROM blpall WHERE method='cash')
      - (SELECT COALESCE(sum(round(amount)),0) FROM ecaall WHERE payment_method='cash')
    ),
    'saldo_rekening', (
      (SELECT COALESCE(sum(init_paid),0) FROM txall WHERE payment_method IN ('transfer','qris'))
      + (SELECT COALESCE(sum(round(amount)),0) FROM dpall WHERE payment_method IN ('transfer','qris'))
      + (SELECT COALESCE(sum(round(amount)),0) FROM ecpall WHERE payment_method='transfer')
      - (SELECT COALESCE(sum(round(amount)),0) FROM exp WHERE method='transfer' AND expense_date <= p_to)
      - (SELECT COALESCE(sum(round(amount)),0) FROM pur WHERE method='transfer' AND COALESCE(is_credit,false)=false AND purchase_date <= p_to)
      - (SELECT COALESCE(sum(round(amount)),0) FROM sdpall WHERE method IN ('transfer','qris'))
      - (SELECT COALESCE(sum(round(amount)),0) FROM blpall WHERE method IN ('transfer','qris'))
      - (SELECT COALESCE(sum(round(amount)),0) FROM ecaall WHERE payment_method='transfer')
    ),
    'modal_barang', (SELECT COALESCE(sum(round(amount)),0) FROM pur WHERE purchase_date BETWEEN p_from AND p_to)
                    + (SELECT COALESCE(sum(round(amount)),0) FROM exp WHERE category='Pembelian Bahan' AND expense_date BETWEEN p_from AND p_to)
  );
$$;
GRANT EXECUTE ON FUNCTION public.acc_dashboard(date, date) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
