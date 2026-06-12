-- =============================================================
-- SKUPY POS — SETUP ACCOUNTING & SEMUA FITUR (SATU FILE)
-- Jalankan SELURUH isi file ini SEKALI di Supabase -> SQL Editor.
-- Aman dijalankan berulang (idempotent): pakai IF NOT EXISTS,
-- CREATE OR REPLACE, DROP TRIGGER IF EXISTS, dan guard policy.
-- Urutan sudah benar; fungsi acc_dashboard versi final dibuat di
-- bagian migration_opening_balances.
-- Dibuat otomatis 2026-06-10T20:18:45Z
-- =============================================================


-- ==============================================================
-- [01/24] 2026_06_accounting_module.sql
-- ==============================================================
-- ═══════════════════════════════════════════════════════════════════
-- MODUL ACCOUNTING — terintegrasi dengan Skupy POS (DB Supabase yang sama)
-- ═══════════════════════════════════════════════════════════════════
-- Setiap transaksi POS otomatis membuat jurnal double-entry lewat TRIGGER,
-- jadi data POS & Accounting tidak pernah beda (sumber tunggal: tabel POS).
--
-- Pemetaan otomatis:
--   • Penjualan cash/transfer/qris  → Kas/Bank (debit) + Pendapatan (kredit)
--   • Penjualan hutang/tempo (sisa) → Piutang Usaha (debit) + Pendapatan
--   • DP hutang                     → Kas/Bank (debit)
--   • Bayar cicilan (transactions.paid naik) → trigger repost: Kas/Bank naik,
--                                              Piutang turun (tanpa double)
--   • Pengeluaran operasional       → Beban (debit) + Kas/Bank (kredit)
--   • Pembelian bahan/stok          → Persediaan (debit) + Kas/Bank/Hutang
--
-- Idempotent — aman dijalankan ulang. Cara pakai: Supabase → SQL Editor → Run.
-- ═══════════════════════════════════════════════════════════════════

-- ---------- TABEL ----------
CREATE TABLE IF NOT EXISTS public.accounts (
  code   text PRIMARY KEY,
  name   text NOT NULL,
  type   text NOT NULL,              -- asset | liability | equity | revenue | expense
  normal text NOT NULL DEFAULT 'debit'
);

