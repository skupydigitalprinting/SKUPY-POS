-- ═══════════════════════════════════════════════════════════════════
-- ACCOUNTING — Riwayat pembayaran + soft delete + edit (bank & supplier)
-- + pembelian TEMPO otomatis ke Hutang Supplier (DP sebagai pembayaran).
--
-- Prinsip anti-drift: SALDO PARENT DIHITUNG ULANG dari SUM pembayaran yang
-- belum dihapus (bukan increment manual). Jadi edit/soft-delete selalu sinkron.
--   • bank_loans.sisa_pokok = pokok_awal − Σ(pokok payment non-deleted)
--   • supplier_debts.paid    = Σ(amount payment non-deleted)
-- Jurnal akuntansi (uang keluar) hanya diposting untuk payment yang AKTIF
-- (deleted_at IS NULL) → arus kas otomatis terkoreksi saat edit/hapus.
--
-- Idempotent. Supabase → SQL Editor → Run (setelah migrasi accounting lain).
-- ═══════════════════════════════════════════════════════════════════

-- ---------- Kolom baru ----------
ALTER TABLE public.bank_loans            ADD COLUMN IF NOT EXISTS pokok_awal numeric;
UPDATE public.bank_loans SET pokok_awal = sisa_pokok WHERE pokok_awal IS NULL;

ALTER TABLE public.bank_loan_payments    ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE public.bank_loan_payments    ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

ALTER TABLE public.supplier_debt_payments ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE public.supplier_debt_payments ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

ALTER TABLE public.supplier_debts ADD COLUMN IF NOT EXISTS deleted_at     timestamptz;
ALTER TABLE public.supplier_debts ADD COLUMN IF NOT EXISTS payment_method text DEFAULT 'transfer';
ALTER TABLE public.supplier_debts ADD COLUMN IF NOT EXISTS purchase_id    uuid;
ALTER TABLE public.supplier_debts ADD COLUMN IF NOT EXISTS updated_at     timestamptz DEFAULT now();
CREATE INDEX IF NOT EXISTS idx_supplier_debts_deleted ON public.supplier_debts (deleted_at);

-- ═══════════════ SUPPLIER DEBT (akrual: Dr Persediaan / Cr Hutang) ═══════════════
-- Soft-deleted debt → jurnal dihapus & tidak dihitung.
CREATE OR REPLACE FUNCTION public.acc_fn_post_supplier_debt()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_total numeric;
BEGIN
  IF (TG_OP='DELETE') THEN
    DELETE FROM public.accounting_entries WHERE source_type='supplier_debt' AND source_id=OLD.id;
    RETURN OLD;
  END IF;
  NEW.remaining := greatest(0, round(coalesce(NEW.total,0)) - round(coalesce(NEW.paid,0)));
  NEW.status := CASE WHEN NEW.remaining <= 0 THEN 'lunas' ELSE 'aktif' END;
  BEGIN
    DELETE FROM public.accounting_entries WHERE source_type='supplier_debt' AND source_id=NEW.id;
    v_total := round(coalesce(NEW.total,0));
    IF v_total > 0 AND NEW.deleted_at IS NULL THEN
      INSERT INTO public.accounting_entries(entry_date,source_type,source_id,account_code,debit,credit,description)
      VALUES (coalesce(NEW.created_at::date, now()::date),'supplier_debt',NEW.id,'1300',v_total,0,'Pembelian kredit '||coalesce(NEW.supplier,''));
      INSERT INTO public.accounting_entries(entry_date,source_type,source_id,account_code,debit,credit,description)
      VALUES (coalesce(NEW.created_at::date, now()::date),'supplier_debt',NEW.id,'2000',0,v_total,'Hutang ke '||coalesce(NEW.supplier,''));
    END IF;
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'supplier_debt journal: %', SQLERRM; END;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS acc_trg_supplier_debt ON public.supplier_debts;
CREATE TRIGGER acc_trg_supplier_debt
BEFORE INSERT OR UPDATE OF total, paid, deleted_at OR DELETE ON public.supplier_debts
FOR EACH ROW EXECUTE FUNCTION public.acc_fn_post_supplier_debt();

