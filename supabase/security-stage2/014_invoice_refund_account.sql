BEGIN;
DO $$
DECLARE configured text;
BEGIN
  LOCK TABLE pos_security.invoice_account_config IN EXCLUSIVE MODE;
  SELECT refund_account INTO configured FROM pos_security.invoice_account_config;
  IF configured IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.accounts WHERE code=configured
      AND type='liability' AND normal='credit' AND code NOT IN ('1000','1100','1200','2000','2100','4000')) THEN
      RAISE EXCEPTION 'Existing refund account is invalid';
    END IF;
    RETURN;
  END IF;
  INSERT INTO public.accounts(code,name,type,normal)
    VALUES ('2195','Utang Refund Pelanggan','liability','credit') ON CONFLICT DO NOTHING;
  IF NOT EXISTS (SELECT 1 FROM public.accounts WHERE code='2195'
    AND name='Utang Refund Pelanggan' AND type='liability' AND normal='credit') THEN
    RAISE EXCEPTION 'Account 2195 is already used for another purpose';
  END IF;
  INSERT INTO pos_security.invoice_account_config(singleton,refund_account) VALUES (true,'2195');
END $$;
COMMIT;