CREATE TABLE IF NOT EXISTS public.accounting_entries (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_date   date NOT NULL DEFAULT now(),
  source_type  text NOT NULL,        -- sale | expense | purchase | manual
  source_id    uuid,
  invoice_no   text,
  account_code text NOT NULL REFERENCES public.accounts(code),
  debit        numeric NOT NULL DEFAULT 0,
  credit       numeric NOT NULL DEFAULT 0,
  description  text DEFAULT '',
  created_at   timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_acc_entries_source   ON public.accounting_entries (source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_acc_entries_account  ON public.accounting_entries (account_code);
CREATE INDEX IF NOT EXISTS idx_acc_entries_date     ON public.accounting_entries (entry_date DESC);
CREATE INDEX IF NOT EXISTS idx_acc_entries_invoice  ON public.accounting_entries (invoice_no);

CREATE TABLE IF NOT EXISTS public.cash_movements (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  moved_at    timestamptz DEFAULT now(),
  direction   text NOT NULL,         -- in | out
  method      text DEFAULT 'cash',   -- cash | transfer | qris
  amount      numeric NOT NULL DEFAULT 0,
  source_type text,
  source_id   uuid,
  invoice_no  text,
  note        text DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_cash_mov_date   ON public.cash_movements (moved_at DESC);
CREATE INDEX IF NOT EXISTS idx_cash_mov_source ON public.cash_movements (source_type, source_id);

CREATE TABLE IF NOT EXISTS public.expenses (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_date date NOT NULL DEFAULT now(),
  category     text DEFAULT 'Operasional',
  amount       numeric NOT NULL DEFAULT 0,
  method       text DEFAULT 'cash',
  note         text DEFAULT '',
  cashier_id   uuid REFERENCES public.admins(id) ON DELETE SET NULL,
  created_at   timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_expenses_date ON public.expenses (expense_date DESC);

CREATE TABLE IF NOT EXISTS public.purchases (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_date date NOT NULL DEFAULT now(),
  supplier      text DEFAULT '',
  item          text DEFAULT '',
  qty           numeric DEFAULT 0,
  amount        numeric NOT NULL DEFAULT 0,
  method        text DEFAULT 'cash',
  is_credit     boolean DEFAULT false,    -- true → masuk Hutang Usaha
  note          text DEFAULT '',
  created_at    timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_purchases_date ON public.purchases (purchase_date DESC);

CREATE TABLE IF NOT EXISTS public.assets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  category    text DEFAULT '',
  value       numeric NOT NULL DEFAULT 0,
  acquired_at date DEFAULT now(),
  note        text DEFAULT '',
  created_at  timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.liabilities (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  amount     numeric NOT NULL DEFAULT 0,
  due_date   date,
  note       text DEFAULT '',
  created_at timestamptz DEFAULT now()
);

-- ---------- CHART OF ACCOUNTS (seed) ----------
INSERT INTO public.accounts (code, name, type, normal) VALUES
  ('1000','Kas','asset','debit'),
  ('1100','Bank','asset','debit'),
  ('1200','Piutang Usaha','asset','debit'),
  ('1300','Persediaan','asset','debit'),
  ('1400','Aset Tetap','asset','debit'),
  ('2000','Hutang Usaha','liability','credit'),
  ('3000','Modal','equity','credit'),
  ('4000','Pendapatan Penjualan','revenue','credit'),
  ('5000','Harga Pokok Penjualan','expense','debit'),
  ('6000','Beban Operasional','expense','debit')
ON CONFLICT (code) DO NOTHING;

-- ---------- HELPER: metode bayar → kode akun kas/bank ----------
CREATE OR REPLACE FUNCTION public.acc_cash_code(method text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN method IN ('transfer','qris') THEN '1100' ELSE '1000' END;
$$;

-- ═══════════════ TRIGGER: TRANSACTIONS (penjualan + DP + cicilan) ═══════════════
-- Sumber tunggal kas/piutang penjualan. Repost tiap INSERT/UPDATE (paid berubah
-- saat bayar cicilan) → tidak ada double counting. Hapus saat DELETE/batal.
CREATE OR REPLACE FUNCTION public.acc_fn_post_transaction()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_total numeric; v_paid numeric; v_rem numeric;
  v_cash text; v_date date;
BEGIN
  IF (TG_OP = 'DELETE') THEN
    DELETE FROM public.accounting_entries WHERE source_type='sale' AND source_id=OLD.id;
    DELETE FROM public.cash_movements     WHERE source_type='sale' AND source_id=OLD.id;
    RETURN OLD;
  END IF;

  -- Bersihkan entri lama untuk transaksi ini (idempotent repost)
  DELETE FROM public.accounting_entries WHERE source_type='sale' AND source_id=NEW.id;
  DELETE FROM public.cash_movements     WHERE source_type='sale' AND source_id=NEW.id;

  -- Transaksi dibatalkan tidak masuk pembukuan
  IF (COALESCE(NEW.order_status,'') = 'dibatalkan') THEN RETURN NEW; END IF;

  v_total := round(COALESCE(NEW.total,0));
  v_paid  := round(COALESCE(NEW.paid,0));
  v_rem   := greatest(0, v_total - v_paid);
  v_cash  := public.acc_cash_code(NEW.payment_method);
  v_date  := COALESCE(NEW.created_at::date, now()::date);

  IF v_total <= 0 THEN RETURN NEW; END IF;

  -- Kredit Pendapatan (nilai penuh penjualan)
  INSERT INTO public.accounting_entries(entry_date,source_type,source_id,invoice_no,account_code,debit,credit,description)
  VALUES (v_date,'sale',NEW.id,NEW.invoice_no,'4000',0,v_total,'Penjualan '||COALESCE(NEW.invoice_no,''));

  -- Debit Kas/Bank sebesar yang sudah dibayar (cash/transfer/qris + DP + cicilan)
  IF v_paid > 0 THEN
    INSERT INTO public.accounting_entries(entry_date,source_type,source_id,invoice_no,account_code,debit,credit,description)
    VALUES (v_date,'sale',NEW.id,NEW.invoice_no,v_cash,v_paid,0,'Penerimaan penjualan');
    INSERT INTO public.cash_movements(moved_at,direction,method,amount,source_type,source_id,invoice_no,note)
    VALUES (COALESCE(NEW.created_at,now()),'in',COALESCE(NEW.payment_method,'cash'),v_paid,'sale',NEW.id,NEW.invoice_no,'Penjualan');
  END IF;

  -- Debit Piutang Usaha sebesar sisa
  IF v_rem > 0 THEN
    INSERT INTO public.accounting_entries(entry_date,source_type,source_id,invoice_no,account_code,debit,credit,description)
    VALUES (v_date,'sale',NEW.id,NEW.invoice_no,'1200',v_rem,0,'Piutang penjualan');
  END IF;

  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS acc_trg_transaction ON public.transactions;
CREATE TRIGGER acc_trg_transaction
AFTER INSERT OR UPDATE OF total, paid, remaining, payment_method, order_status OR DELETE
ON public.transactions
FOR EACH ROW EXECUTE FUNCTION public.acc_fn_post_transaction();

-- ═══════════════ TRIGGER: EXPENSES (pengeluaran operasional) ═══════════════
CREATE OR REPLACE FUNCTION public.acc_fn_post_expense()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_amt numeric; v_cash text;
BEGIN
  IF (TG_OP='DELETE') THEN
    DELETE FROM public.accounting_entries WHERE source_type='expense' AND source_id=OLD.id;
    DELETE FROM public.cash_movements     WHERE source_type='expense' AND source_id=OLD.id;
    RETURN OLD;
  END IF;
  DELETE FROM public.accounting_entries WHERE source_type='expense' AND source_id=NEW.id;
  DELETE FROM public.cash_movements     WHERE source_type='expense' AND source_id=NEW.id;
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
END; $$;

DROP TRIGGER IF EXISTS acc_trg_expense ON public.expenses;
CREATE TRIGGER acc_trg_expense
AFTER INSERT OR UPDATE OR DELETE ON public.expenses
FOR EACH ROW EXECUTE FUNCTION public.acc_fn_post_expense();

-- ═══════════════ TRIGGER: PURCHASES (pembelian bahan/stok) ═══════════════
CREATE OR REPLACE FUNCTION public.acc_fn_post_purchase()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_amt numeric; v_cash text;
BEGIN
  IF (TG_OP='DELETE') THEN
    DELETE FROM public.accounting_entries WHERE source_type='purchase' AND source_id=OLD.id;
    DELETE FROM public.cash_movements     WHERE source_type='purchase' AND source_id=OLD.id;
    RETURN OLD;
  END IF;
  DELETE FROM public.accounting_entries WHERE source_type='purchase' AND source_id=NEW.id;
  DELETE FROM public.cash_movements     WHERE source_type='purchase' AND source_id=NEW.id;
  v_amt := round(COALESCE(NEW.amount,0));
  v_cash := public.acc_cash_code(NEW.method);
  IF v_amt <= 0 THEN RETURN NEW; END IF;
  -- Debit Persediaan (aset bertambah)
  INSERT INTO public.accounting_entries(entry_date,source_type,source_id,account_code,debit,credit,description)
  VALUES (NEW.purchase_date,'purchase',NEW.id,'1300',v_amt,0,'Pembelian '||COALESCE(NEW.item,''));
  IF COALESCE(NEW.is_credit,false) THEN
    -- Kredit Hutang Usaha
    INSERT INTO public.accounting_entries(entry_date,source_type,source_id,account_code,debit,credit,description)
    VALUES (NEW.purchase_date,'purchase',NEW.id,'2000',0,v_amt,'Pembelian kredit '||COALESCE(NEW.supplier,''));
  ELSE
    -- Kredit Kas/Bank + uang keluar
    INSERT INTO public.accounting_entries(entry_date,source_type,source_id,account_code,debit,credit,description)
    VALUES (NEW.purchase_date,'purchase',NEW.id,v_cash,0,v_amt,'Pembayaran pembelian');
    INSERT INTO public.cash_movements(moved_at,direction,method,amount,source_type,source_id,note)
    VALUES (NEW.purchase_date,'out',COALESCE(NEW.method,'cash'),v_amt,'purchase',NEW.id,COALESCE(NEW.item,'Pembelian'));
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS acc_trg_purchase ON public.purchases;
CREATE TRIGGER acc_trg_purchase
AFTER INSERT OR UPDATE OR DELETE ON public.purchases
FOR EACH ROW EXECUTE FUNCTION public.acc_fn_post_purchase();

-- ═══════════════ RPC: ringkasan agregat (untuk dashboard accounting) ═══════════════
-- Saldo (kas/bank/piutang/persediaan/hutang) = sampai p_to.
-- P&L & arus kas = dalam rentang p_from..p_to.
CREATE OR REPLACE FUNCTION public.acc_summary(p_from date, p_to date)
RETURNS json LANGUAGE sql STABLE AS $$
  SELECT json_build_object(
    'revenue',    COALESCE((SELECT sum(credit-debit) FROM public.accounting_entries WHERE account_code='4000' AND entry_date BETWEEN p_from AND p_to),0),
    'hpp',        COALESCE((SELECT sum(debit-credit) FROM public.accounting_entries WHERE account_code='5000' AND entry_date BETWEEN p_from AND p_to),0),
    'expense',    COALESCE((SELECT sum(debit-credit) FROM public.accounting_entries WHERE account_code='6000' AND entry_date BETWEEN p_from AND p_to),0),
    'cash_in',    COALESCE((SELECT sum(amount) FROM public.cash_movements WHERE direction='in'  AND moved_at::date BETWEEN p_from AND p_to),0),
    'cash_out',   COALESCE((SELECT sum(amount) FROM public.cash_movements WHERE direction='out' AND moved_at::date BETWEEN p_from AND p_to),0),
    'kas',        COALESCE((SELECT sum(debit-credit) FROM public.accounting_entries WHERE account_code='1000' AND entry_date <= p_to),0),
    'bank',       COALESCE((SELECT sum(debit-credit) FROM public.accounting_entries WHERE account_code='1100' AND entry_date <= p_to),0),
    'piutang',    COALESCE((SELECT sum(debit-credit) FROM public.accounting_entries WHERE account_code='1200' AND entry_date <= p_to),0),
    'persediaan', COALESCE((SELECT sum(debit-credit) FROM public.accounting_entries WHERE account_code='1300' AND entry_date <= p_to),0),
    'hutang',     COALESCE((SELECT sum(credit-debit) FROM public.accounting_entries WHERE account_code='2000' AND entry_date <= p_to),0)
  );
$$;

-- ---------- RLS (samakan dgn pola app: anon all) ----------
ALTER TABLE public.accounts           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cash_movements     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.expenses           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchases          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assets             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.liabilities        ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN CREATE POLICY "anon all accounts"           ON public.accounts           FOR ALL USING (true) WITH CHECK (true); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY "anon all accounting_entries" ON public.accounting_entries FOR ALL USING (true) WITH CHECK (true); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY "anon all cash_movements"     ON public.cash_movements     FOR ALL USING (true) WITH CHECK (true); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY "anon all expenses"           ON public.expenses           FOR ALL USING (true) WITH CHECK (true); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY "anon all purchases"          ON public.purchases          FOR ALL USING (true) WITH CHECK (true); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY "anon all assets"             ON public.assets             FOR ALL USING (true) WITH CHECK (true); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY "anon all liabilities"        ON public.liabilities        FOR ALL USING (true) WITH CHECK (true); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------- Backfill jurnal dari transaksi yang sudah ada ----------
-- Sentuh ulang kolom `total` agar trigger (UPDATE OF total) membuat entri.
-- Idempotent: trigger menghapus entri lama lalu repost.
UPDATE public.transactions SET total = total WHERE TRUE;

NOTIFY pgrst, 'reload schema';


-- ==============================================================
-- [02/24] 2026_06_accounting_suppliers.sql
-- ==============================================================
-- ═══════════════════════════════════════════════════════════════════
-- ACCOUNTING — Suppliers, Hutang Supplier, Rekap per Admin, Cashier trace
-- Delta untuk 2026_06_accounting_module.sql (jalankan SETELAHnya).
-- Idempotent. Supabase → SQL Editor → Run.
-- ═══════════════════════════════════════════════════════════════════

-- ---------- Kolom traceability (cashier_id / created_by) ----------
ALTER TABLE public.accounting_entries ADD COLUMN IF NOT EXISTS cashier_id uuid;
ALTER TABLE public.cash_movements     ADD COLUMN IF NOT EXISTS cashier_id uuid;
CREATE INDEX IF NOT EXISTS idx_acc_entries_cashier ON public.accounting_entries (cashier_id);

-- ---------- SUPPLIERS ----------
CREATE TABLE IF NOT EXISTS public.suppliers (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  phone      text DEFAULT '',
  note       text DEFAULT '',
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.supplier_debts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id uuid REFERENCES public.suppliers(id) ON DELETE SET NULL,
  supplier    text DEFAULT '',
  item        text DEFAULT '',
  total       numeric NOT NULL DEFAULT 0,
  paid        numeric NOT NULL DEFAULT 0,
  remaining   numeric NOT NULL DEFAULT 0,
  due_date    date,
  status      text DEFAULT 'aktif',          -- aktif | lunas
  note        text DEFAULT '',
  created_at  timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_supplier_debts_supplier ON public.supplier_debts (supplier_id);
CREATE INDEX IF NOT EXISTS idx_supplier_debts_status   ON public.supplier_debts (status);

CREATE TABLE IF NOT EXISTS public.supplier_debt_payments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_debt_id uuid REFERENCES public.supplier_debts(id) ON DELETE CASCADE,
  amount           numeric NOT NULL DEFAULT 0,
  method           text DEFAULT 'cash',
  paid_at          timestamptz DEFAULT now(),
  note             text DEFAULT '',
  cashier_id       uuid,
  created_at       timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_supplier_debt_pay_debt ON public.supplier_debt_payments (supplier_debt_id);

-- ---------- TRIGGER: supplier_debts (akui hutang ke supplier) ----------
-- Dr Persediaan (1300) / Cr Hutang Usaha (2000). Repost on insert/update.
CREATE OR REPLACE FUNCTION public.acc_fn_post_supplier_debt()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_total numeric;
BEGIN
  IF (TG_OP='DELETE') THEN
    DELETE FROM public.accounting_entries WHERE source_type='supplier_debt' AND source_id=OLD.id;
    RETURN OLD;
  END IF;
  -- jaga remaining konsisten
  NEW.remaining := greatest(0, round(coalesce(NEW.total,0)) - round(coalesce(NEW.paid,0)));
  NEW.status := CASE WHEN NEW.remaining <= 0 THEN 'lunas' ELSE 'aktif' END;
  DELETE FROM public.accounting_entries WHERE source_type='supplier_debt' AND source_id=NEW.id;
  v_total := round(coalesce(NEW.total,0));
  IF v_total > 0 THEN
    INSERT INTO public.accounting_entries(entry_date,source_type,source_id,account_code,debit,credit,description)
    VALUES (coalesce(NEW.created_at::date, now()::date),'supplier_debt',NEW.id,'1300',v_total,0,'Pembelian kredit '||coalesce(NEW.supplier,''));
    INSERT INTO public.accounting_entries(entry_date,source_type,source_id,account_code,debit,credit,description)
    VALUES (coalesce(NEW.created_at::date, now()::date),'supplier_debt',NEW.id,'2000',0,v_total,'Hutang ke '||coalesce(NEW.supplier,''));
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS acc_trg_supplier_debt ON public.supplier_debts;
CREATE TRIGGER acc_trg_supplier_debt
BEFORE INSERT OR UPDATE OF total, paid OR DELETE ON public.supplier_debts
FOR EACH ROW EXECUTE FUNCTION public.acc_fn_post_supplier_debt();

-- ---------- TRIGGER: supplier_debt_payments (bayar hutang supplier) ----------
-- Dr Hutang Usaha (2000) / Cr Kas-Bank + uang keluar. Update saldo supplier_debt.
CREATE OR REPLACE FUNCTION public.acc_fn_post_supplier_payment()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_amt numeric; v_cash text; v_debt public.supplier_debts;
BEGIN
  IF (TG_OP='DELETE') THEN
    DELETE FROM public.accounting_entries WHERE source_type='supplier_payment' AND source_id=OLD.id;
    DELETE FROM public.cash_movements     WHERE source_type='supplier_payment' AND source_id=OLD.id;
    -- kurangi paid di supplier_debts
    UPDATE public.supplier_debts SET paid = greatest(0, round(paid) - round(OLD.amount))
      WHERE id = OLD.supplier_debt_id;
    RETURN OLD;
  END IF;

  DELETE FROM public.accounting_entries WHERE source_type='supplier_payment' AND source_id=NEW.id;
  DELETE FROM public.cash_movements     WHERE source_type='supplier_payment' AND source_id=NEW.id;
  v_amt := round(coalesce(NEW.amount,0));
  v_cash := public.acc_cash_code(NEW.method);
  IF v_amt > 0 THEN
    INSERT INTO public.accounting_entries(entry_date,source_type,source_id,account_code,debit,credit,description,cashier_id)
    VALUES (NEW.paid_at::date,'supplier_payment',NEW.id,'2000',v_amt,0,'Bayar hutang supplier',NEW.cashier_id);
    INSERT INTO public.accounting_entries(entry_date,source_type,source_id,account_code,debit,credit,description,cashier_id)
    VALUES (NEW.paid_at::date,'supplier_payment',NEW.id,v_cash,0,v_amt,'Kas/Bank keluar (hutang supplier)',NEW.cashier_id);
    INSERT INTO public.cash_movements(moved_at,direction,method,amount,source_type,source_id,note,cashier_id)
    VALUES (NEW.paid_at,'out',coalesce(NEW.method,'cash'),v_amt,'supplier_payment',NEW.id,'Bayar hutang supplier',NEW.cashier_id);
    -- tambah paid di supplier_debts (trigger supplier_debt akan hitung remaining/status)
    UPDATE public.supplier_debts SET paid = round(coalesce(paid,0)) + v_amt WHERE id = NEW.supplier_debt_id;
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS acc_trg_supplier_payment ON public.supplier_debt_payments;
CREATE TRIGGER acc_trg_supplier_payment
AFTER INSERT OR DELETE ON public.supplier_debt_payments
FOR EACH ROW EXECUTE FUNCTION public.acc_fn_post_supplier_payment();

-- ---------- Isi cashier_id pada jurnal penjualan (rekap per admin) ----------
CREATE OR REPLACE FUNCTION public.acc_fn_post_transaction()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_total numeric; v_paid numeric; v_rem numeric; v_cash text; v_date date;
BEGIN
  IF (TG_OP = 'DELETE') THEN
    DELETE FROM public.accounting_entries WHERE source_type='sale' AND source_id=OLD.id;
    DELETE FROM public.cash_movements     WHERE source_type='sale' AND source_id=OLD.id;
    RETURN OLD;
  END IF;
  DELETE FROM public.accounting_entries WHERE source_type='sale' AND source_id=NEW.id;
  DELETE FROM public.cash_movements     WHERE source_type='sale' AND source_id=NEW.id;
  IF (COALESCE(NEW.order_status,'') = 'dibatalkan') THEN RETURN NEW; END IF;
  v_total := round(COALESCE(NEW.total,0));
  v_paid  := round(COALESCE(NEW.paid,0));
  v_rem   := greatest(0, v_total - v_paid);
  v_cash  := public.acc_cash_code(NEW.payment_method);
  v_date  := COALESCE(NEW.created_at::date, now()::date);
  IF v_total <= 0 THEN RETURN NEW; END IF;
  INSERT INTO public.accounting_entries(entry_date,source_type,source_id,invoice_no,account_code,debit,credit,description,cashier_id)
  VALUES (v_date,'sale',NEW.id,NEW.invoice_no,'4000',0,v_total,'Penjualan '||COALESCE(NEW.invoice_no,''),NEW.cashier_id);
  IF v_paid > 0 THEN
    INSERT INTO public.accounting_entries(entry_date,source_type,source_id,invoice_no,account_code,debit,credit,description,cashier_id)
    VALUES (v_date,'sale',NEW.id,NEW.invoice_no,v_cash,v_paid,0,'Penerimaan penjualan',NEW.cashier_id);
    INSERT INTO public.cash_movements(moved_at,direction,method,amount,source_type,source_id,invoice_no,note,cashier_id)
    VALUES (COALESCE(NEW.created_at,now()),'in',COALESCE(NEW.payment_method,'cash'),v_paid,'sale',NEW.id,NEW.invoice_no,'Penjualan',NEW.cashier_id);
  END IF;
  IF v_rem > 0 THEN
    INSERT INTO public.accounting_entries(entry_date,source_type,source_id,invoice_no,account_code,debit,credit,description,cashier_id)
    VALUES (v_date,'sale',NEW.id,NEW.invoice_no,'1200',v_rem,0,'Piutang penjualan',NEW.cashier_id);
  END IF;
  RETURN NEW;
END; $$;

-- ---------- RPC: rekap per admin (omzet & penerimaan) ----------
CREATE OR REPLACE FUNCTION public.acc_recap_admin(p_from date, p_to date)
RETURNS TABLE (cashier_id uuid, revenue numeric, cash_in numeric) LANGUAGE sql STABLE AS $$
  SELECT e.cashier_id,
         COALESCE(sum(CASE WHEN e.account_code='4000' THEN e.credit - e.debit ELSE 0 END),0) AS revenue,
         COALESCE(sum(CASE WHEN e.account_code IN ('1000','1100') THEN e.debit - e.credit ELSE 0 END),0) AS cash_in
  FROM public.accounting_entries e
  WHERE e.source_type='sale' AND e.entry_date BETWEEN p_from AND p_to
  GROUP BY e.cashier_id;
$$;

-- ---------- RLS ----------
ALTER TABLE public.suppliers              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.supplier_debts         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.supplier_debt_payments ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN CREATE POLICY "anon all suppliers"              ON public.suppliers              FOR ALL USING (true) WITH CHECK (true); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY "anon all supplier_debts"         ON public.supplier_debts         FOR ALL USING (true) WITH CHECK (true); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY "anon all supplier_debt_payments" ON public.supplier_debt_payments FOR ALL USING (true) WITH CHECK (true); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Backfill cashier_id pada jurnal penjualan lama
UPDATE public.transactions SET total = total WHERE TRUE;

NOTIFY pgrst, 'reload schema';


-- ==============================================================
-- [03/24] 2026_06_accounting_rls_fix.sql
-- ==============================================================
-- ═══════════════════════════════════════════════════════════════════
-- FIX: "permission denied for table accounting_entries" saat checkout
-- ═══════════════════════════════════════════════════════════════════
-- Penyebab: trigger auto-jurnal berjalan dengan hak user pemanggil (anon),
-- yang TIDAK punya privilege INSERT ke accounting_entries → seluruh INSERT
-- transaksi POS ikut rollback → checkout gagal.
--
-- Solusi:
--   (A) Trigger function dibuat SECURITY DEFINER → berjalan sebagai pemilik
--       fungsi (postgres), jadi bisa menulis jurnal tanpa peduli role kasir.
--   (B) Setiap fungsi dibungkus EXCEPTION handler → kalau ada error apa pun
--       di akuntansi, hanya RAISE WARNING dan transaksi POS TETAP berhasil
--       (akuntansi best-effort, checkout tidak pernah gagal karenanya).
--   (C) GRANT privilege tabel akuntansi ke anon/authenticated untuk halaman
--       Accounting (baca laporan + input expense/purchase/supplier).
--
-- Catatan akses peran: aplikasi memakai SATU anon key (tanpa Supabase Auth
-- per-user), jadi DB tidak bisa membedakan owner/staff/kasir. Pembatasan
-- peran (kasir tidak boleh buka menu Accounting) DITERAPKAN DI APLIKASI
-- (sidebar + gating route). Auto-posting jurnal dari checkout tetap jalan
-- untuk semua peran lewat SECURITY DEFINER.
--
-- Idempotent. Jalankan SETELAH 2026_06_accounting_module.sql &
-- 2026_06_accounting_suppliers.sql. Supabase → SQL Editor → Run.
-- ═══════════════════════════════════════════════════════════════════

-- ───────────────── (A)+(B) Recreate trigger functions ─────────────────

CREATE OR REPLACE FUNCTION public.acc_fn_post_transaction()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_total numeric; v_paid numeric; v_rem numeric; v_cash text; v_date date;
BEGIN
  IF (TG_OP = 'DELETE') THEN
    DELETE FROM public.accounting_entries WHERE source_type='sale' AND source_id=OLD.id;
    DELETE FROM public.cash_movements     WHERE source_type='sale' AND source_id=OLD.id;
    RETURN OLD;
  END IF;
  DELETE FROM public.accounting_entries WHERE source_type='sale' AND source_id=NEW.id;
  DELETE FROM public.cash_movements     WHERE source_type='sale' AND source_id=NEW.id;
  IF (COALESCE(NEW.order_status,'') = 'dibatalkan') THEN RETURN NEW; END IF;
  v_total := round(COALESCE(NEW.total,0));
  v_paid  := round(COALESCE(NEW.paid,0));
  v_rem   := greatest(0, v_total - v_paid);
  v_cash  := public.acc_cash_code(NEW.payment_method);
  v_date  := COALESCE(NEW.created_at::date, now()::date);
  IF v_total <= 0 THEN RETURN NEW; END IF;
  INSERT INTO public.accounting_entries(entry_date,source_type,source_id,invoice_no,account_code,debit,credit,description,cashier_id)
  VALUES (v_date,'sale',NEW.id,NEW.invoice_no,'4000',0,v_total,'Penjualan '||COALESCE(NEW.invoice_no,''),NEW.cashier_id);
  IF v_paid > 0 THEN
    INSERT INTO public.accounting_entries(entry_date,source_type,source_id,invoice_no,account_code,debit,credit,description,cashier_id)
    VALUES (v_date,'sale',NEW.id,NEW.invoice_no,v_cash,v_paid,0,'Penerimaan penjualan',NEW.cashier_id);
    INSERT INTO public.cash_movements(moved_at,direction,method,amount,source_type,source_id,invoice_no,note,cashier_id)
    VALUES (COALESCE(NEW.created_at,now()),'in',COALESCE(NEW.payment_method,'cash'),v_paid,'sale',NEW.id,NEW.invoice_no,'Penjualan',NEW.cashier_id);
  END IF;
  IF v_rem > 0 THEN
    INSERT INTO public.accounting_entries(entry_date,source_type,source_id,invoice_no,account_code,debit,credit,description,cashier_id)
    VALUES (v_date,'sale',NEW.id,NEW.invoice_no,'1200',v_rem,0,'Piutang penjualan',NEW.cashier_id);
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'acc_fn_post_transaction dilewati: %', SQLERRM;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END; $$;

CREATE OR REPLACE FUNCTION public.acc_fn_post_expense()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_amt numeric; v_cash text;
BEGIN
  IF (TG_OP='DELETE') THEN
    DELETE FROM public.accounting_entries WHERE source_type='expense' AND source_id=OLD.id;
    DELETE FROM public.cash_movements     WHERE source_type='expense' AND source_id=OLD.id;
    RETURN OLD;
  END IF;
  DELETE FROM public.accounting_entries WHERE source_type='expense' AND source_id=NEW.id;
  DELETE FROM public.cash_movements     WHERE source_type='expense' AND source_id=NEW.id;
  v_amt := round(COALESCE(NEW.amount,0));
  v_cash := public.acc_cash_code(NEW.method);
  IF v_amt <= 0 THEN RETURN NEW; END IF;
  INSERT INTO public.accounting_entries(entry_date,source_type,source_id,account_code,debit,credit,description,cashier_id)
  VALUES (NEW.expense_date,'expense',NEW.id,'6000',v_amt,0,COALESCE(NEW.category,'Beban')||' '||COALESCE(NEW.note,''),NEW.cashier_id);
  INSERT INTO public.accounting_entries(entry_date,source_type,source_id,account_code,debit,credit,description,cashier_id)
  VALUES (NEW.expense_date,'expense',NEW.id,v_cash,0,v_amt,'Pembayaran beban',NEW.cashier_id);
  INSERT INTO public.cash_movements(moved_at,direction,method,amount,source_type,source_id,note,cashier_id)
  VALUES (NEW.expense_date,'out',COALESCE(NEW.method,'cash'),v_amt,'expense',NEW.id,COALESCE(NEW.category,'Beban'),NEW.cashier_id);
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'acc_fn_post_expense dilewati: %', SQLERRM;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END; $$;

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
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END; $$;

-- Supplier debt & supplier payment:
-- DEFINISI FUNGSI LAMA DIHAPUS DARI FILE INI (sebelumnya logika increment
-- `paid = paid + amount` tanpa cek deleted_at). Kalau file ini dijalankan
-- ulang SETELAH 2026_06_accounting_history_softdelete.sql, fungsi lama
-- menimpa versi baru sementara trigger tetap menyala di UPDATE → edit /
-- soft-delete pembayaran membuat `paid` dobel dan jurnal ganda.
-- Versi final fungsi + trigger ada di 2026_06_supplier_debt_fixes.sql —
-- jalankan file itu PALING AKHIR.

-- ───────────────── (C) GRANT privilege tabel + RPC ─────────────────
GRANT USAGE ON SCHEMA public TO anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  public.accounts,
  public.accounting_entries,
  public.cash_movements,
  public.expenses,
  public.purchases,
  public.assets,
  public.liabilities,
  public.suppliers,
  public.supplier_debts,
  public.supplier_debt_payments
TO anon, authenticated;

GRANT EXECUTE ON FUNCTION public.acc_summary(date, date)      TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.acc_recap_admin(date, date)  TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.acc_cash_code(text)          TO anon, authenticated;

-- Pastikan RLS aktif + policy "anon all" ada (sefamili dgn tabel POS lain)
ALTER TABLE public.accounting_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cash_movements     ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN CREATE POLICY "anon all accounting_entries" ON public.accounting_entries FOR ALL USING (true) WITH CHECK (true); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY "anon all cash_movements"     ON public.cash_movements     FOR ALL USING (true) WITH CHECK (true); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

NOTIFY pgrst, 'reload schema';


-- ==============================================================
-- [04/24] 2026_06_accounting_dashboard_rpc.sql
-- ==============================================================
-- ═══════════════════════════════════════════════════════════════════
-- RPC acc_dashboard — ringkasan keuangan SEDERHANA untuk owner.
-- Tanpa istilah debit/kredit/akun. Sumber: tabel POS langsung (transactions,
-- debt_payments, debts) + expenses/purchases/supplier_debts → konsisten dgn POS
-- & otomatis terupdate saat invoice dihapus (tidak ada data hantu).
--
-- Idempotent. Supabase → SQL Editor → Run (setelah migrasi accounting lain).
-- ═══════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.acc_dashboard(p_from date, p_to date)
RETURNS json LANGUAGE sql STABLE AS $$
  WITH txp AS (
    SELECT * FROM public.transactions
    WHERE COALESCE(order_status,'') <> 'dibatalkan'
      AND created_at::date BETWEEN p_from AND p_to
  ),
  dpp AS (
    SELECT * FROM public.debt_payments
    WHERE paid_at::date BETWEEN p_from AND p_to
  )
  SELECT json_build_object(
    -- UANG MASUK
    'penjualan',        (SELECT COALESCE(sum(round(total)),0) FROM txp),
    'uang_masuk_total', (SELECT COALESCE(sum(round(paid)),0)  FROM txp)
                        + (SELECT COALESCE(sum(round(amount)),0) FROM dpp),
    'cash',     (SELECT COALESCE(sum(round(paid)),0) FROM txp WHERE payment_method='cash')
                + (SELECT COALESCE(sum(round(amount)),0) FROM dpp WHERE payment_method='cash'),
    'transfer', (SELECT COALESCE(sum(round(paid)),0) FROM txp WHERE payment_method='transfer')
                + (SELECT COALESCE(sum(round(amount)),0) FROM dpp WHERE payment_method='transfer'),
    'qris',     (SELECT COALESCE(sum(round(paid)),0) FROM txp WHERE payment_method='qris')
                + (SELECT COALESCE(sum(round(amount)),0) FROM dpp WHERE payment_method='qris'),
    'cicilan',  (SELECT COALESCE(sum(round(amount)),0) FROM dpp),

    -- UANG KELUAR
    'pengeluaran_total', (SELECT COALESCE(sum(round(amount)),0) FROM public.expenses WHERE expense_date BETWEEN p_from AND p_to)
                         + (SELECT COALESCE(sum(round(amount)),0) FROM public.purchases WHERE COALESCE(is_credit,false)=false AND purchase_date BETWEEN p_from AND p_to),
    'pembelian_bahan',   (SELECT COALESCE(sum(round(amount)),0) FROM public.purchases WHERE purchase_date BETWEEN p_from AND p_to)
                         + (SELECT COALESCE(sum(round(amount)),0) FROM public.expenses WHERE category='Pembelian Bahan' AND expense_date BETWEEN p_from AND p_to),
    'gaji',        (SELECT COALESCE(sum(round(amount)),0) FROM public.expenses WHERE category IN ('Gaji','Gaji Karyawan') AND expense_date BETWEEN p_from AND p_to),
    'operasional', (SELECT COALESCE(sum(round(amount)),0) FROM public.expenses WHERE category NOT IN ('Gaji','Gaji Karyawan','Pembelian Bahan') AND expense_date BETWEEN p_from AND p_to),

    -- PIUTANG & HUTANG (saldo s/d tanggal)
    'piutang_aktif',   (SELECT COALESCE(sum(greatest(0, round(total_debt)-round(paid))),0) FROM public.debts WHERE status='aktif'),
    'hutang_supplier', (SELECT COALESCE(sum(greatest(0, round(total)-round(paid))),0) FROM public.supplier_debts WHERE status='aktif'),

    -- SALDO KAS & REKENING (kumulatif s/d p_to)
    'saldo_kas',      (SELECT COALESCE(sum(CASE WHEN direction='in' THEN amount ELSE -amount END),0) FROM public.cash_movements WHERE method='cash' AND moved_at::date <= p_to),
    'saldo_rekening', (SELECT COALESCE(sum(CASE WHEN direction='in' THEN amount ELSE -amount END),0) FROM public.cash_movements WHERE method IN ('transfer','qris') AND moved_at::date <= p_to),

    -- Untuk laba: modal barang (perkiraan dari pembelian bahan periode)
    'modal_barang', (SELECT COALESCE(sum(round(amount)),0) FROM public.purchases WHERE purchase_date BETWEEN p_from AND p_to)
                    + (SELECT COALESCE(sum(round(amount)),0) FROM public.expenses WHERE category='Pembelian Bahan' AND expense_date BETWEEN p_from AND p_to)
  );
$$;

GRANT EXECUTE ON FUNCTION public.acc_dashboard(date, date) TO anon, authenticated;
NOTIFY pgrst, 'reload schema';


-- ==============================================================
-- [05/24] 2026_06_accounting_sync_fix.sql
-- ==============================================================
-- ═══════════════════════════════════════════════════════════════════
-- SINKRONISASI Piutang ⇄ Accounting (single source of truth)
-- ═══════════════════════════════════════════════════════════════════
-- Memastikan angka di Accounting IDENTIK dengan menu Piutang & Dashboard:
--   • Piutang Usaha (acc)   == Total Piutang Aktif (Piutang)  → Σ sisa semua debts
--   • Sudah Bayar           == Σ debts.paid (DP + semua cicilan)
--   • Arus Kas Bersih       == uang yang BENAR-BENAR diterima (DP + cicilan +
--                              penjualan tunai), TANPA double-count cicilan.
--
-- Kunci anti double-count: untuk tiap transaksi, "penerimaan awal" (DP/lunas) =
--   paid − Σ(cicilan invoice itu). Cicilan dihitung terpisah dari debt_payments.
--   → DP hutang diperlakukan sebagai Cash (POS tidak menyimpan metode DP).
--
-- Idempotent. Supabase → SQL Editor → Run (setelah migrasi accounting lain).
-- ═══════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.acc_dashboard(p_from date, p_to date)
RETURNS json LANGUAGE sql STABLE AS $$
  WITH cic_all AS (
    SELECT invoice_no, sum(round(amount)) AS cic
    FROM public.debt_payments WHERE invoice_no IS NOT NULL GROUP BY invoice_no
  ),
  -- transaksi valid dalam periode + penerimaan awal (paid − cicilan)
  txp AS (
    SELECT t.payment_method, round(t.total) AS total,
           GREATEST(0, round(t.paid) - COALESCE(ca.cic,0)) AS init_paid
    FROM public.transactions t
    LEFT JOIN cic_all ca ON ca.invoice_no = t.invoice_no
    WHERE COALESCE(t.order_status,'') <> 'dibatalkan'
      AND t.created_at::date BETWEEN p_from AND p_to
  ),
  -- transaksi valid s/d p_to (untuk saldo kumulatif)
  txall AS (
    SELECT t.payment_method,
           GREATEST(0, round(t.paid) - COALESCE(ca.cic,0)) AS init_paid
    FROM public.transactions t
    LEFT JOIN cic_all ca ON ca.invoice_no = t.invoice_no
    WHERE COALESCE(t.order_status,'') <> 'dibatalkan'
      AND t.created_at::date <= p_to
  ),
  dpp  AS (SELECT * FROM public.debt_payments WHERE paid_at::date BETWEEN p_from AND p_to),
  dpall AS (SELECT * FROM public.debt_payments WHERE paid_at::date <= p_to)
  SELECT json_build_object(
    'penjualan',        (SELECT COALESCE(sum(total),0) FROM txp),
    -- Arus kas / uang masuk = penerimaan awal (DP hutang dianggap cash) + cicilan
    'uang_masuk_total', (SELECT COALESCE(sum(init_paid),0) FROM txp) + (SELECT COALESCE(sum(round(amount)),0) FROM dpp),
    'cash',     (SELECT COALESCE(sum(init_paid),0) FROM txp WHERE payment_method IN ('cash','hutang'))
                + (SELECT COALESCE(sum(round(amount)),0) FROM dpp WHERE payment_method='cash'),
    'transfer', (SELECT COALESCE(sum(init_paid),0) FROM txp WHERE payment_method='transfer')
                + (SELECT COALESCE(sum(round(amount)),0) FROM dpp WHERE payment_method='transfer'),
    'qris',     (SELECT COALESCE(sum(init_paid),0) FROM txp WHERE payment_method='qris')
                + (SELECT COALESCE(sum(round(amount)),0) FROM dpp WHERE payment_method='qris'),
    'cicilan',  (SELECT COALESCE(sum(round(amount)),0) FROM dpp),
    -- Penerimaan piutang (DP hutang + cicilan) = "Sudah Bayar" periode
    'penerimaan_piutang', (SELECT COALESCE(sum(init_paid),0) FROM txp WHERE payment_method='hutang')
                          + (SELECT COALESCE(sum(round(amount)),0) FROM dpp),

    -- UANG KELUAR
    'pengeluaran_total', (SELECT COALESCE(sum(round(amount)),0) FROM public.expenses WHERE expense_date BETWEEN p_from AND p_to)
                         + (SELECT COALESCE(sum(round(amount)),0) FROM public.purchases WHERE COALESCE(is_credit,false)=false AND purchase_date BETWEEN p_from AND p_to),
    'pembelian_bahan',   (SELECT COALESCE(sum(round(amount)),0) FROM public.purchases WHERE purchase_date BETWEEN p_from AND p_to)
                         + (SELECT COALESCE(sum(round(amount)),0) FROM public.expenses WHERE category='Pembelian Bahan' AND expense_date BETWEEN p_from AND p_to),
    'gaji',        (SELECT COALESCE(sum(round(amount)),0) FROM public.expenses WHERE category IN ('Gaji','Gaji Karyawan') AND expense_date BETWEEN p_from AND p_to),
    'operasional', (SELECT COALESCE(sum(round(amount)),0) FROM public.expenses WHERE category NOT IN ('Gaji','Gaji Karyawan','Pembelian Bahan') AND expense_date BETWEEN p_from AND p_to),

    -- PIUTANG (identik dgn menu Piutang: Σ sisa semua debts, tanpa filter status)
    'piutang_aktif', (SELECT COALESCE(sum(greatest(0, round(total_debt)-round(paid))),0) FROM public.debts),
    'sudah_bayar',   (SELECT COALESCE(sum(round(paid)),0) FROM public.debts),
    'hutang_supplier', (SELECT COALESCE(sum(greatest(0, round(total)-round(paid))),0) FROM public.supplier_debts WHERE status='aktif'),

    -- SALDO KAS & REKENING (kumulatif s/d p_to, dari model yang sama)
    'saldo_kas', (
      (SELECT COALESCE(sum(init_paid),0) FROM txall WHERE payment_method IN ('cash','hutang'))
      + (SELECT COALESCE(sum(round(amount)),0) FROM dpall WHERE payment_method='cash')
      - (SELECT COALESCE(sum(round(amount)),0) FROM public.expenses WHERE method='cash' AND expense_date <= p_to)
      - (SELECT COALESCE(sum(round(amount)),0) FROM public.purchases WHERE method='cash' AND COALESCE(is_credit,false)=false AND purchase_date <= p_to)
    ),
    'saldo_rekening', (
      (SELECT COALESCE(sum(init_paid),0) FROM txall WHERE payment_method IN ('transfer','qris'))
      + (SELECT COALESCE(sum(round(amount)),0) FROM dpall WHERE payment_method IN ('transfer','qris'))
      - (SELECT COALESCE(sum(round(amount)),0) FROM public.expenses WHERE method='transfer' AND expense_date <= p_to)
      - (SELECT COALESCE(sum(round(amount)),0) FROM public.purchases WHERE method='transfer' AND COALESCE(is_credit,false)=false AND purchase_date <= p_to)
    ),

    'modal_barang', (SELECT COALESCE(sum(round(amount)),0) FROM public.purchases WHERE purchase_date BETWEEN p_from AND p_to)
                    + (SELECT COALESCE(sum(round(amount)),0) FROM public.expenses WHERE category='Pembelian Bahan' AND expense_date BETWEEN p_from AND p_to)
  );
$$;
GRANT EXECUTE ON FUNCTION public.acc_dashboard(date, date) TO anon, authenticated;

-- ───────────────── Tombol "Sinkronkan Accounting" ─────────────────
-- Repost ulang seluruh jurnal otomatis (untuk audit) dengan menyentuh kembali
-- baris sumber. Dashboard sendiri sudah live (derive dari tabel POS), ini
-- merapikan accounting_entries/cash_movements bila ada drift lama.
CREATE OR REPLACE FUNCTION public.acc_resync()
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.transactions SET total = total WHERE TRUE;
  BEGIN UPDATE public.expenses  SET amount = amount WHERE TRUE; EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN UPDATE public.purchases SET amount = amount WHERE TRUE; EXCEPTION WHEN OTHERS THEN NULL; END;
  -- Rekalkulasi sisa hutang supplier
  BEGIN UPDATE public.supplier_debts SET total = total WHERE TRUE; EXCEPTION WHEN OTHERS THEN NULL; END;
  RETURN json_build_object('ok', true);
EXCEPTION WHEN OTHERS THEN
  RETURN json_build_object('ok', false, 'error', SQLERRM);
END; $$;
GRANT EXECUTE ON FUNCTION public.acc_resync() TO anon, authenticated;

NOTIFY pgrst, 'reload schema';


-- ==============================================================
-- [06/24] 2026_06_accounting_supplier_bank.sql
-- ==============================================================
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


-- ==============================================================
-- [07/24] 2026_06_accounting_history_softdelete.sql
-- ==============================================================
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


-- ==============================================================
-- [08/24] 2026_06_accounting_audit_softdelete.sql
-- ==============================================================
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


-- ==============================================================
-- [09/24] 2026_06_bank_recalc_and_expense_categories.sql
-- ==============================================================
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


-- ==============================================================
-- [10/24] 2026_06_assets.sql
-- ==============================================================
-- ═══════════════════════════════════════════════════════════════════
-- ASET TETAP + PENYUSUTAN (assets, asset_categories)
-- Nilai buku TIDAK disimpan statis — dihitung di frontend dari
-- purchase_price/date/method/rate/life/residual (selalu realtime tiap tahun).
-- Idempotent. Jalankan di Supabase → SQL Editor.
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.asset_categories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);

CREATE TABLE IF NOT EXISTS public.assets (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                text NOT NULL,
  category_id         uuid,
  category_name       text,
  purchase_date       date NOT NULL,
  purchase_price      numeric NOT NULL DEFAULT 0,
  residual_value      numeric DEFAULT 0,
  depreciation_method text DEFAULT 'percentage',   -- none | percentage | straight
  depreciation_rate   numeric DEFAULT 0,           -- % per tahun (untuk percentage)
  useful_life_years   integer,                     -- umur manfaat (untuk straight)
  photo_url           text,
  notes               text,
  status              text DEFAULT 'active',        -- active | depleted | sold | broken | deleted
  sold_date           date,
  sold_price          numeric,
  payment_method      text,
  created_by          uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz
);

CREATE INDEX IF NOT EXISTS idx_assets_deleted  ON public.assets (deleted_at);
CREATE INDEX IF NOT EXISTS idx_assets_status   ON public.assets (status);
CREATE INDEX IF NOT EXISTS idx_asset_cat_del   ON public.asset_categories (deleted_at);

ALTER TABLE public.assets            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.asset_categories  ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN CREATE POLICY "anon all assets"           ON public.assets           FOR ALL USING (true) WITH CHECK (true); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY "anon all asset_categories" ON public.asset_categories FOR ALL USING (true) WITH CHECK (true); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Seed kategori default (hanya jika kosong)
INSERT INTO public.asset_categories (name)
SELECT x FROM unnest(ARRAY[
  'Mesin Produksi', 'Komputer & Elektronik', 'Kendaraan', 'Peralatan Toko',
  'Furniture', 'Renovasi', 'Software', 'Lainnya'
]) AS x
WHERE NOT EXISTS (SELECT 1 FROM public.asset_categories);

GRANT ALL ON public.assets           TO anon, authenticated;
GRANT ALL ON public.asset_categories TO anon, authenticated;

NOTIFY pgrst, 'reload schema';


-- ==============================================================
-- [11/24] 2026_06_prepaid_rents.sql
-- ==============================================================
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


-- ==============================================================
-- [12/24] 2026_06_supplier_debt_fixes.sql
-- ==============================================================
-- ═══════════════════════════════════════════════════════════════════
-- SUPPLIER DEBT FIXES — konsolidasi trigger Hutang Supplier (VERSI FINAL)
-- Jalankan PALING AKHIR setelah semua migrasi accounting lain.
-- Idempotent — aman dijalankan berulang kali.
--
-- Memperbaiki:
--   1. Versi lama acc_fn_post_supplier_payment (logika increment
--      `paid = paid + amount`, tanpa cek deleted_at) yang dulu ada di
--      2026_06_accounting_rls_fix.sql bisa menimpa versi baru. Dengan
--      trigger AFTER INSERT OR UPDATE OR DELETE, edit / soft-delete
--      pembayaran malah MENAMBAH paid (dobel) dan mem-posting ulang
--      jurnal. File ini memasang ulang versi benar: paid dihitung
--      ulang dari SUM pembayaran non-deleted (idempotent).
--   2. deleteSupplierDebt di frontend tidak atomik (2 request).
--      → RPC acc_delete_supplier_debt: soft-delete hutang + seluruh
--      pembayarannya dalam SATU transaksi database.
-- ═══════════════════════════════════════════════════════════════════

-- Pastikan kolom yang dibutuhkan ada (no-op kalau sudah).
ALTER TABLE public.supplier_debt_payments ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE public.supplier_debt_payments ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();
ALTER TABLE public.supplier_debts ADD COLUMN IF NOT EXISTS deleted_at     timestamptz;
ALTER TABLE public.supplier_debts ADD COLUMN IF NOT EXISTS payment_method text DEFAULT 'transfer';
ALTER TABLE public.supplier_debts ADD COLUMN IF NOT EXISTS updated_at     timestamptz DEFAULT now();

-- ═══════ SUPPLIER DEBT (akrual: Dr Persediaan 1300 / Cr Hutang 2000) ═══════
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

-- ═══════ SUPPLIER PAYMENT (recompute paid dari SUM — idempotent) ═══════
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

-- ═══════ RPC: hapus hutang supplier secara ATOMIK (1 transaksi) ═══════
-- Soft-delete semua pembayaran + hutangnya sekaligus. Trigger payment
-- ikut membersihkan jurnal & cash movement per baris; trigger debt
-- membuang jurnal akrualnya. Kalau salah satu gagal → semua rollback.
CREATE OR REPLACE FUNCTION public.acc_delete_supplier_debt(p_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_now timestamptz := now();
BEGIN
  UPDATE public.supplier_debt_payments
    SET deleted_at = v_now
    WHERE supplier_debt_id = p_id AND deleted_at IS NULL;
  UPDATE public.supplier_debts
    SET deleted_at = v_now
    WHERE id = p_id AND deleted_at IS NULL;
END; $$;

GRANT EXECUTE ON FUNCTION public.acc_delete_supplier_debt(uuid) TO anon, authenticated;

-- Resync saldo paid semua hutang dari SUM pembayaran non-deleted
-- (membetulkan data yang sempat dobel akibat trigger versi lama).
UPDATE public.supplier_debts d
SET paid = COALESCE((
  SELECT sum(round(p.amount)) FROM public.supplier_debt_payments p
  WHERE p.supplier_debt_id = d.id AND p.deleted_at IS NULL
), 0);

NOTIFY pgrst, 'reload schema';


-- ==============================================================
-- [13/24] 2026_06_employee_cash_advances.sql
-- ==============================================================
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


-- ==============================================================
-- [14/24] 2026_06_employees_master.sql
-- ==============================================================
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


-- ==============================================================
-- [15/24] 2026_06_migration_details.sql
-- ==============================================================
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


-- ==============================================================
-- [16/24] 2026_06_migration_opening_balances.sql
-- ==============================================================
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


-- ==============================================================
-- [17/24] 2026_06_product_categories.sql
-- ==============================================================
-- ═══════════════════════════════════════════════════════════════════
-- KATEGORI PRODUK (product_categories) — single source of truth di DB.
-- Idempotent. Sebelumnya kategori hanya di localStorage (per-browser) →
-- hilang saat ganti device / clear cache / deploy ulang. Sekarang tersimpan
-- permanen di Supabase; localStorage hanya cache offline.
--
-- id = slug (mis. 'jersey') → SAMA dengan products.category, jadi produk lama
-- tetap termapping. Soft delete (deleted_at) → produk lama tetap menampilkan
-- nama kategori terakhir.
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.product_categories (
  id          text PRIMARY KEY,
  label       text NOT NULL,
  icon        text DEFAULT '📦',
  sort_order  int DEFAULT 0,
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now(),
  deleted_at  timestamptz
);
CREATE INDEX IF NOT EXISTS idx_prodcat_deleted ON public.product_categories (deleted_at);

ALTER TABLE public.product_categories ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "anon all product_categories" ON public.product_categories FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.product_categories TO anon, authenticated;

-- ---------- SEED kategori bawaan (hanya bila belum ada) ----------
INSERT INTO public.product_categories (id, label, icon, sort_order) VALUES
  ('jersey','Jersey','👕',1),
  ('kaos','Kaos','👚',2),
  ('banner','Banner','🚩',3),
  ('sticker','Sticker','✨',4),
  ('printing','Printing','🖨️',5),
  ('accessories','Accessories','🎒',6),
  ('other','Other','📦',7)
ON CONFLICT (id) DO NOTHING;

NOTIFY pgrst, 'reload schema';


-- ==============================================================
-- [18/24] 2026_06_admins_updated_at.sql
-- ==============================================================
-- ═══════════════════════════════════════════════════════════════════
-- ADMINS: kolom updated_at untuk fitur Edit Admin (username/nama/role/password)
-- Idempotent. Tabel admins sudah punya: id, username, password, name, role,
-- created_at. Hanya menambahkan updated_at.
-- ═══════════════════════════════════════════════════════════════════
ALTER TABLE public.admins ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

NOTIFY pgrst, 'reload schema';


-- ==============================================================
-- [19/24] 2026_06_product_categories_extend.sql
-- ==============================================================
-- ═══════════════════════════════════════════════════════════════════
-- KATEGORI PRODUK — perluasan: warna, thumbnail, status aktif/nonaktif.
-- Jalankan SETELAH 2026_06_product_categories.sql. Idempotent.
--
-- Skema dipertahankan: id = slug (text) yang SAMA dengan products.category
-- (snapshot), supaya produk lama tetap termapping & nama kategori terakhir
-- tetap tampil. Kolom baru bersifat opsional.
-- ═══════════════════════════════════════════════════════════════════
ALTER TABLE public.product_categories ADD COLUMN IF NOT EXISTS color         text;
ALTER TABLE public.product_categories ADD COLUMN IF NOT EXISTS thumbnail_url text;
ALTER TABLE public.product_categories ADD COLUMN IF NOT EXISTS is_active     boolean DEFAULT true;
CREATE INDEX IF NOT EXISTS idx_prodcat_active ON public.product_categories (is_active);

-- Pastikan kategori bawaan tetap ada (kalau tabel baru dibuat di migrasi ini).
INSERT INTO public.product_categories (id, label, icon, sort_order, is_active) VALUES
  ('jersey','Jersey','👕',1,true),
  ('kaos','Kaos','👚',2,true),
  ('banner','Banner','🚩',3,true),
  ('sticker','Sticker','✨',4,true),
  ('printing','Printing','🖨️',5,true),
  ('accessories','Accessories','🎒',6,true),
  ('other','Other','📦',7,true)
ON CONFLICT (id) DO NOTHING;

-- Baris lama (is_active NULL) → anggap aktif.
UPDATE public.product_categories SET is_active = true WHERE is_active IS NULL;

NOTIFY pgrst, 'reload schema';


-- ==============================================================
-- [20/24] 2026_06_customers_created_by.sql
-- ==============================================================
-- ═══════════════════════════════════════════════════════════════════
-- CUSTOMERS: kepemilikan per kasir (created_by) untuk hak akses tampilan.
-- Idempotent. Tidak mengubah data lama; kolom baru nullable.
--
-- Aturan akses (diterapkan di aplikasi):
--   • Staff Kasir → hanya melihat customer dengan created_by = id-nya.
--   • Staff Admin & Owner → melihat semua customer.
--   • Customer lama (created_by NULL) → tampil ke Owner/Admin, TIDAK ke kasir.
-- Catatan: auth aplikasi memakai tabel admins (anon key), bukan Supabase Auth,
-- sehingga RLS tidak bisa membedakan kasir — filter dilakukan di sisi aplikasi
-- (pola sama dengan scoping transaksi/piutang per kasir yang sudah ada).
-- ═══════════════════════════════════════════════════════════════════
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS created_by      uuid;
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS created_by_name text;
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS created_by_role text;
CREATE INDEX IF NOT EXISTS idx_customers_created_by ON public.customers (created_by);

NOTIFY pgrst, 'reload schema';


-- ==============================================================
-- [21/24] 2026_06_product_categories_realtime.sql
-- ==============================================================
-- ═══════════════════════════════════════════════════════════════════
-- REALTIME untuk product_categories — agar perubahan kategori (INSERT/
-- UPDATE/DELETE) langsung terkirim ke semua klien tanpa refresh.
-- Idempotent (aman diulang).
-- ═══════════════════════════════════════════════════════════════════
ALTER TABLE public.product_categories REPLICA IDENTITY FULL;

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.product_categories;
EXCEPTION
  WHEN duplicate_object THEN NULL;   -- sudah jadi anggota publikasi
  WHEN undefined_object THEN NULL;   -- publikasi supabase_realtime tidak ada
END $$;

NOTIFY pgrst, 'reload schema';


-- ==============================================================
-- [22/24] 2026_06_customer_reassign.sql
-- ==============================================================
-- ═══════════════════════════════════════════════════════════════════
-- PINDAH CUSTOMER (Piutang & Order) — perbaiki relasi customer pada nota
-- yang sudah ada, plus log audit & soft-delete customer.
-- Idempotent. TIDAK mengubah nominal/invoice/rumus — hanya relasi customer.
-- ═══════════════════════════════════════════════════════════════════

-- ---------- Snapshot kolom customer ----------
ALTER TABLE public.transactions  ADD COLUMN IF NOT EXISTS customer_name  text;
ALTER TABLE public.debts         ADD COLUMN IF NOT EXISTS customer_name  text;
ALTER TABLE public.debts         ADD COLUMN IF NOT EXISTS customer_phone text;
ALTER TABLE public.debt_payments ADD COLUMN IF NOT EXISTS customer_id    uuid;
ALTER TABLE public.debt_payments ADD COLUMN IF NOT EXISTS customer_name  text;

-- ---------- Soft delete customer (cegah hard delete bila masih ada transaksi) ----------
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- ---------- Index customer_id ----------
CREATE INDEX IF NOT EXISTS idx_transactions_customer_id  ON public.transactions  (customer_id);
CREATE INDEX IF NOT EXISTS idx_debts_customer_id2        ON public.debts         (customer_id);
CREATE INDEX IF NOT EXISTS idx_debt_payments_customer_id ON public.debt_payments (customer_id);
CREATE INDEX IF NOT EXISTS idx_customers_deleted_at      ON public.customers     (deleted_at);

-- ---------- LOG: receivable_customer_changes ----------
CREATE TABLE IF NOT EXISTS public.receivable_customer_changes (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  old_customer_id        uuid,
  old_customer_name      text,
  new_customer_id        uuid,
  new_customer_name      text,
  affected_invoice_count int DEFAULT 0,
  affected_debt_count    int DEFAULT 0,
  changed_by             uuid,
  changed_by_name        text,
  changed_at             timestamptz DEFAULT now(),
  notes                  text DEFAULT ''
);

-- ---------- LOG: order_customer_changes ----------
CREATE TABLE IF NOT EXISTS public.order_customer_changes (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_no        text,
  order_id          uuid,
  old_customer_id   uuid,
  old_customer_name text,
  new_customer_id   uuid,
  new_customer_name text,
  changed_by        uuid,
  changed_by_name   text,
  changed_at        timestamptz DEFAULT now(),
  notes             text DEFAULT ''
);

-- ---------- RLS + GRANT untuk tabel log ----------
ALTER TABLE public.receivable_customer_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_customer_changes      ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN CREATE POLICY "anon all receivable_customer_changes" ON public.receivable_customer_changes FOR ALL USING (true) WITH CHECK (true); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY "anon all order_customer_changes"      ON public.order_customer_changes      FOR ALL USING (true) WITH CHECK (true); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.receivable_customer_changes, public.order_customer_changes TO anon, authenticated;

NOTIFY pgrst, 'reload schema';


-- ==============================================================
-- [23/24] 2026_06_customer_owner_pic.sql
-- ==============================================================
-- ═══════════════════════════════════════════════════════════════════
-- KEPEMILIKAN CUSTOMER (PIC / Penanggung Jawab)
-- Idempotent. TIDAK mengubah invoice/transaksi/piutang/nominal — hanya
-- menambah kolom kepemilikan + backfill aman.
--   • owner_user_id = PIC customer (kasir hanya lihat customer miliknya).
--   • created_by tetap = pembuat (badge "Dibuat oleh").
-- ═══════════════════════════════════════════════════════════════════

-- ---------- Kolom PIC di customers ----------
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS owner_user_id  uuid;
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS owner_username text;
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS owner_name     text;
CREATE INDEX IF NOT EXISTS idx_customers_owner_user_id ON public.customers (owner_user_id);

-- ---------- Kolom PIC di transactions (untuk laporan per PIC) ----------
ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS owner_user_id uuid;
ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS owner_name    text;
CREATE INDEX IF NOT EXISTS idx_transactions_owner_user_id ON public.transactions (owner_user_id);

-- ---------- BACKFILL customer lama ----------
-- 1) owner = created_by bila ada
UPDATE public.customers SET owner_user_id = created_by
  WHERE owner_user_id IS NULL AND created_by IS NOT NULL;
-- 2) sisanya → Owner pertama (Admin Utama)
UPDATE public.customers SET owner_user_id = (
    SELECT id FROM public.admins WHERE role = 'owner' ORDER BY created_at ASC LIMIT 1
  )
  WHERE owner_user_id IS NULL;
-- 3) isi snapshot username/name dari admins
UPDATE public.customers c
  SET owner_username = a.username,
      owner_name     = COALESCE(NULLIF(a.name,''), a.username)
  FROM public.admins a
  WHERE c.owner_user_id = a.id
    AND (c.owner_username IS NULL OR c.owner_name IS NULL);

-- ---------- LOG: customer_owner_changes ----------
CREATE TABLE IF NOT EXISTS public.customer_owner_changes (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id    uuid,
  customer_name  text,
  old_owner_id   uuid,
  old_owner_name text,
  new_owner_id   uuid,
  new_owner_name text,
  changed_by     uuid,
  changed_by_name text,
  changed_at     timestamptz DEFAULT now()
);
ALTER TABLE public.customer_owner_changes ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN CREATE POLICY "anon all customer_owner_changes" ON public.customer_owner_changes FOR ALL USING (true) WITH CHECK (true); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.customer_owner_changes TO anon, authenticated;

NOTIFY pgrst, 'reload schema';


-- ==============================================================
-- [24/24] 2026_06_products_is_favorite.sql
-- ==============================================================
-- ═══════════════════════════════════════════════════════════════════
-- FAVORIT PRODUK — produk yang sering dijual tampil paling atas di Kasir.
-- Idempotent. Tidak mengubah harga/modal/kategori/rumus.
-- ═══════════════════════════════════════════════════════════════════
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS is_favorite boolean DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_products_is_favorite ON public.products (is_favorite);

NOTIFY pgrst, 'reload schema';


-- ===== SELESAI: reload schema cache PostgREST =====
NOTIFY pgrst, 'reload schema';

-- ==============================================================
-- [25/25] 2026_06_supplier_fifo_group.sql
-- ==============================================================
-- =====================================================================
-- Skupy POS — Migration: Pembayaran Gabungan FIFO Hutang Supplier
-- =====================================================================
-- Menambah kolom fifo_group pada supplier_debt_payments. Satu pembayaran
-- gabungan FIFO menulis beberapa baris (1 per nota) dengan fifo_group yang
-- sama, sehingga bisa dihapus sebagai satu batch (membatalkan semua alokasi).
-- Idempotent. Tempel di Supabase → SQL Editor → Run.
-- =====================================================================

ALTER TABLE public.supplier_debt_payments
  ADD COLUMN IF NOT EXISTS fifo_group uuid;

CREATE INDEX IF NOT EXISTS idx_sdp_fifo_group
  ON public.supplier_debt_payments (fifo_group);

NOTIFY pgrst, 'reload schema';

-- ==============================================================
-- [26/26] 2026_06_prepaid_rent_cashout.sql
-- ==============================================================
-- =====================================================================
-- Skupy POS — Migration: Sewa Dibayar Dimuka kurangi SALDO KAS/BANK
-- =====================================================================
-- Bug: pembayaran sewa dibayar di muka menambah Aset (Sewa Dibayar Dimuka)
-- tetapi acc_dashboard.saldo_kas / saldo_rekening TIDAK menguranginya, jadi
-- Saldo Kas & Total Aset jadi terlalu besar (uang seolah belum keluar).
--
-- Fix: tambahkan CTE prall (prepaid_rents s/d p_to) lalu kurangi saldo kas
-- (metode cash) & saldo rekening (transfer/qris) sebesar pembayaran sewa.
--
-- Catatan akuntansi:
--   • Arus Kas / Saldo Kas  : sewa keluar PENUH saat dibayar (di sini).
--   • Uang Keluar / Laba     : sewa pakai BEBAN amortisasi bulanan (di app).
--   • Aset Sewa Dibayar Dimuka berkurang seiring beban diakui (di app).
-- Idempotent. Tempel di Supabase → SQL Editor → Run.
-- =====================================================================

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
  oeall  AS (SELECT * FROM public.migration_details WHERE type='old_expense' AND deleted_at IS NULL AND trx_date <= p_to),
  -- SEWA DIBAYAR DIMUKA (cash-out PENUH saat dibayar, s/d p_to)
  prall  AS (SELECT * FROM public.prepaid_rents WHERE deleted_at IS NULL AND COALESCE(status,'') <> 'cancelled' AND payment_date <= p_to)
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
    'piutang_karyawan', (SELECT COALESCE(sum(greatest(0, round(amount)-round(paid))),0) FROM public.employee_cash_advances WHERE status='aktif' AND deleted_at IS NULL),
    'kasbon_keluar',    (SELECT COALESCE(sum(round(amount)),0) FROM eca),
    'kasbon_masuk',     (SELECT COALESCE(sum(round(amount)),0) FROM ecp),
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
      - (SELECT COALESCE(sum(round(total_amount)),0) FROM prall WHERE payment_method='cash')
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
      - (SELECT COALESCE(sum(round(total_amount)),0) FROM prall WHERE payment_method IN ('transfer','qris'))
    ),
    'modal_barang', (SELECT COALESCE(sum(round(amount)),0) FROM pur WHERE purchase_date BETWEEN p_from AND p_to)
                    + (SELECT COALESCE(sum(round(amount)),0) FROM exp WHERE category='Pembelian Bahan' AND expense_date BETWEEN p_from AND p_to)
  );
$$;
GRANT EXECUTE ON FUNCTION public.acc_dashboard(date, date) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';

-- ==============================================================
-- [27/27] 2026_06_capital_equity.sql
-- ==============================================================
-- =====================================================================
-- Skupy POS — Migration: Modal & Saldo Awal (Ekuitas) + Kas dari Pinjaman
-- =====================================================================
-- Menutup 2 celah neraca:
--   1) Setoran Modal pemilik (type='modal')      → menambah Kas/Bank & EKUITAS.
--   2) Pencairan pinjaman ke kas (type='loan_cash') → menambah Kas/Bank tanpa
--      menambah ekuitas (kewajiban hutang bank sudah tercatat terpisah).
-- Sehingga: Total Aset = Hutang + Modal + Laba Ditahan (neraca balance).
-- Idempotent. Tempel di Supabase → SQL Editor → Run.
-- =====================================================================