-- ═══════════════ SUPPLIER PAYMENT (recompute paid dari SUM) ═══════════════
CREATE OR REPLACE FUNCTION public.acc_fn_post_supplier_payment()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_amt numeric; v_cash text; v_debt uuid; v_pid uuid;
BEGIN
  v_pid  := COALESCE(NEW.id, OLD.id);
  v_debt := COALESCE(NEW.supplier_debt_id, OLD.supplier_debt_id);
  -- bersihkan jurnal lama untuk payment ini
  DELETE FROM public.accounting_entries WHERE source_type='supplier_payment' AND source_id=v_pid;
  DELETE FROM public.cash_movements     WHERE source_type='supplier_payment' AND source_id=v_pid;
  -- repost hanya kalau aktif (bukan delete, bukan soft-deleted)
  IF (TG_OP <> 'DELETE') AND NEW.deleted_at IS NULL THEN
    v_amt := round(coalesce(NEW.amount,0));
    v_cash := public.acc_cash_code(NEW.method);
    IF v_amt > 0 THEN
      INSERT INTO public.accounting_entries(entry_date,source_type,source_id,account_code,debit,credit,description,cashier_id)
      VALUES (NEW.paid_at::date,'supplier_payment',NEW.id,'2000',v_amt,0,'Bayar hutang supplier',NEW.cashier_id);
      INSERT INTO public.accounting_entries(entry_date,source_type,source_id,account_code,debit,credit,description,cashier_id)
      VALUES (NEW.paid_at::date,'supplier_payment',NEW.id,v_cash,0,v_amt,'Kas/Bank keluar (hutang supplier)',NEW.cashier_id);
      INSERT INTO public.cash_movements(moved_at,direction,method,amount,source_type,source_id,note,cashier_id)
      VALUES (NEW.paid_at,'out',coalesce(NEW.method,'transfer'),v_amt,'supplier_payment',NEW.id,'Bayar hutang supplier',NEW.cashier_id);
    END IF;
  END IF;
  -- recompute paid parent dari SUM payment non-deleted
  UPDATE public.supplier_debts
    SET paid = (SELECT COALESCE(sum(round(amount)),0) FROM public.supplier_debt_payments WHERE supplier_debt_id=v_debt AND deleted_at IS NULL)
    WHERE id = v_debt;
  RETURN COALESCE(NEW, OLD);
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'supplier_payment: %', SQLERRM;
  RETURN COALESCE(NEW, OLD);
END; $$;
DROP TRIGGER IF EXISTS acc_trg_supplier_payment ON public.supplier_debt_payments;
CREATE TRIGGER acc_trg_supplier_payment
AFTER INSERT OR UPDATE OR DELETE ON public.supplier_debt_payments
FOR EACH ROW EXECUTE FUNCTION public.acc_fn_post_supplier_payment();

-- ═══════════════ BANK PAYMENT (recompute sisa_pokok dari SUM) ═══════════════
CREATE OR REPLACE FUNCTION public.acc_fn_post_bank_payment()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_amt numeric; v_pok numeric; v_bun numeric; v_cash text; v_loan uuid; v_pid uuid; v_awal numeric; v_sumpok numeric;
BEGIN
  v_pid  := COALESCE(NEW.id, OLD.id);
  v_loan := COALESCE(NEW.loan_id, OLD.loan_id);
  DELETE FROM public.accounting_entries WHERE source_type='bank_payment' AND source_id=v_pid;
  DELETE FROM public.cash_movements     WHERE source_type='bank_payment' AND source_id=v_pid;
  IF (TG_OP <> 'DELETE') AND NEW.deleted_at IS NULL THEN
    v_amt := round(coalesce(NEW.amount,0));
    v_pok := round(coalesce(NEW.pokok,0));
    v_bun := round(coalesce(NEW.bunga,0));
    IF v_pok + v_bun = 0 AND v_amt > 0 THEN v_pok := v_amt; END IF;
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
      VALUES (NEW.paid_at,'out',coalesce(NEW.method,'transfer'),v_amt,'bank_payment',NEW.id,'Cicilan bank',NEW.cashier_id);
    END IF;
  END IF;
  -- recompute sisa_pokok = pokok_awal − Σ pokok payment non-deleted
  SELECT COALESCE(pokok_awal, sisa_pokok) INTO v_awal FROM public.bank_loans WHERE id=v_loan;
  SELECT COALESCE(sum(round(pokok)),0) INTO v_sumpok FROM public.bank_loan_payments WHERE loan_id=v_loan AND deleted_at IS NULL;
  UPDATE public.bank_loans
    SET sisa_pokok = greatest(0, COALESCE(v_awal,0) - v_sumpok),
        status = CASE WHEN greatest(0, COALESCE(v_awal,0) - v_sumpok) <= 0 THEN 'lunas' ELSE 'aktif' END
    WHERE id = v_loan;
  RETURN COALESCE(NEW, OLD);
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'bank_payment: %', SQLERRM;
  RETURN COALESCE(NEW, OLD);
END; $$;
DROP TRIGGER IF EXISTS acc_trg_bank_payment ON public.bank_loan_payments;
CREATE TRIGGER acc_trg_bank_payment
AFTER INSERT OR UPDATE OR DELETE ON public.bank_loan_payments
FOR EACH ROW EXECUTE FUNCTION public.acc_fn_post_bank_payment();

