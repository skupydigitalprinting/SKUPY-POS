-- ═══════════════════════════════════════════════════════════════════
-- AUDIT ACCOUNTING + SOFT DELETE EXPENSES/PURCHASES
-- ═══════════════════════════════════════════════════════════════════
-- Tujuan: data yang dihapus/cancel TIDAK boleh lagi dihitung di mana pun.
--   • expenses & purchases jadi SOFT DELETE (deleted_at)
--   • acc_dashboard mengecualikan SEMUA data deleted_at (expenses, purchases,
--     supplier_debt_payments, bank_loan_payments, supplier_debts) dan
--     transaksi dibatalkan/deleted
--   • acc_resync merapikan jurnal hanya dari data valid (non-deleted)
-- Idempotent. Jalankan PALING AKHIR (setelah accounting_history_softdelete).
-- ═══════════════════════════════════════════════════════════════════

-- 1) Kolom deleted_at (idempotent) untuk audit & soft delete
ALTER TABLE public.expenses        ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE public.purchases       ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE public.debt_payments   ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE public.debts           ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE public.transactions    ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE public.bank_loans      ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_expenses_deleted  ON public.expenses  (deleted_at);
CREATE INDEX IF NOT EXISTS idx_purchases_deleted ON public.purchases (deleted_at);

-- 2) Trigger expense: soft-deleted → hapus jurnal & cash movement, jangan repost
CREATE OR REPLACE FUNCTION public.acc_fn_post_expense()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_amt numeric; v_cash text;
BEGIN
  IF (TG_OP='DELETE') THEN
    DELETE FROM public.accounting_entries WHERE source_type='expense' AND source_id=OLD.id;
    DELETE FROM public.cash_movements     WHERE source_type='expense' AND source_id=OLD.id;
    RETURN OLD;
  END IF;
  -- selalu bersihkan dulu (untuk UPDATE/edit/soft-delete)
  DELETE FROM public.accounting_entries WHERE source_type='expense' AND source_id=NEW.id;
  DELETE FROM public.cash_movements     WHERE source_type='expense' AND source_id=NEW.id;
  -- jika sudah dihapus (soft delete) → berhenti, tidak ada jurnal
  IF NEW.deleted_at IS NOT NULL THEN RETURN NEW; END IF;
  v_amt := round(COALESCE(NEW.amount,0));
  v_cash := public.acc_cash_code(NEW.method);
  IF v_amt <= 0 THEN RETURN NEW; END IF;
  INSERT INTO public.accounting_entries(entry_date,source_type,source_id,account_code,debit,credit,description)
  VALUES (NEW.expense_date,'expense',NEW.id,'6000',v_amt,0,COALESCE(NEW.category,'Beban')||' '||COALESCE(NEW.note,''));
  INSERT INTO public.accounting_entries(entry_date,source_type,source_id,account_code,debit,credit,description)
  VALUES (NEW.expense_date,'expense',NEW.id,v_cash,0,v_amt,'Pembayaran beban');
  INSERT INTO public.cash_movements(moved_at,direction,method,amount,source_type,source_id,note)
  VALUES (NEW.expense_date,'out',COALESCE(NEW.method,'cash'),v_amt,'expense',NEW.id,COALESCE(NEW.category,'Beban'));
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'acc_fn_post_expense dilewati: %', SQLERRM;
  RETURN COALESCE(NEW, OLD);
END; $$;

