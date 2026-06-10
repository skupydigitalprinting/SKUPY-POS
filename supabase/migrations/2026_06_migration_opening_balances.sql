-- ═══════════════════════════════════════════════════════════════════
-- MIGRASI SALDO AWAL: Piutang Customer Lama & Kasbon Karyawan Lama
-- Jalankan SETELAH 2026_06_migration_details.sql. Idempotent.
--
-- Konsep:
--   • Piutang Customer Lama  → baris `debts` (is_opening=true) TANPA
--     transaksi/invoice. Menambah Piutang Usaha & Total Aset; TIDAK jadi
--     omset / uang masuk. Bisa dibayar normal di modul Piutang (pembayaran
--     standalone didukung di aplikasi).
--   • Kasbon Karyawan Lama   → baris `employee_cash_advances` (is_opening=true).
--     Menambah Piutang Karyawan & Total Aset; TIDAK jadi Uang Keluar/beban
--     (saldo awal). Bisa dibayar FIFO seperti kasbon biasa.
-- ═══════════════════════════════════════════════════════════════════

-- ---------- KOLOM is_opening ----------
ALTER TABLE public.employee_cash_advances ADD COLUMN IF NOT EXISTS is_opening boolean DEFAULT false;
ALTER TABLE public.debts                  ADD COLUMN IF NOT EXISTS is_opening boolean DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_eca_opening   ON public.employee_cash_advances (is_opening);
CREATE INDEX IF NOT EXISTS idx_debts_opening ON public.debts (is_opening);

-- ---------- TRIGGER kasbon: lewati jurnal & arus kas bila SALDO AWAL ----------
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
    IF v_amt > 0 AND NEW.deleted_at IS NULL AND COALESCE(NEW.is_opening,false)=false THEN
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
BEFORE INSERT OR UPDATE OF amount, paid, advance_date, payment_method, deleted_at, is_opening OR DELETE
ON public.employee_cash_advances
FOR EACH ROW EXECUTE FUNCTION public.acc_fn_post_employee_advance();