-- ═══════════════ acc_dashboard: ikutkan pembayaran supplier ke uang keluar/saldo
--                 + kecualikan payment yang deleted_at ═══════════════
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
  dpall AS (SELECT * FROM public.debt_payments WHERE paid_at::date <= p_to),
  sdp  AS (SELECT * FROM public.supplier_debt_payments WHERE deleted_at IS NULL AND paid_at::date BETWEEN p_from AND p_to),
  sdpall AS (SELECT * FROM public.supplier_debt_payments WHERE deleted_at IS NULL AND paid_at::date <= p_to),
  blp  AS (SELECT * FROM public.bank_loan_payments WHERE deleted_at IS NULL AND paid_at::date BETWEEN p_from AND p_to),
  blpall AS (SELECT * FROM public.bank_loan_payments WHERE deleted_at IS NULL AND paid_at::date <= p_to)
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
                         + (SELECT COALESCE(sum(round(amount)),0) FROM sdp)
                         + (SELECT COALESCE(sum(round(amount)),0) FROM blp),
    'pembelian_bahan',   (SELECT COALESCE(sum(round(amount)),0) FROM public.purchases WHERE purchase_date BETWEEN p_from AND p_to)
                         + (SELECT COALESCE(sum(round(amount)),0) FROM public.expenses WHERE category='Pembelian Bahan' AND expense_date BETWEEN p_from AND p_to),
    'gaji',        (SELECT COALESCE(sum(round(amount)),0) FROM public.expenses WHERE category IN ('Gaji','Gaji Karyawan') AND expense_date BETWEEN p_from AND p_to),
    'operasional', (SELECT COALESCE(sum(round(amount)),0) FROM public.expenses WHERE category NOT IN ('Gaji','Gaji Karyawan','Pembelian Bahan') AND expense_date BETWEEN p_from AND p_to),
    'beban_bunga', (SELECT COALESCE(sum(round(bunga)),0) FROM blp),
    'piutang_aktif', (SELECT COALESCE(sum(greatest(0, round(total_debt)-round(paid))),0) FROM public.debts),
    'sudah_bayar',   (SELECT COALESCE(sum(round(paid)),0) FROM public.debts),
    'hutang_supplier', (SELECT COALESCE(sum(greatest(0, round(total)-round(paid))),0) FROM public.supplier_debts WHERE status='aktif' AND deleted_at IS NULL),
    'hutang_bank',     (SELECT COALESCE(sum(round(sisa_pokok)),0) FROM public.bank_loans WHERE status='aktif'),
    'cicilan_bank',    (SELECT COALESCE(sum(round(amount)),0) FROM blp),
    'pinjaman_aktif',  (SELECT COUNT(*) FROM public.bank_loans WHERE status='aktif'),
    'persediaan',      (SELECT COALESCE(sum(round(amount)),0) FROM public.purchases WHERE purchase_date <= p_to),
    'saldo_kas', (
      (SELECT COALESCE(sum(init_paid),0) FROM txall WHERE payment_method IN ('cash','hutang'))
      + (SELECT COALESCE(sum(round(amount)),0) FROM dpall WHERE payment_method='cash')
      - (SELECT COALESCE(sum(round(amount)),0) FROM public.expenses WHERE method='cash' AND expense_date <= p_to)
      - (SELECT COALESCE(sum(round(amount)),0) FROM public.purchases WHERE method='cash' AND COALESCE(is_credit,false)=false AND purchase_date <= p_to)
      - (SELECT COALESCE(sum(round(amount)),0) FROM sdpall WHERE method='cash')
      - (SELECT COALESCE(sum(round(amount)),0) FROM blpall WHERE method='cash')
    ),
    'saldo_rekening', (
      (SELECT COALESCE(sum(init_paid),0) FROM txall WHERE payment_method IN ('transfer','qris'))
      + (SELECT COALESCE(sum(round(amount)),0) FROM dpall WHERE payment_method IN ('transfer','qris'))
      - (SELECT COALESCE(sum(round(amount)),0) FROM public.expenses WHERE method='transfer' AND expense_date <= p_to)
      - (SELECT COALESCE(sum(round(amount)),0) FROM public.purchases WHERE method='transfer' AND COALESCE(is_credit,false)=false AND purchase_date <= p_to)
      - (SELECT COALESCE(sum(round(amount)),0) FROM sdpall WHERE method IN ('transfer','qris'))
      - (SELECT COALESCE(sum(round(amount)),0) FROM blpall WHERE method IN ('transfer','qris'))
    ),
    'modal_barang', (SELECT COALESCE(sum(round(amount)),0) FROM public.purchases WHERE purchase_date BETWEEN p_from AND p_to)
                    + (SELECT COALESCE(sum(round(amount)),0) FROM public.expenses WHERE category='Pembelian Bahan' AND expense_date BETWEEN p_from AND p_to)
  );
$$;
GRANT EXECUTE ON FUNCTION public.acc_dashboard(date, date) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