-- 3) Trigger purchase: soft-deleted → hapus jurnal & cash movement
CREATE OR REPLACE FUNCTION public.acc_fn_post_purchase()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_amt numeric; v_cash text;
BEGIN
  IF (TG_OP='DELETE') THEN
    DELETE FROM public.accounting_entries WHERE source_type='purchase' AND source_id=OLD.id;
    DELETE FROM public.cash_movements     WHERE source_type='purchase' AND source_id=OLD.id;
    RETURN OLD;
  END IF;
  DELETE FROM public.accounting_entries WHERE source_type='purchase' AND source_id=NEW.id;
  DELETE FROM public.cash_movements     WHERE source_type='purchase' AND source_id=NEW.id;
  IF NEW.deleted_at IS NOT NULL THEN RETURN NEW; END IF;
  v_amt := round(COALESCE(NEW.amount,0));
  v_cash := public.acc_cash_code(NEW.method);
  IF v_amt <= 0 THEN RETURN NEW; END IF;
  INSERT INTO public.accounting_entries(entry_date,source_type,source_id,account_code,debit,credit,description)
  VALUES (NEW.purchase_date,'purchase',NEW.id,'1300',v_amt,0,'Pembelian '||COALESCE(NEW.item,''));
  IF COALESCE(NEW.is_credit,false) THEN
    INSERT INTO public.accounting_entries(entry_date,source_type,source_id,account_code,debit,credit,description)
    VALUES (NEW.purchase_date,'purchase',NEW.id,'2000',0,v_amt,'Pembelian kredit '||COALESCE(NEW.supplier,''));
  ELSE
    INSERT INTO public.accounting_entries(entry_date,source_type,source_id,account_code,debit,credit,description)
    VALUES (NEW.purchase_date,'purchase',NEW.id,v_cash,0,v_amt,'Pembayaran pembelian');
    INSERT INTO public.cash_movements(moved_at,direction,method,amount,source_type,source_id,note)
    VALUES (NEW.purchase_date,'out',COALESCE(NEW.method,'cash'),v_amt,'purchase',NEW.id,COALESCE(NEW.item,'Pembelian'));
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'acc_fn_post_purchase dilewati: %', SQLERRM;
  RETURN COALESCE(NEW, OLD);
END; $$;

