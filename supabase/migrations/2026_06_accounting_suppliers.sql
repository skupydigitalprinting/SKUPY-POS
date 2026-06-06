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
