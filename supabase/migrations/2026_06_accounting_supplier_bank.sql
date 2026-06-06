-- ═══════════════════════════════════════════════════════════════════
-- ACCOUNTING — Supplier master + Hutang Bank + acc_dashboard upgrade
-- Idempotent. Supabase → SQL Editor → Run (setelah migrasi accounting lain).
-- ═══════════════════════════════════════════════════════════════════

-- ---------- SUPPLIER MASTER (lengkapi kolom) ----------
ALTER TABLE public.suppliers ADD COLUMN IF NOT EXISTS address    text DEFAULT '';
ALTER TABLE public.suppliers ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();
ALTER TABLE public.suppliers ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_suppliers_deleted ON public.suppliers (deleted_at);

-- ---------- AKUN tambahan: Hutang Bank & Beban Bunga ----------
INSERT INTO public.accounts (code, name, type, normal) VALUES
  ('2100','Hutang Bank','liability','credit'),
  ('6100','Beban Bunga & Adm Bank','expense','debit')
ON CONFLICT (code) DO NOTHING;

-- ---------- HUTANG BANK ----------
CREATE TABLE IF NOT EXISTS public.bank_loans (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nama_bank           text NOT NULL,
  jenis_pinjaman      text DEFAULT '',
  nomor_kontrak       text DEFAULT '',
  tanggal_mulai       date,
  tanggal_jatuh_tempo date,
  plafon_pinjaman     numeric NOT NULL DEFAULT 0,
  sisa_pokok          numeric NOT NULL DEFAULT 0,
  bunga               numeric DEFAULT 0,           -- % per tahun (informasi)
  cicilan_bulanan     numeric DEFAULT 0,
  keterangan          text DEFAULT '',
  status              text DEFAULT 'aktif',        -- aktif | lunas
  created_at          timestamptz DEFAULT now(),
  updated_at          timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bank_loans_status ON public.bank_loans (status);
CREATE INDEX IF NOT EXISTS idx_bank_loans_jt     ON public.bank_loans (tanggal_jatuh_tempo);

CREATE TABLE IF NOT EXISTS public.bank_loan_payments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id    uuid REFERENCES public.bank_loans(id) ON DELETE CASCADE,
  paid_at    timestamptz DEFAULT now(),
  amount     numeric NOT NULL DEFAULT 0,           -- total cicilan
  pokok      numeric NOT NULL DEFAULT 0,           -- bagian pokok → kurangi hutang
  bunga      numeric NOT NULL DEFAULT 0,           -- bagian bunga → beban
  method     text DEFAULT 'cash',                  -- cash | transfer | qris
  note       text DEFAULT '',
  cashier_id uuid,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bank_loan_pay_loan ON public.bank_loan_payments (loan_id);

-- Trigger: bayar cicilan bank → uang keluar, pokok kurangi hutang, bunga jadi beban.
CREATE OR REPLACE FUNCTION public.acc_fn_post_bank_payment()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_amt numeric; v_pok numeric; v_bun numeric; v_cash text;
BEGIN
  IF (TG_OP='DELETE') THEN
    DELETE FROM public.accounting_entries WHERE source_type='bank_payment' AND source_id=OLD.id;
    DELETE FROM public.cash_movements     WHERE source_type='bank_payment' AND source_id=OLD.id;
    UPDATE public.bank_loans SET sisa_pokok = round(sisa_pokok) + round(OLD.pokok) WHERE id = OLD.loan_id;
    RETURN OLD;
  END IF;
  DELETE FROM public.accounting_entries WHERE source_type='bank_payment' AND source_id=NEW.id;
  DELETE FROM public.cash_movements     WHERE source_type='bank_payment' AND source_id=NEW.id;
  v_amt := round(coalesce(NEW.amount,0));
  v_pok := round(coalesce(NEW.pokok,0));
  v_bun := round(coalesce(NEW.bunga,0));
  IF v_pok + v_bun = 0 AND v_amt > 0 THEN v_pok := v_amt; END IF; -- kalau tak dipisah → semua pokok
  v_cash := public.acc_cash_code(NEW.method);
  IF v_amt > 0 THEN
    IF v_pok > 0 THEN
      INSERT INTO public.accounting_entries(entry_date,source_type,source_id,account_code,debit,credit,description,cashier_id)
      VALUES (NEW.paid_at::date,'bank_payment',NEW.id,'2100',v_pok,0,'Pokok cicilan bank',NEW.cashier_id);
    END IF;
    IF v_bun > 0 THEN
      INSERT INTO public.accounting_entries(entry_date,source_type,source_id,account_code,debit,credit,description,cashier_id)
      VALUES (NEW.paid_at::date,'bank_payment',NEW.id,'6100',v_bun,0,'Bunga/adm bank',NEW.cashier_id);
    END IF;
    INSERT INTO public.accounting_entries(entry_date,source_type,source_id,account_code,debit,credit,description,cashier_id)
    VALUES (NEW.paid_at::date,'bank_payment',NEW.id,v_cash,0,v_amt,'Pembayaran cicilan bank',NEW.cashier_id);
    INSERT INTO public.cash_movements(moved_at,direction,method,amount,source_type,source_id,note,cashier_id)
    VALUES (NEW.paid_at,'out',coalesce(NEW.method,'cash'),v_amt,'bank_payment',NEW.id,'Cicilan bank',NEW.cashier_id);
    UPDATE public.bank_loans
      SET sisa_pokok = greatest(0, round(sisa_pokok) - v_pok),
          status = CASE WHEN greatest(0, round(sisa_pokok) - v_pok) <= 0 THEN 'lunas' ELSE 'aktif' END
      WHERE id = NEW.loan_id;
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'acc_fn_post_bank_payment dilewati: %', SQLERRM;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END; $$;

DROP TRIGGER IF EXISTS acc_trg_bank_payment ON public.bank_loan_payments;
CREATE TRIGGER acc_trg_bank_payment
AFTER INSERT OR DELETE ON public.bank_loan_payments
FOR EACH ROW EXECUTE FUNCTION public.acc_fn_post_bank_payment();

-- ---------- RLS + GRANT ----------
ALTER TABLE public.bank_loans          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bank_loan_payments  ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN CREATE POLICY "anon all bank_loans"         ON public.bank_loans         FOR ALL USING (true) WITH CHECK (true); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY "anon all bank_loan_payments" ON public.bank_loan_payments FOR ALL USING (true) WITH CHECK (true); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.bank_loans, public.bank_loan_payments TO anon, authenticated;

-- ---------- acc_dashboard: tambah hutang_bank, cicilan_bank, persediaan ----------
CREATE OR REPLACE FUNCTION public.acc_dashboard(p_from date, p_to date)
RETURNS json LANGUAGE sql STABLE AS $$
  WITH cic_all AS (
    SELECT invoice_no, sum(round(amount)) AS cic
    FROM public.debt_payments WHERE invoice_no IS NOT NULL GROUP BY invoice_no
  ),
  txp AS (
    SELECT t.payment_method, round(t.total) AS total,
           GREATEST(0, round(t.paid) - COALESCE(ca.cic,0)) AS init_paid
    FROM public.transactions t LEFT JOIN cic_all ca ON ca.invoice_no = t.invoice_no
    WHERE COALESCE(t.order_status,'') <> 'dibatalkan' AND t.created_at::date BETWEEN p_from AND p_to
  ),
  txall AS (
    SELECT t.payment_method, GREATEST(0, round(t.paid) - COALESCE(ca.cic,0)) AS init_paid
    FROM public.transactions t LEFT JOIN cic_all ca ON ca.invoice_no = t.invoice_no
    WHERE COALESCE(t.order_status,'') <> 'dibatalkan' AND t.created_at::date <= p_to
  ),
  dpp  AS (SELECT * FROM public.debt_payments WHERE paid_at::date BETWEEN p_from AND p_to),
  dpall AS (SELECT * FROM public.debt_payments WHERE paid_at::date <= p_to)
  SELECT json_build_object(
    'penjualan',        (SELECT COALESCE(sum(total),0) FROM txp),
    'uang_masuk_total', (SELECT COALESCE(sum(init_paid),0) FROM txp) + (SELECT COALESCE(sum(round(amount)),0) FROM dpp),
    'cash',     (SELECT COALESCE(sum(init_paid),0) FROM txp WHERE payment_method IN ('cash','hutang')) + (SELECT COALESCE(sum(round(amount)),0) FROM dpp WHERE payment_method='cash'),
    'transfer', (SELECT COALESCE(sum(init_paid),0) FROM txp WHERE payment_method='transfer') + (SELECT COALESCE(sum(round(amount)),0) FROM dpp WHERE payment_method='transfer'),
    'qris',     (SELECT COALESCE(sum(init_paid),0) FROM txp WHERE payment_method='qris') + (SELECT COALESCE(sum(round(amount)),0) FROM dpp WHERE payment_method='qris'),
    'cicilan',  (SELECT COALESCE(sum(round(amount)),0) FROM dpp),
    'penerimaan_piutang', (SELECT COALESCE(sum(init_paid),0) FROM txp WHERE payment_method='hutang') + (SELECT COALESCE(sum(round(amount)),0) FROM dpp),
    'pengeluaran_total', (SELECT COALESCE(sum(round(amount)),0) FROM public.expenses WHERE expense_date BETWEEN p_from AND p_to)
                         + (SELECT COALESCE(sum(round(amount)),0) FROM public.purchases WHERE COALESCE(is_credit,false)=false AND purchase_date BETWEEN p_from AND p_to)
                         + (SELECT COALESCE(sum(round(amount)),0) FROM public.bank_loan_payments WHERE paid_at::date BETWEEN p_from AND p_to),
    'pembelian_bahan',   (SELECT COALESCE(sum(round(amount)),0) FROM public.purchases WHERE purchase_date BETWEEN p_from AND p_to)
                         + (SELECT COALESCE(sum(round(amount)),0) FROM public.expenses WHERE category='Pembelian Bahan' AND expense_date BETWEEN p_from AND p_to),
    'gaji',        (SELECT COALESCE(sum(round(amount)),0) FROM public.expenses WHERE category IN ('Gaji','Gaji Karyawan') AND expense_date BETWEEN p_from AND p_to),
    'operasional', (SELECT COALESCE(sum(round(amount)),0) FROM public.expenses WHERE category NOT IN ('Gaji','Gaji Karyawan','Pembelian Bahan') AND expense_date BETWEEN p_from AND p_to),
    'beban_bunga', (SELECT COALESCE(sum(round(bunga)),0) FROM public.bank_loan_payments WHERE paid_at::date BETWEEN p_from AND p_to),
    'piutang_aktif', (SELECT COALESCE(sum(greatest(0, round(total_debt)-round(paid))),0) FROM public.debts),
    'sudah_bayar',   (SELECT COALESCE(sum(round(paid)),0) FROM public.debts),
    'hutang_supplier', (SELECT COALESCE(sum(greatest(0, round(total)-round(paid))),0) FROM public.supplier_debts WHERE status='aktif'),
    'hutang_bank',     (SELECT COALESCE(sum(round(sisa_pokok)),0) FROM public.bank_loans WHERE status='aktif'),
    'cicilan_bank',    (SELECT COALESCE(sum(round(amount)),0) FROM public.bank_loan_payments WHERE paid_at::date BETWEEN p_from AND p_to),
    'pinjaman_aktif',  (SELECT COUNT(*) FROM public.bank_loans WHERE status='aktif'),
    'persediaan',      (SELECT COALESCE(sum(round(amount)),0) FROM public.purchases WHERE purchase_date <= p_to),
    'saldo_kas', (
      (SELECT COALESCE(sum(init_paid),0) FROM txall WHERE payment_method IN ('cash','hutang'))
      + (SELECT COALESCE(sum(round(amount)),0) FROM dpall WHERE payment_method='cash')
      - (SELECT COALESCE(sum(round(amount)),0) FROM public.expenses WHERE method='cash' AND expense_date <= p_to)
      - (SELECT COALESCE(sum(round(amount)),0) FROM public.purchases WHERE method='cash' AND COALESCE(is_credit,false)=false AND purchase_date <= p_to)
      - (SELECT COALESCE(sum(round(amount)),0) FROM public.bank_loan_payments WHERE method='cash' AND paid_at::date <= p_to)
    ),
    'saldo_rekening', (
      (SELECT COALESCE(sum(init_paid),0) FROM txall WHERE payment_method IN ('transfer','qris'))
      + (SELECT COALESCE(sum(round(amount)),0) FROM dpall WHERE payment_method IN ('transfer','qris'))
      - (SELECT COALESCE(sum(round(amount)),0) FROM public.expenses WHERE method='transfer' AND expense_date <= p_to)
      - (SELECT COALESCE(sum(round(amount)),0) FROM public.purchases WHERE method='transfer' AND COALESCE(is_credit,false)=false AND purchase_date <= p_to)
      - (SELECT COALESCE(sum(round(amount)),0) FROM public.bank_loan_payments WHERE method='transfer' AND paid_at::date <= p_to)
    ),
    'modal_barang', (SELECT COALESCE(sum(round(amount)),0) FROM public.purchases WHERE purchase_date BETWEEN p_from AND p_to)
                    + (SELECT COALESCE(sum(round(amount)),0) FROM public.expenses WHERE category='Pembelian Bahan' AND expense_date BETWEEN p_from AND p_to)
  );
$$;
GRANT EXECUTE ON FUNCTION public.acc_dashboard(date, date) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
