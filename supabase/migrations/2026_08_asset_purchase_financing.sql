-- Pembelian aset terintegrasi: aset + DP + pembiayaan + cicilan pokok/bunga.
-- Idempotent. Jalankan setelah assets dan bank_recalc_and_expense_categories.

INSERT INTO public.accounts(code,name,type,normal) VALUES
  ('1500','Aset Tetap','asset','debit')
ON CONFLICT (code) DO NOTHING;

ALTER TABLE public.assets ADD COLUMN IF NOT EXISTS payment_scheme text DEFAULT 'unrecorded';
ALTER TABLE public.assets ADD COLUMN IF NOT EXISTS supplier_name text DEFAULT '';
ALTER TABLE public.assets ADD COLUMN IF NOT EXISTS available_for_use_date date;
ALTER TABLE public.assets ADD COLUMN IF NOT EXISTS financing_loan_id uuid;

ALTER TABLE public.bank_loans ADD COLUMN IF NOT EXISTS asset_id uuid;
ALTER TABLE public.bank_loans ADD COLUMN IF NOT EXISTS is_asset_financing boolean NOT NULL DEFAULT false;
ALTER TABLE public.bank_loans ADD COLUMN IF NOT EXISTS supplier_name text DEFAULT '';
ALTER TABLE public.bank_loans ADD COLUMN IF NOT EXISTS total_interest numeric NOT NULL DEFAULT 0;
ALTER TABLE public.bank_loans ADD COLUMN IF NOT EXISTS installment_count integer;
ALTER TABLE public.bank_loans ADD COLUMN IF NOT EXISTS first_due_date date;

ALTER TABLE public.bank_loan_payments ADD COLUMN IF NOT EXISTS payment_type text NOT NULL DEFAULT 'installment';
ALTER TABLE public.bank_loan_payments ADD COLUMN IF NOT EXISTS admin_fee numeric NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_bank_loans_asset ON public.bank_loans(asset_id);