-- 4) acc_dashboard — AUDIT: kecualikan SEMUA data deleted/cancelled
CREATE OR REPLACE FUNCTION public.acc_dashboard(p_from date, p_to date)
RETURNS json LANGUAGE sql STABLE AS $$
  WITH cic_all AS (
    SELECT invoice_no, sum(round(amount)) AS cic
    FROM public.debt_payments WHERE invoice_no IS NOT NULL AND deleted_at IS NULL GROUP BY invoice_no
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
  -- expenses & purchases NON-DELETED (sumber utama bug "uang keluar")
  exp    AS (SELECT * FROM public.expenses  WHERE deleted_at IS NULL),
  pur    AS (SELECT * FROM public.purchases WHERE deleted_at IS NULL)
  SELECT json_build_object(
    'penjualan',        (SELECT COALESCE(sum(total),0) FROM txp),
    'uang_masuk_total', (SELECT COALESCE(sum(init_paid),0) FROM txp) + (SELECT COALESCE(sum(round(amount)),0) FROM dpp),
    'cash',     (SELECT COALESCE(sum(init_paid),0) FROM txp WHERE payment_method IN ('cash','hutang')) + (SELECT COALESCE(sum(round(amount)),0) FROM dpp WHERE payment_method='cash'),
    'transfer', (SELECT COALESCE(sum(init_paid),0) FROM txp WHERE payment_method='transfer') + (SELECT COALESCE(sum(round(amount)),0) FROM dpp WHERE payment_method='transfer'),
    'qris',     (SELECT COALESCE(sum(init_paid),0) FROM txp WHERE payment_method='qris') + (SELECT COALESCE(sum(round(amount)),0) FROM dpp WHERE payment_method='qris'),
    'cicilan',  (SELECT COALESCE(sum(round(amount)),0) FROM dpp),
    'penerimaan_piutang', (SELECT COALESCE(sum(init_paid),0) FROM txp WHERE payment_method='hutang') + (SELECT COALESCE(sum(round(amount)),0) FROM dpp),
    -- UANG KELUAR (tanpa data deleted)
    'pengeluaran_total', (SELECT COALESCE(sum(round(amount)),0) FROM exp WHERE expense_date BETWEEN p_from AND p_to)
                         + (SELECT COALESCE(sum(round(amount)),0) FROM pur WHERE COALESCE(is_credit,false)=false AND purchase_date BETWEEN p_from AND p_to)
                         + (SELECT COALESCE(sum(round(amount)),0) FROM sdp)
                         + (SELECT COALESCE(sum(round(amount)),0) FROM blp),
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
    'saldo_kas', (
      (SELECT COALESCE(sum(init_paid),0) FROM txall WHERE payment_method IN ('cash','hutang'))
      + (SELECT COALESCE(sum(round(amount)),0) FROM dpall WHERE payment_method='cash')
      - (SELECT COALESCE(sum(round(amount)),0) FROM exp WHERE method='cash' AND expense_date <= p_to)
      - (SELECT COALESCE(sum(round(amount)),0) FROM pur WHERE method='cash' AND COALESCE(is_credit,false)=false AND purchase_date <= p_to)
      - (SELECT COALESCE(sum(round(amount)),0) FROM sdpall WHERE method='cash')
      - (SELECT COALESCE(sum(round(amount)),0) FROM blpall WHERE method='cash')
    ),
    'saldo_rekening', (
      (SELECT COALESCE(sum(init_paid),0) FROM txall WHERE payment_method IN ('transfer','qris'))
      + (SELECT COALESCE(sum(round(amount)),0) FROM dpall WHERE payment_method IN ('transfer','qris'))
      - (SELECT COALESCE(sum(round(amount)),0) FROM exp WHERE method='transfer' AND expense_date <= p_to)
      - (SELECT COALESCE(sum(round(amount)),0) FROM pur WHERE method='transfer' AND COALESCE(is_credit,false)=false AND purchase_date <= p_to)
      - (SELECT COALESCE(sum(round(amount)),0) FROM sdpall WHERE method IN ('transfer','qris'))
      - (SELECT COALESCE(sum(round(amount)),0) FROM blpall WHERE method IN ('transfer','qris'))
    ),
    'modal_barang', (SELECT COALESCE(sum(round(amount)),0) FROM pur WHERE purchase_date BETWEEN p_from AND p_to)
                    + (SELECT COALESCE(sum(round(amount)),0) FROM exp WHERE category='Pembelian Bahan' AND expense_date BETWEEN p_from AND p_to)
  );
$$;
GRANT EXECUTE ON FUNCTION public.acc_dashboard(date, date) TO anon, authenticated;

-- 5) acc_resync — rapikan jurnal hanya dari data valid (non-deleted)
CREATE OR REPLACE FUNCTION public.acc_resync()
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- sentuh ulang baris valid → trigger repost; baris deleted ikut tersentuh
  -- tetapi trigger akan menghapus jurnalnya (karena deleted_at IS NOT NULL).
  UPDATE public.transactions SET total = total WHERE TRUE;
  BEGIN UPDATE public.expenses  SET amount = amount WHERE TRUE; EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN UPDATE public.purchases SET amount = amount WHERE TRUE; EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN UPDATE public.supplier_debt_payments SET amount = amount WHERE TRUE; EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN UPDATE public.bank_loan_payments     SET amount = amount WHERE TRUE; EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN UPDATE public.supplier_debts SET total = total WHERE TRUE; EXCEPTION WHEN OTHERS THEN NULL; END;
  -- buang jurnal/arus kas yatim dari expenses/purchases yang sudah soft-deleted
  BEGIN
    DELETE FROM public.accounting_entries ae
      WHERE ae.source_type='expense' AND EXISTS (SELECT 1 FROM public.expenses e WHERE e.id=ae.source_id AND e.deleted_at IS NOT NULL);
    DELETE FROM public.cash_movements cm
      WHERE cm.source_type='expense' AND EXISTS (SELECT 1 FROM public.expenses e WHERE e.id=cm.source_id AND e.deleted_at IS NOT NULL);
    DELETE FROM public.accounting_entries ae
      WHERE ae.source_type='purchase' AND EXISTS (SELECT 1 FROM public.purchases p WHERE p.id=ae.source_id AND p.deleted_at IS NOT NULL);
    DELETE FROM public.cash_movements cm
      WHERE cm.source_type='purchase' AND EXISTS (SELECT 1 FROM public.purchases p WHERE p.id=cm.source_id AND p.deleted_at IS NOT NULL);
  EXCEPTION WHEN OTHERS THEN NULL; END;
  RETURN json_build_object('ok', true);
EXCEPTION WHEN OTHERS THEN
  RETURN json_build_object('ok', false, 'error', SQLERRM);
END; $$;
GRANT EXECUTE ON FUNCTION public.acc_resync() TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
