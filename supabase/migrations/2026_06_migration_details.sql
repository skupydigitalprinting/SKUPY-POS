-- ═══════════════════════════════════════════════════════════════════
-- MIGRASI DATA AWAL (migration_details)
-- Jalankan SETELAH 2026_06_employees_master.sql. Idempotent.
--
-- Tujuan: owner bisa memasukkan transaksi LAMA (sebelum POS dipakai) tanpa
-- lewat kasir/order — tanpa invoice, tanpa order, tanpa potong stok.
--   • type='old_income'  → menambah Omset, Uang Masuk, Arus Kas, Laba.
--   • type='old_expense' → menambah Pengeluaran & Uang Keluar; mengurangi
--                          Arus Kas & Laba.
--   • Soft delete: deleted_at IS NOT NULL → TIDAK dihitung di mana pun.
-- acc_dashboard di-redefine penuh agar semua kartu Ringkasan realtime.
-- ═══════════════════════════════════════════════════════════════════

-- ---------- TABEL ----------
CREATE TABLE IF NOT EXISTS public.migration_details (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type        text NOT NULL CHECK (type IN ('old_income','old_expense')),
  trx_date    date NOT NULL DEFAULT now()::date,
  name        text NOT NULL DEFAULT '',     -- nama transaksi / sumber / kategori
  customer    text DEFAULT '',              -- customer (opsional, hanya pemasukan)
  amount      numeric NOT NULL DEFAULT 0,
  method      text DEFAULT 'cash',          -- cash | transfer | qris
  notes       text DEFAULT '',
  cashier_id  uuid,
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now(),
  deleted_at  timestamptz
);
-- Untuk instalasi lama yang sudah punya tabel tanpa kolom customer.
ALTER TABLE public.migration_details ADD COLUMN IF NOT EXISTS customer text DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_migdet_type    ON public.migration_details (type);
CREATE INDEX IF NOT EXISTS idx_migdet_date    ON public.migration_details (trx_date);
CREATE INDEX IF NOT EXISTS idx_migdet_deleted ON public.migration_details (deleted_at);

-- ---------- RLS + GRANT ----------
ALTER TABLE public.migration_details ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "anon all migration_details" ON public.migration_details FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.migration_details TO anon, authenticated;

-- ---------- BOOTSTRAP RPC: "Buat Database Otomatis" dari aplikasi ----------
-- Membuat/menyelaraskan tabel migration_details secara idempotent. Dipanggil
-- frontend lewat supabase.rpc('acc_bootstrap_migration_details') saat tabel
-- belum ada — owner tidak perlu buka SQL Editor.
CREATE OR REPLACE FUNCTION public.acc_bootstrap_migration_details()
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  CREATE TABLE IF NOT EXISTS public.migration_details (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    type text NOT NULL CHECK (type IN ('old_income','old_expense')),
    trx_date date NOT NULL DEFAULT now()::date,
    name text NOT NULL DEFAULT '',
    customer text DEFAULT '',
    amount numeric NOT NULL DEFAULT 0,
    method text DEFAULT 'cash',
    notes text DEFAULT '',
    cashier_id uuid,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now(),
    deleted_at timestamptz
  );
  ALTER TABLE public.migration_details ADD COLUMN IF NOT EXISTS customer text DEFAULT '';
  CREATE INDEX IF NOT EXISTS idx_migdet_type    ON public.migration_details (type);
  CREATE INDEX IF NOT EXISTS idx_migdet_date    ON public.migration_details (trx_date);
  CREATE INDEX IF NOT EXISTS idx_migdet_deleted ON public.migration_details (deleted_at);
  ALTER TABLE public.migration_details ENABLE ROW LEVEL SECURITY;
  BEGIN
    CREATE POLICY "anon all migration_details" ON public.migration_details FOR ALL USING (true) WITH CHECK (true);
  EXCEPTION WHEN duplicate_object THEN NULL; END;
  GRANT SELECT, INSERT, UPDATE, DELETE ON public.migration_details TO anon, authenticated;
  NOTIFY pgrst, 'reload schema';
  RETURN json_build_object('ok', true);
END; $$;
GRANT EXECUTE ON FUNCTION public.acc_bootstrap_migration_details() TO anon, authenticated;

-- ---------- acc_dashboard: + Pemasukan/Pengeluaran Lama (migrasi) ----------
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
