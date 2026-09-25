-- Operator-only temporary repair, loaded after reconcile-legacy-payment.sql.
-- Only sub-micro-rupiah representation drift is accepted. Preserve old snapshots.
CREATE OR REPLACE FUNCTION pg_temp.normalize_legacy_payment(
  invoice text, expected_paid numeric, expected_remaining numeric, owner_auth uuid, evidence text
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE t public.transactions; after_t public.transactions; d public.debts;
  before_entries jsonb; before_cash jsonb; before_receipts jsonb; operation uuid:=gen_random_uuid();
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('skupy:business-invoice-binding:v1',0));
  PERFORM pg_advisory_xact_lock(hashtextextended('pos-payment:'||invoice,0));
  SELECT * INTO STRICT t FROM public.transactions WHERE invoice_no=invoice FOR UPDATE;
  SELECT * INTO STRICT d FROM public.debts WHERE invoice_no=invoice OR transaction_id=t.id FOR UPDATE;
  IF t.paid IS DISTINCT FROM expected_paid OR d.paid IS DISTINCT FROM expected_paid
    OR d.remaining IS DISTINCT FROM expected_remaining OR d.total_debt IS DISTINCT FROM expected_paid+expected_remaining
    OR t.total IS NULL OR t.remaining IS NULL OR t.subtotal IS NULL
    OR t.total=round(t.total) OR abs(t.total-round(t.total))>=0.000001
    OR abs(t.remaining-round(t.remaining))>=0.000001 OR abs(t.subtotal-round(t.subtotal))>=0.000001
    OR round(t.total)<>d.total_debt OR round(t.remaining)<>d.remaining
    OR round(t.subtotal)-coalesce(t.discount,0)+coalesce(t.tax,0)<>d.total_debt
    OR EXISTS(SELECT 1 FROM pos_security.payment_baselines WHERE invoice_no=invoice)
    OR EXISTS(SELECT 1 FROM pos_security.invoice_states WHERE order_id=t.id)
    THEN RAISE EXCEPTION 'not isolated fractional legacy drift'; END IF;
  SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY id),'[]') INTO before_entries FROM public.accounting_entries e WHERE invoice_no=invoice;
  SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY id),'[]') INTO before_cash FROM public.cash_movements m WHERE invoice_no=invoice;
  SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY id),'[]') INTO before_receipts FROM public.debt_payments p WHERE debt_id=d.id;
  -- Protect already-posted cash/journals from legacy sale-resync triggers while
  -- the exact invoice is normalized through the existing private write context.
  INSERT INTO pos_security.payment_baselines(invoice_no,order_id,debt_id,total,initial_paid,initial_snapshot,attested_by,evidence_ref)
    VALUES(invoice,t.id,d.id,d.total_debt,expected_paid,to_jsonb(t),owner_auth,evidence);
  INSERT INTO pos_security.invoice_write_context VALUES(txid_current(),t.id,invoice,operation);
  UPDATE public.transactions SET subtotal=round(subtotal),total=round(total),remaining=round(remaining) WHERE id=t.id RETURNING * INTO after_t;
  DELETE FROM pos_security.invoice_write_context WHERE transaction_id=txid_current() AND operation_id=operation;
  IF (to_jsonb(after_t)-ARRAY['subtotal','total','remaining','version','updated_at']) IS DISTINCT FROM
     (to_jsonb(t)-ARRAY['subtotal','total','remaining','version','updated_at'])
    OR (SELECT to_jsonb(x) FROM public.debts x WHERE id=d.id) IS DISTINCT FROM to_jsonb(d)
    OR before_entries IS DISTINCT FROM (SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY id),'[]') FROM public.accounting_entries e WHERE invoice_no=invoice)
    OR before_cash IS DISTINCT FROM (SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY id),'[]') FROM public.cash_movements m WHERE invoice_no=invoice)
    OR before_receipts IS DISTINCT FROM (SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY id),'[]') FROM public.debt_payments p WHERE debt_id=d.id)
    THEN RAISE EXCEPTION 'normalization changed unrelated history'; END IF;
  DELETE FROM pos_security.payment_baselines WHERE invoice_no=invoice;
  PERFORM pg_temp.reconcile_legacy_payment(invoice,expected_paid,expected_remaining,owner_auth,evidence);
  UPDATE pos_security.payment_baselines SET initial_snapshot=initial_snapshot||jsonb_build_object('before_fraction_normalization',to_jsonb(t)) WHERE invoice_no=invoice;
END $$;
REVOKE ALL ON FUNCTION pg_temp.normalize_legacy_payment(text,numeric,numeric,uuid,text) FROM PUBLIC;
