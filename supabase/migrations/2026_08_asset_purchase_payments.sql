-- ============================================================================
-- SKUPY POS - PEMBELIAN ASET, DP, UTANG ASET, DAN CICILAN
-- Aset lama tetap legacy (payment_tracking=false) dan tidak membentuk utang.
-- ============================================================================

ALTER TABLE public.assets ADD COLUMN IF NOT EXISTS supplier_name text DEFAULT '';
ALTER TABLE public.assets ADD COLUMN IF NOT EXISTS payment_due_date date;
ALTER TABLE public.assets ADD COLUMN IF NOT EXISTS payment_tracking boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS public.asset_purchase_payments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id       uuid NOT NULL REFERENCES public.assets(id) ON DELETE CASCADE,
  payment_date   date NOT NULL DEFAULT now()::date,
  amount         numeric NOT NULL CHECK (amount > 0),
  payment_method text NOT NULL DEFAULT 'transfer' CHECK (payment_method IN ('cash','transfer','qris')),
  payment_type   text NOT NULL DEFAULT 'installment' CHECK (payment_type IN ('dp','installment','full')),
  note           text DEFAULT '',
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz
);

CREATE INDEX IF NOT EXISTS idx_asset_purchase_payments_asset
  ON public.asset_purchase_payments(asset_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_asset_purchase_payments_date
  ON public.asset_purchase_payments(payment_date) WHERE deleted_at IS NULL;

ALTER TABLE public.asset_purchase_payments ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "anon all asset_purchase_payments"
    ON public.asset_purchase_payments FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT ALL ON public.asset_purchase_payments TO anon, authenticated;

-- Mencegah jumlah pembayaran aktif melebihi harga perolehan aset.
CREATE OR REPLACE FUNCTION public.acc_validate_asset_purchase_payment()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_price numeric; v_paid numeric;
BEGIN
  IF NEW.deleted_at IS NOT NULL THEN RETURN NEW; END IF;
  SELECT round(purchase_price) INTO v_price FROM public.assets WHERE id=NEW.asset_id;
  SELECT COALESCE(sum(round(amount)),0) INTO v_paid
    FROM public.asset_purchase_payments
   WHERE asset_id=NEW.asset_id AND deleted_at IS NULL AND id<>NEW.id;
  IF round(NEW.amount)+v_paid > COALESCE(v_price,0) THEN
    RAISE EXCEPTION 'Pembayaran aset melebihi sisa utang';
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS acc_validate_asset_purchase_payment ON public.asset_purchase_payments;
CREATE TRIGGER acc_validate_asset_purchase_payment
BEFORE INSERT OR UPDATE ON public.asset_purchase_payments
FOR EACH ROW EXECUTE FUNCTION public.acc_validate_asset_purchase_payment();

-- Jurnal pembelian aset: Dr Aset Tetap, Cr Utang Aset. Setiap pembayaran:
-- Dr Utang Aset, Cr Kas/Bank. Tidak pernah masuk akun beban laba-rugi.
INSERT INTO public.accounts(code,name,type,normal) VALUES
  ('2100','Utang Pembelian Aset','liability','credit')
ON CONFLICT (code) DO NOTHING;

CREATE OR REPLACE FUNCTION public.acc_repost_asset_purchase(p_asset_id uuid)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE a public.assets%ROWTYPE; p record; v_cash text;
BEGIN
  DELETE FROM public.accounting_entries
   WHERE (source_type='asset_purchase' AND source_id=p_asset_id)
      OR (source_type='asset_purchase_payment' AND invoice_no=p_asset_id::text);
  DELETE FROM public.cash_movements
   WHERE source_type='asset_purchase_payment' AND invoice_no=p_asset_id::text;

  SELECT * INTO a FROM public.assets WHERE id=p_asset_id;
  IF NOT FOUND OR a.deleted_at IS NOT NULL OR NOT COALESCE(a.payment_tracking,false) THEN RETURN; END IF;

  INSERT INTO public.accounting_entries(entry_date,source_type,source_id,invoice_no,account_code,debit,credit,description)
  VALUES
    (a.purchase_date,'asset_purchase',a.id,a.id::text,'1400',round(a.purchase_price),0,'Perolehan aset '||COALESCE(a.name,'')),
    (a.purchase_date,'asset_purchase',a.id,a.id::text,'2100',0,round(a.purchase_price),'Utang perolehan aset '||COALESCE(a.name,''));

  FOR p IN SELECT * FROM public.asset_purchase_payments
            WHERE asset_id=a.id AND deleted_at IS NULL ORDER BY payment_date,created_at
  LOOP
    v_cash := CASE WHEN p.payment_method IN ('transfer','qris') THEN '1100' ELSE '1000' END;
    INSERT INTO public.accounting_entries(entry_date,source_type,source_id,invoice_no,account_code,debit,credit,description)
    VALUES
      (p.payment_date,'asset_purchase_payment',p.id,a.id::text,'2100',round(p.amount),0,'Pembayaran aset '||COALESCE(a.name,'')),
      (p.payment_date,'asset_purchase_payment',p.id,a.id::text,v_cash,0,round(p.amount),'Kas keluar pembelian aset '||COALESCE(a.name,''));
    INSERT INTO public.cash_movements(moved_at,direction,method,amount,source_type,source_id,invoice_no,note)
    VALUES ((p.payment_date::text||' 12:00:00+07')::timestamptz,'out',p.payment_method,round(p.amount),'asset_purchase_payment',p.id,a.id::text,'Pembelian aset '||COALESCE(a.name,''));
  END LOOP;
END; $$;

CREATE OR REPLACE FUNCTION public.acc_asset_payment_changed()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM public.acc_repost_asset_purchase(COALESCE(NEW.asset_id,OLD.asset_id));
  RETURN COALESCE(NEW,OLD);
END; $$;

CREATE OR REPLACE FUNCTION public.acc_asset_master_changed()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM public.acc_repost_asset_purchase(COALESCE(NEW.id,OLD.id));
  RETURN COALESCE(NEW,OLD);
END; $$;

DROP TRIGGER IF EXISTS acc_trg_asset_payment ON public.asset_purchase_payments;
CREATE TRIGGER acc_trg_asset_payment
AFTER INSERT OR UPDATE OR DELETE ON public.asset_purchase_payments
FOR EACH ROW EXECUTE FUNCTION public.acc_asset_payment_changed();

DROP TRIGGER IF EXISTS acc_trg_asset_master_purchase ON public.assets;
CREATE TRIGGER acc_trg_asset_master_purchase
AFTER INSERT OR UPDATE OF purchase_date,purchase_price,name,payment_tracking,deleted_at ON public.assets
FOR EACH ROW EXECUTE FUNCTION public.acc_asset_master_changed();

GRANT EXECUTE ON FUNCTION public.acc_validate_asset_purchase_payment() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.acc_repost_asset_purchase(uuid) TO anon, authenticated;
NOTIFY pgrst, 'reload schema';
