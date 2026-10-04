-- Operator-only, temporary helper. Run in an explicit transaction with reviewed
-- invoice/paid/remaining values. No public RPC, permission changes or money writes.
-- A missing linked debt can be restored only for a verified initial sale receipt.
CREATE OR REPLACE FUNCTION pg_temp.reconcile_legacy_payment(
  invoice text, expected_paid numeric, expected_remaining numeric, owner_auth uuid, evidence text
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE t public.transactions; d public.debts; snapshot jsonb;
  journal jsonb; cash jsonb; receipts jsonb; customer_before jsonb;
  restored boolean := false;
BEGIN
  IF evidence IS NULL OR length(btrim(evidence))<10 OR NOT EXISTS (
    SELECT 1 FROM pos_security.user_access WHERE auth_user_id=owner_auth AND role='owner' AND active
  ) THEN RAISE EXCEPTION 'owner attestation required'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('skupy:business-invoice-binding:v1',0));
  PERFORM pg_advisory_xact_lock(hashtextextended('pos-payment:'||invoice,0));
  SELECT * INTO STRICT t FROM public.transactions WHERE invoice_no=invoice FOR UPDATE;
  SELECT to_jsonb(c) INTO STRICT customer_before FROM public.customers c WHERE id=t.customer_id FOR UPDATE;
  SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.id),'[]') INTO journal FROM public.accounting_entries x WHERE invoice_no=invoice OR source_id=t.id;
  SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.id),'[]') INTO cash FROM public.cash_movements x WHERE invoice_no=invoice OR source_id=t.id;
  BEGIN
    SELECT * INTO STRICT d FROM public.debts WHERE invoice_no=invoice OR transaction_id=t.id FOR UPDATE;
  EXCEPTION WHEN no_data_found THEN
    INSERT INTO public.debts(customer_id,transaction_id,invoice_no,total_debt,paid,remaining,due_date,status,
      cashier_id,cashier_name,customer_name,customer_phone,book_id,is_opening)
      VALUES(t.customer_id,t.id,t.invoice_no,t.total,t.paid,t.remaining,t.due_date,'aktif',t.cashier_id,
        coalesce(t.cashier_name,t.cashier),customer_before->>'name',customer_before->>'phone',t.book_id,false)
      RETURNING * INTO STRICT d;
    PERFORM pos_security.payment_check_initial(t.id,d.id);
    restored := true;
  END;
  IF t.paid IS DISTINCT FROM expected_paid OR d.paid IS DISTINCT FROM expected_paid
    OR t.remaining IS DISTINCT FROM expected_remaining OR d.remaining IS DISTINCT FROM expected_remaining
    OR t.total IS DISTINCT FROM expected_paid+expected_remaining OR d.total_debt IS DISTINCT FROM t.total
    OR expected_paid<=0 OR expected_remaining<=0 OR expected_paid<>trunc(expected_paid) OR expected_remaining<>trunc(expected_remaining)
    OR d.transaction_id IS DISTINCT FROM t.id OR d.customer_id IS DISTINCT FROM t.customer_id
    OR d.book_id IS DISTINCT FROM t.book_id OR d.invoice_no IS DISTINCT FROM t.invoice_no
    OR d.deleted_at IS NOT NULL OR t.deleted_at IS NOT NULL OR d.status<>'aktif'
    OR lower(coalesce(t.order_status,'')) IN ('dibatalkan','cancelled','canceled')
    OR NOT EXISTS (SELECT 1 FROM public.customers c WHERE c.id=t.customer_id AND c.book_id IS NOT DISTINCT FROM t.book_id AND c.deleted_at IS NULL)
    OR EXISTS (SELECT 1 FROM pos_security.payment_events WHERE invoice_no=invoice)
    OR EXISTS (SELECT 1 FROM pos_security.invoice_events WHERE order_id=t.id)
    THEN RAISE EXCEPTION 'legacy snapshot mismatch: %',invoice; END IF;
  IF EXISTS (SELECT 1 FROM pos_security.payment_baselines WHERE invoice_no=invoice) THEN
    RAISE EXCEPTION 'baseline already exists: %',invoice;
  END IF;
  -- Historical resync can consolidate installments into the sale journal.
  -- Attest the current cumulative paid balance, never replay old receipts.
  IF (SELECT coalesce(sum(CASE WHEN direction='in' THEN amount ELSE -amount END),0) FROM public.cash_movements WHERE invoice_no=invoice)<>expected_paid
    OR (SELECT coalesce(sum(debit-credit),0) FROM public.accounting_entries WHERE invoice_no=invoice)<>0
    OR (SELECT coalesce(sum(debit-credit),0) FROM public.accounting_entries WHERE invoice_no=invoice AND account_code='1200')<>expected_remaining
    OR (SELECT coalesce(sum(credit-debit),0) FROM public.accounting_entries WHERE invoice_no=invoice AND account_code='4000')<>t.total
    OR (SELECT coalesce(sum(debit-credit),0) FROM public.accounting_entries WHERE invoice_no=invoice AND account_code IN ('1000','1100'))<>expected_paid
    OR EXISTS (SELECT 1 FROM public.accounting_entries WHERE invoice_no=invoice AND account_code NOT IN ('1000','1100','1200','4000'))
    OR EXISTS (SELECT 1 FROM public.debt_payments WHERE (debt_id=d.id OR invoice_no=invoice) AND (deleted_at IS NOT NULL OR amount<=0 OR debt_id IS DISTINCT FROM d.id))
    OR (SELECT coalesce(sum(amount),0) FROM public.debt_payments WHERE debt_id=d.id)>expected_paid
    THEN RAISE EXCEPTION 'legacy ledger mismatch: %',invoice; END IF;
  IF (SELECT to_jsonb(x) FROM public.transactions x WHERE id=t.id) IS DISTINCT FROM to_jsonb(t) THEN
    RAISE EXCEPTION 'restoration changed invoice: %',invoice;
  END IF;
  -- The existing debt trigger refreshes the customer's derived totals.
  IF (SELECT to_jsonb(x)-ARRAY['total_debt','total_spent','total_transactions','updated_at'] FROM public.customers x WHERE id=t.customer_id)
    IS DISTINCT FROM customer_before-ARRAY['total_debt','total_spent','total_transactions','updated_at'] THEN
    RAISE EXCEPTION 'restoration changed customer: %',invoice;
  END IF;
  IF restored AND NOT EXISTS (SELECT 1 FROM public.customers c WHERE c.id=t.customer_id
    AND c.total_debt=(SELECT coalesce(sum(x.remaining),0) FROM public.debts x WHERE x.customer_id=c.id AND x.deleted_at IS NULL AND x.status='aktif')
    AND c.total_spent=(SELECT coalesce(sum(x.total),0) FROM public.transactions x WHERE x.customer_id=c.id AND x.deleted_at IS NULL AND coalesce(x.order_status,'') NOT IN ('dibatalkan','cancelled','canceled'))
    AND c.total_transactions=(SELECT count(*) FROM public.transactions x WHERE x.customer_id=c.id AND x.deleted_at IS NULL AND coalesce(x.order_status,'') NOT IN ('dibatalkan','cancelled','canceled'))) THEN
    RAISE EXCEPTION 'restored customer summary mismatch: %',invoice;
  END IF;
  IF (SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.id),'[]') FROM public.accounting_entries x WHERE invoice_no=invoice OR source_id=t.id) IS DISTINCT FROM journal THEN
    RAISE EXCEPTION 'restoration changed journal: %',invoice;
  END IF;
  IF (SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.id),'[]') FROM public.cash_movements x WHERE invoice_no=invoice OR source_id=t.id) IS DISTINCT FROM cash THEN
    RAISE EXCEPTION 'restoration changed cash: %',invoice;
  END IF;
  SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.id),'[]') INTO receipts FROM public.debt_payments x WHERE debt_id=d.id;
  snapshot:=jsonb_build_object('kind','legacy_cumulative_paid','transaction',to_jsonb(t),'debt',to_jsonb(d),
    'accounting_entries',journal,'cash_movements',cash,'debt_payments',receipts,'restored_missing_debt',restored,
    'customer_before',customer_before);
  INSERT INTO pos_security.payment_baselines(invoice_no,order_id,debt_id,total,initial_paid,initial_snapshot,attested_by,evidence_ref)
    VALUES(invoice,t.id,d.id,t.total,expected_paid,snapshot,owner_auth,evidence);
END $$;
REVOKE ALL ON FUNCTION pg_temp.reconcile_legacy_payment(text,numeric,numeric,uuid,text) FROM PUBLIC;