-- ---------- acc_dashboard: kasbon SALDO AWAL tidak dihitung sbg Uang Keluar ----------
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
  eca    AS (SELECT * FROM public.employee_cash_advances WHERE deleted_at IS NULL AND COALESCE(is_opening,false)=false AND advance_date BETWEEN p_from AND p_to),
  ecaall AS (SELECT * FROM public.employee_cash_advances WHERE deleted_at IS NULL AND COALESCE(is_opening,false)=false AND advance_date <= p_to),
  ecp    AS (SELECT * FROM public.employee_cash_advance_payments WHERE deleted_at IS NULL AND payment_date BETWEEN p_from AND p_to),
  ecpall AS (SELECT * FROM public.employee_cash_advance_payments WHERE deleted_at IS NULL AND payment_date <= p_to),
  -- MIGRASI DATA AWAL (pemasukan/pengeluaran lama)
  oi     AS (SELECT * FROM public.migration_details WHERE type='old_income'  AND deleted_at IS NULL AND trx_date BETWEEN p_from AND p_to),
  oiall  AS (SELECT * FROM public.migration_details WHERE type='old_income'  AND deleted_at IS NULL AND trx_date <= p_to),
  oe     AS (SELECT * FROM public.migration_details WHERE type='old_expense' AND deleted_at IS NULL AND trx_date BETWEEN p_from AND p_to),
  oeall  AS (SELECT * FROM public.migration_details WHERE type='old_expense' AND deleted_at IS NULL AND trx_date <= p_to)
  SELECT json_build_object(
    'penjualan',        (SELECT COALESCE(sum(total),0) FROM txp)
                        + (SELECT COALESCE(sum(round(amount)),0) FROM oi),
    'uang_masuk_total', (SELECT COALESCE(sum(init_paid),0) FROM txp) + (SELECT COALESCE(sum(round(amount)),0) FROM dpp)
                        + (SELECT COALESCE(sum(round(amount)),0) FROM ecp)
                        + (SELECT COALESCE(sum(round(amount)),0) FROM oi),
    'cash',     (SELECT COALESCE(sum(init_paid),0) FROM txp WHERE payment_method IN ('cash','hutang')) + (SELECT COALESCE(sum(round(amount)),0) FROM dpp WHERE payment_method='cash')
                + (SELECT COALESCE(sum(round(amount)),0) FROM ecp WHERE payment_method='cash')
                + (SELECT COALESCE(sum(round(amount)),0) FROM oi WHERE method='cash'),
    'transfer', (SELECT COALESCE(sum(init_paid),0) FROM txp WHERE payment_method='transfer') + (SELECT COALESCE(sum(round(amount)),0) FROM dpp WHERE payment_method='transfer')
                + (SELECT COALESCE(sum(round(amount)),0) FROM ecp WHERE payment_method='transfer')
                + (SELECT COALESCE(sum(round(amount)),0) FROM oi WHERE method='transfer'),
    'qris',     (SELECT COALESCE(sum(init_paid),0) FROM txp WHERE payment_method='qris') + (SELECT COALESCE(sum(round(amount)),0) FROM dpp WHERE payment_method='qris')
                + (SELECT COALESCE(sum(round(amount)),0) FROM oi WHERE method='qris'),
    'cicilan',  (SELECT COALESCE(sum(round(amount)),0) FROM dpp),
    'penerimaan_piutang', (SELECT COALESCE(sum(init_paid),0) FROM txp WHERE payment_method='hutang') + (SELECT COALESCE(sum(round(amount)),0) FROM dpp),
    'pengeluaran_total', (SELECT COALESCE(sum(round(amount)),0) FROM exp WHERE expense_date BETWEEN p_from AND p_to)
                         + (SELECT COALESCE(sum(round(amount)),0) FROM pur WHERE COALESCE(is_credit,false)=false AND purchase_date BETWEEN p_from AND p_to)
                         + (SELECT COALESCE(sum(round(amount)),0) FROM sdp)
                         + (SELECT COALESCE(sum(round(amount)),0) FROM blp)
                         + (SELECT COALESCE(sum(round(amount)),0) FROM eca)
                         + (SELECT COALESCE(sum(round(amount)),0) FROM oe),
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
    -- MIGRASI DATA AWAL (informasi)
    'omset_migrasi',       (SELECT COALESCE(sum(round(amount)),0) FROM oi),
    'pengeluaran_migrasi', (SELECT COALESCE(sum(round(amount)),0) FROM oe),
    'saldo_kas', (
      (SELECT COALESCE(sum(init_paid),0) FROM txall WHERE payment_method IN ('cash','hutang'))
      + (SELECT COALESCE(sum(round(amount)),0) FROM dpall WHERE payment_method='cash')
      + (SELECT COALESCE(sum(round(amount)),0) FROM ecpall WHERE payment_method='cash')
      + (SELECT COALESCE(sum(round(amount)),0) FROM oiall WHERE method='cash')
      - (SELECT COALESCE(sum(round(amount)),0) FROM exp WHERE method='cash' AND expense_date <= p_to)
      - (SELECT COALESCE(sum(round(amount)),0) FROM pur WHERE method='cash' AND COALESCE(is_credit,false)=false AND purchase_date <= p_to)
      - (SELECT COALESCE(sum(round(amount)),0) FROM sdpall WHERE method='cash')
      - (SELECT COALESCE(sum(round(amount)),0) FROM blpall WHERE method='cash')
      - (SELECT COALESCE(sum(round(amount)),0) FROM ecaall WHERE payment_method='cash')
      - (SELECT COALESCE(sum(round(amount)),0) FROM oeall WHERE method='cash')
    ),
    'saldo_rekening', (
      (SELECT COALESCE(sum(init_paid),0) FROM txall WHERE payment_method IN ('transfer','qris'))
      + (SELECT COALESCE(sum(round(amount)),0) FROM dpall WHERE payment_method IN ('transfer','qris'))
      + (SELECT COALESCE(sum(round(amount)),0) FROM ecpall WHERE payment_method='transfer')
      + (SELECT COALESCE(sum(round(amount)),0) FROM oiall WHERE method IN ('transfer','qris'))
      - (SELECT COALESCE(sum(round(amount)),0) FROM exp WHERE method='transfer' AND expense_date <= p_to)
      - (SELECT COALESCE(sum(round(amount)),0) FROM pur WHERE method='transfer' AND COALESCE(is_credit,false)=false AND purchase_date <= p_to)
      - (SELECT COALESCE(sum(round(amount)),0) FROM sdpall WHERE method IN ('transfer','qris'))
      - (SELECT COALESCE(sum(round(amount)),0) FROM blpall WHERE method IN ('transfer','qris'))
      - (SELECT COALESCE(sum(round(amount)),0) FROM ecaall WHERE payment_method='transfer')
      - (SELECT COALESCE(sum(round(amount)),0) FROM oeall WHERE method IN ('transfer','qris'))
    ),
    'modal_barang', (SELECT COALESCE(sum(round(amount)),0) FROM pur WHERE purchase_date BETWEEN p_from AND p_to)
                    + (SELECT COALESCE(sum(round(amount)),0) FROM exp WHERE category='Pembelian Bahan' AND expense_date BETWEEN p_from AND p_to)
  );
$$;
GRANT EXECUTE ON FUNCTION public.acc_dashboard(date, date) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