-- Saldo kewajiban hanya berkurang sebesar pokok, bukan bunga/biaya/DP.
CREATE OR REPLACE FUNCTION public.acc_recalc_bank_loan(p_loan uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_awal numeric; v_paid numeric; v_sisa numeric;
BEGIN
  SELECT COALESCE(pokok_awal, sisa_pokok, 0) INTO v_awal FROM public.bank_loans WHERE id = p_loan;
  SELECT COALESCE(sum(round(COALESCE(pokok,0))),0) INTO v_paid
    FROM public.bank_loan_payments
   WHERE loan_id = p_loan AND deleted_at IS NULL AND COALESCE(payment_type,'installment') <> 'down_payment';
  v_sisa := greatest(0, COALESCE(v_awal,0) - v_paid);
  UPDATE public.bank_loans
     SET sisa_pokok = v_sisa,
         status = CASE WHEN v_sisa <= 0 THEN 'lunas' ELSE 'aktif' END
   WHERE id = p_loan;
END; $$;
GRANT EXECUTE ON FUNCTION public.acc_recalc_bank_loan(uuid) TO anon, authenticated;

-- Jurnal cicilan: pokok mengurangi kewajiban, bunga/biaya menjadi beban.
-- DP sudah dijurnal bersama perolehan aset; trigger ini hanya membuat cash movement DP.
CREATE OR REPLACE FUNCTION public.acc_fn_post_bank_payment()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_amt numeric; v_pok numeric; v_bun numeric; v_fee numeric; v_cash text; v_loan uuid; v_pid uuid; v_type text;
BEGIN
  v_pid := COALESCE(NEW.id, OLD.id);
  v_loan := COALESCE(NEW.loan_id, OLD.loan_id);
  DELETE FROM public.accounting_entries WHERE source_type='bank_payment' AND source_id=v_pid;
  DELETE FROM public.cash_movements WHERE source_type='bank_payment' AND source_id=v_pid;

  IF TG_OP <> 'DELETE' AND NEW.deleted_at IS NULL THEN
    v_amt := round(COALESCE(NEW.amount,0));
    v_pok := round(COALESCE(NEW.pokok,0));
    v_bun := round(COALESCE(NEW.bunga,0));
    v_fee := round(COALESCE(NEW.admin_fee,0));
    v_type := COALESCE(NEW.payment_type,'installment');
    v_cash := public.acc_cash_code(NEW.method);
    IF v_amt > 0 THEN
      IF v_type <> 'down_payment' THEN
        IF v_pok > 0 THEN
          INSERT INTO public.accounting_entries(entry_date,source_type,source_id,account_code,debit,credit,description,cashier_id)
          VALUES (NEW.paid_at::date,'bank_payment',NEW.id,'2100',v_pok,0,'Pokok cicilan pembiayaan',NEW.cashier_id);
        END IF;
        IF v_bun + v_fee > 0 THEN
          INSERT INTO public.accounting_entries(entry_date,source_type,source_id,account_code,debit,credit,description,cashier_id)
          VALUES (NEW.paid_at::date,'bank_payment',NEW.id,'6100',v_bun+v_fee,0,'Bunga dan biaya pembiayaan',NEW.cashier_id);
        END IF;
        INSERT INTO public.accounting_entries(entry_date,source_type,source_id,account_code,debit,credit,description,cashier_id)
        VALUES (NEW.paid_at::date,'bank_payment',NEW.id,v_cash,0,v_amt,'Pembayaran cicilan pembiayaan',NEW.cashier_id);
      END IF;
      INSERT INTO public.cash_movements(moved_at,direction,method,amount,source_type,source_id,note,cashier_id)
      VALUES (NEW.paid_at,'out',COALESCE(NEW.method,'transfer'),v_amt,'bank_payment',NEW.id,
              CASE WHEN v_type='down_payment' THEN 'DP pembelian aset' ELSE 'Cicilan pembiayaan' END,NEW.cashier_id);
    END IF;
  END IF;
  PERFORM public.acc_recalc_bank_loan(v_loan);
  RETURN COALESCE(NEW, OLD);
END; $$;

DROP TRIGGER IF EXISTS acc_trg_bank_payment ON public.bank_loan_payments;
CREATE TRIGGER acc_trg_bank_payment
AFTER INSERT OR UPDATE OR DELETE ON public.bank_loan_payments
FOR EACH ROW EXECUTE FUNCTION public.acc_fn_post_bank_payment();

-- Satu transaksi database untuk membuat aset, pembiayaan, DP, dan jurnal perolehan.
CREATE OR REPLACE FUNCTION public.acc_create_asset_purchase(p_asset jsonb, p_financing jsonb)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_asset uuid; v_loan uuid; v_price numeric; v_dp numeric; v_principal numeric;
  v_scheme text; v_method text; v_cash text; v_existing uuid;
BEGIN
  v_price := round(COALESCE((p_asset->>'purchase_price')::numeric,0));
  v_dp := round(COALESCE((p_financing->>'down_payment')::numeric,0));
  v_principal := round(COALESCE((p_financing->>'financed_principal')::numeric,0));
  v_scheme := COALESCE(NULLIF(p_financing->>'scheme',''),'cash');
  v_method := COALESCE(NULLIF(p_financing->>'payment_method',''),'transfer');
  v_existing := NULLIF(p_financing->>'existing_loan_id','')::uuid;
  IF v_price <= 0 THEN RAISE EXCEPTION 'Harga perolehan harus lebih dari 0'; END IF;
  IF v_dp < 0 OR v_principal < 0 OR v_dp + v_principal <> v_price THEN
    RAISE EXCEPTION 'DP + pokok pembiayaan harus sama dengan harga perolehan';
  END IF;

  INSERT INTO public.assets(name,category_id,category_name,purchase_date,purchase_price,residual_value,
    depreciation_method,depreciation_rate,useful_life_years,photo_url,notes,status,created_by,
    payment_scheme,supplier_name,available_for_use_date)
  VALUES (p_asset->>'name',NULLIF(p_asset->>'category_id','')::uuid,p_asset->>'category_name',
    (p_asset->>'purchase_date')::date,v_price,COALESCE((p_asset->>'residual_value')::numeric,0),
    COALESCE(p_asset->>'depreciation_method','percentage'),COALESCE((p_asset->>'depreciation_rate')::numeric,0),
    NULLIF(p_asset->>'useful_life_years','')::integer,NULLIF(p_asset->>'photo_url',''),COALESCE(p_asset->>'notes',''),
    'active',NULLIF(p_asset->>'created_by','')::uuid,v_scheme,COALESCE(p_financing->>'supplier_name',''),
    COALESCE(NULLIF(p_asset->>'available_for_use_date','')::date,(p_asset->>'purchase_date')::date))
  RETURNING id INTO v_asset;

  IF v_existing IS NOT NULL THEN
    UPDATE public.bank_loans SET asset_id=v_asset,is_asset_financing=true,
      supplier_name=COALESCE(NULLIF(p_financing->>'supplier_name',''),nama_bank),updated_at=now()
    WHERE id=v_existing RETURNING id,pokok_awal INTO v_loan,v_principal;
    IF v_loan IS NULL THEN RAISE EXCEPTION 'Data cicilan lama tidak ditemukan'; END IF;
  ELSE
    INSERT INTO public.bank_loans(nama_bank,jenis_pinjaman,nomor_kontrak,tanggal_mulai,tanggal_jatuh_tempo,
      plafon_pinjaman,sisa_pokok,pokok_awal,bunga,cicilan_bulanan,keterangan,status,asset_id,is_asset_financing,
      supplier_name,total_interest,installment_count,first_due_date)
    VALUES (COALESCE(NULLIF(p_financing->>'financier_name',''),NULLIF(p_financing->>'supplier_name',''),'Pembelian Tunai'),
      CASE WHEN v_scheme='cash' THEN 'Pembelian Aset Tunai' ELSE 'Leasing/Pembiayaan Aset' END,
      COALESCE(p_financing->>'contract_no',''),(p_asset->>'purchase_date')::date,NULLIF(p_financing->>'end_date','')::date,
      v_principal,v_principal,v_principal,0,COALESCE((p_financing->>'installment_amount')::numeric,0),
      'Pembelian aset: '||(p_asset->>'name'),CASE WHEN v_principal<=0 THEN 'lunas' ELSE 'aktif' END,
      v_asset,true,COALESCE(p_financing->>'supplier_name',''),COALESCE((p_financing->>'total_interest')::numeric,0),
      NULLIF(p_financing->>'installment_count','')::integer,NULLIF(p_financing->>'first_due_date','')::date)
    RETURNING id INTO v_loan;
  END IF;

  UPDATE public.assets SET financing_loan_id=v_loan WHERE id=v_asset;

  v_cash := public.acc_cash_code(v_method);
  INSERT INTO public.accounting_entries(entry_date,source_type,source_id,account_code,debit,credit,description,cashier_id)
  VALUES ((p_asset->>'purchase_date')::date,'asset_purchase',v_asset,'1500',v_price,0,'Perolehan aset '||(p_asset->>'name'),NULLIF(p_asset->>'created_by','')::uuid);
  IF v_principal > 0 THEN
    INSERT INTO public.accounting_entries(entry_date,source_type,source_id,account_code,debit,credit,description,cashier_id)
    VALUES ((p_asset->>'purchase_date')::date,'asset_purchase',v_asset,'2100',0,v_principal,'Pembiayaan aset '||(p_asset->>'name'),NULLIF(p_asset->>'created_by','')::uuid);
  END IF;
  IF v_dp > 0 THEN
    INSERT INTO public.accounting_entries(entry_date,source_type,source_id,account_code,debit,credit,description,cashier_id)
    VALUES ((p_asset->>'purchase_date')::date,'asset_purchase',v_asset,v_cash,0,v_dp,'DP pembelian aset '||(p_asset->>'name'),NULLIF(p_asset->>'created_by','')::uuid);
    INSERT INTO public.bank_loan_payments(loan_id,paid_at,amount,pokok,bunga,admin_fee,method,note,cashier_id,payment_type,payment_number)
    VALUES (v_loan,(p_asset->>'purchase_date')::date + time '12:00',v_dp,0,0,0,v_method,'DP pembelian aset '||(p_asset->>'name'),
            NULLIF(p_asset->>'created_by','')::uuid,'down_payment',0);
  END IF;
  RETURN json_build_object('asset_id',v_asset,'loan_id',v_loan);
END; $$;

GRANT EXECUTE ON FUNCTION public.acc_create_asset_purchase(jsonb,jsonb) TO anon, authenticated;
NOTIFY pgrst, 'reload schema';
