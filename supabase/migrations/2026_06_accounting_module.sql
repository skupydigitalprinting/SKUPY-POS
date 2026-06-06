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