-- Longgarkan CHECK type agar menerima 'modal' & 'loan_cash'.
ALTER TABLE public.migration_details DROP CONSTRAINT IF EXISTS migration_details_type_check;
DO $ck$ BEGIN
  ALTER TABLE public.migration_details
    ADD CONSTRAINT migration_details_type_check
    CHECK (type IN ('old_income','old_expense','modal','loan_cash'));
EXCEPTION WHEN duplicate_object THEN NULL; END $ck$;

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
  oeall  AS (SELECT * FROM public.migration_details WHERE type='old_expense' AND deleted_at IS NULL AND trx_date <= p_to),
  -- SEWA DIBAYAR DIMUKA (cash-out PENUH saat dibayar, s/d p_to)
  prall  AS (SELECT * FROM public.prepaid_rents WHERE deleted_at IS NULL AND COALESCE(status,'') <> 'cancelled' AND payment_date <= p_to),
  -- MODAL / SALDO AWAL: setoran modal pemilik & pencairan pinjaman ke kas
  modall AS (SELECT * FROM public.migration_details WHERE type='modal'     AND deleted_at IS NULL AND trx_date <= p_to),
  lcall  AS (SELECT * FROM public.migration_details WHERE type='loan_cash' AND deleted_at IS NULL AND trx_date <= p_to)
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
    'piutang_karyawan', (SELECT COALESCE(sum(greatest(0, round(amount)-round(paid))),0) FROM public.employee_cash_advances WHERE status='aktif' AND deleted_at IS NULL),
    'kasbon_keluar',    (SELECT COALESCE(sum(round(amount)),0) FROM eca),
    'kasbon_masuk',     (SELECT COALESCE(sum(round(amount)),0) FROM ecp),
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
      - (SELECT COALESCE(sum(round(total_amount)),0) FROM prall WHERE payment_method='cash')
      + (SELECT COALESCE(sum(round(amount)),0) FROM modall WHERE method='cash')
      + (SELECT COALESCE(sum(round(amount)),0) FROM lcall  WHERE method='cash')
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
      - (SELECT COALESCE(sum(round(total_amount)),0) FROM prall WHERE payment_method IN ('transfer','qris'))
      + (SELECT COALESCE(sum(round(amount)),0) FROM modall WHERE method IN ('transfer','qris'))
      + (SELECT COALESCE(sum(round(amount)),0) FROM lcall  WHERE method IN ('transfer','qris'))
    ),
    'modal_disetor', (SELECT COALESCE(sum(round(amount)),0) FROM modall),
    'modal_barang', (SELECT COALESCE(sum(round(amount)),0) FROM pur WHERE purchase_date BETWEEN p_from AND p_to)
                    + (SELECT COALESCE(sum(round(amount)),0) FROM exp WHERE category='Pembelian Bahan' AND expense_date BETWEEN p_from AND p_to)
  );
$$;
GRANT EXECUTE ON FUNCTION public.acc_dashboard(date, date) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
