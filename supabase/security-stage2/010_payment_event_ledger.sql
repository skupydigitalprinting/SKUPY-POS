-- CANDIDATE ONLY. Apply explicitly after exported business schema + 001-006 + 009.
-- No historical DML, client wiring, identity change, refund or activation.
BEGIN;
SET LOCAL search_path = '';

CREATE TABLE pos_security.payment_baselines (
  invoice_no text PRIMARY KEY,
  order_id uuid UNIQUE,
  debt_id uuid NOT NULL UNIQUE REFERENCES public.debts(id),
  total numeric NOT NULL CHECK (total>0 AND total=trunc(total) AND total::text NOT IN ('NaN','Infinity','-Infinity')),
  initial_paid numeric NOT NULL CHECK (initial_paid>=0 AND initial_paid<=total),
  initial_snapshot jsonb NOT NULL,
  attested_by uuid NOT NULL,
  evidence_ref text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE pos_security.payment_events (
  payment_id uuid PRIMARY KEY,
  operation_id uuid NOT NULL UNIQUE REFERENCES pos_security.payment_operations(operation_id),
  invoice_no text NOT NULL REFERENCES pos_security.payment_baselines(invoice_no),
  amount numeric NOT NULL CHECK (amount>0 AND amount=trunc(amount) AND amount::text NOT IN ('NaN','Infinity','-Infinity')),
  method text NOT NULL CHECK (method IN ('cash','transfer','qris')),
  received_at timestamptz NOT NULL,
  actor_auth_user_id uuid NOT NULL,
  cashier_id uuid NOT NULL
);
-- Not a caller-settable GUC: only the definer RPC can open this transaction-local
-- write capability. It is removed before return and rolls back with any failure.
CREATE TABLE pos_security.payment_write_context (
  transaction_id bigint PRIMARY KEY,
  invoice_no text NOT NULL,
  payment_id uuid NOT NULL,
  paid_after numeric NOT NULL,
  remaining_after numeric NOT NULL
);
ALTER TABLE pos_security.payment_baselines ENABLE ROW LEVEL SECURITY;
ALTER TABLE pos_security.payment_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE pos_security.payment_write_context ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pos_security.payment_baselines,pos_security.payment_events,pos_security.payment_write_context
  FROM PUBLIC,anon,authenticated,service_role;

-- Private extension points. Without the explicitly installed lifecycle migration
-- these preserve the original 010 behavior exactly.
CREATE FUNCTION pos_security.lifecycle_write_allowed(text,text,jsonb,jsonb) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$ SELECT false $$;
CREATE FUNCTION pos_security.lifecycle_has_invoice(uuid) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$ SELECT false $$;
CREATE FUNCTION pos_security.lifecycle_payment_total(text,numeric) RETURNS numeric
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$ SELECT $2 $$;
CREATE FUNCTION pos_security.lifecycle_payment_paid(text,numeric) RETURNS numeric
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$ SELECT $2 $$;
REVOKE ALL ON FUNCTION pos_security.lifecycle_write_allowed(text,text,jsonb,jsonb),
  pos_security.lifecycle_has_invoice(uuid),pos_security.lifecycle_payment_total(text,numeric),
  pos_security.lifecycle_payment_paid(text,numeric) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION pos_security.payment_write_lock() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP='TRUNCATE' THEN RAISE EXCEPTION 'receipt lifecycle unsupported' USING ERRCODE='55000'; END IF;
  IF current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION 'receipt writes require read committed' USING ERRCODE='25000';
  END IF;
  -- BEFORE STATEMENT: take the 006 lock before any legacy writer takes row locks.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('skupy:business-invoice-binding:v1',0));
  RETURN NULL;
END $$;

CREATE FUNCTION pos_security.payment_write_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE b pos_security.payment_baselines; ctx pos_security.payment_write_context;
  oldj jsonb := CASE WHEN TG_OP<>'INSERT' THEN to_jsonb(OLD) END;
  newj jsonb := CASE WHEN TG_OP<>'DELETE' THEN to_jsonb(NEW) END;
  j jsonb := coalesce(newj,oldj);
BEGIN
  IF pos_security.lifecycle_write_allowed(TG_TABLE_NAME,TG_OP,oldj,newj) THEN
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO ctx FROM pos_security.payment_write_context WHERE transaction_id=txid_current();
  IF TG_TABLE_NAME IN ('accounting_entries','cash_movements') THEN
    -- Protect BOTH sides of an UPDATE, including a disguised source/invoice.
    IF EXISTS (SELECT 1 FROM pos_security.payment_baselines x WHERE
      x.invoice_no IN (oldj->>'invoice_no',newj->>'invoice_no')
      OR x.order_id IN ((oldj->>'source_id')::uuid,(newj->>'source_id')::uuid))
      OR EXISTS (SELECT 1 FROM pos_security.payment_events e WHERE
        e.payment_id IN ((oldj->>'source_id')::uuid,(newj->>'source_id')::uuid)) THEN
      IF TG_OP='INSERT' AND j->>'source_type'='debt_payment'
        AND (j->>'source_id')::uuid=ctx.payment_id AND j->>'invoice_no'=ctx.invoice_no THEN RETURN NEW; END IF;
      RAISE EXCEPTION 'receipt journal is immutable' USING ERRCODE='55000';
    END IF;
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME='debt_payments' THEN
    IF TG_OP='INSERT' AND NEW.id=ctx.payment_id AND NEW.invoice_no=ctx.invoice_no THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'legacy receipt writer unsupported' USING ERRCODE='55000';
  END IF;
  SELECT * INTO b FROM pos_security.payment_baselines x WHERE
    x.invoice_no IN (oldj->>'invoice_no',newj->>'invoice_no')
    OR (TG_TABLE_NAME='transactions' AND x.order_id IN ((oldj->>'id')::uuid,(newj->>'id')::uuid))
    OR (TG_TABLE_NAME='debts' AND x.debt_id IN ((oldj->>'id')::uuid,(newj->>'id')::uuid));
  IF b.invoice_no IS NOT NULL THEN
    IF TG_OP='UPDATE' AND ctx.invoice_no=b.invoice_no
      AND (newj->>'paid')::numeric=ctx.paid_after AND (newj->>'remaining')::numeric=ctx.remaining_after
      AND newj->>'status'=(CASE WHEN ctx.remaining_after=0 THEN 'lunas' WHEN TG_TABLE_NAME='transactions' THEN 'pending' ELSE 'aktif' END)
      AND (oldj-ARRAY['paid','remaining','status','updated_at'])=(newj-ARRAY['paid','remaining','status','updated_at'])
      THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'receipt lifecycle unsupported' USING ERRCODE='55000';
  END IF;
  -- Before adoption, money corrections/legacy receipts are still unsupported.
  IF TG_OP='UPDATE' AND ((oldj->'paid' IS DISTINCT FROM newj->'paid')
    OR (oldj->'remaining' IS DISTINCT FROM newj->'remaining') OR (oldj->'dp' IS DISTINCT FROM newj->'dp')
    OR (oldj->'total' IS DISTINCT FROM newj->'total') OR (oldj->'total_debt' IS DISTINCT FROM newj->'total_debt')
    OR (oldj->'payment_method' IS DISTINCT FROM newj->'payment_method')) THEN
    RAISE EXCEPTION 'legacy balance correction unsupported' USING ERRCODE='55000';
  END IF;
  IF TG_OP IN ('UPDATE','DELETE') AND (coalesce((oldj->>'paid')::numeric,0)>0
      OR coalesce((oldj->>'dp')::numeric,0)>0
      OR EXISTS (SELECT 1 FROM public.debt_payments p WHERE p.invoice_no=oldj->>'invoice_no'
        OR (TG_TABLE_NAME='debts' AND p.debt_id=(oldj->>'id')::uuid)))
    AND (TG_OP='DELETE' OR newj->'deleted_at' IS DISTINCT FROM oldj->'deleted_at'
      OR lower(btrim(newj->>'status')) IN ('dibatalkan','cancelled','canceled')
      OR lower(btrim(newj->>'order_status')) IN ('dibatalkan','cancelled','canceled')) THEN
    RAISE EXCEPTION 'paid cancellation requires money disposition' USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['transactions','debts','debt_payments','accounting_entries','cash_movements'] LOOP
    EXECUTE format('CREATE TRIGGER "00_payment_write_lock" BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON public.%I
      FOR EACH STATEMENT EXECUTE FUNCTION pos_security.payment_write_lock()',t);
    EXECUTE format('CREATE TRIGGER "02_payment_write_guard" BEFORE INSERT OR UPDATE OR DELETE ON public.%I
      FOR EACH ROW EXECUTE FUNCTION pos_security.payment_write_guard()',t);
  END LOOP;
END $$;

CREATE FUNCTION pos_security.payment_check_initial(p_order uuid,p_debt uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE t public.transactions; d public.debts; n integer; valid boolean;
BEGIN
  SELECT * INTO STRICT d FROM public.debts WHERE id=p_debt;
  IF EXISTS (SELECT 1 FROM public.debt_payments p WHERE p.debt_id=d.id OR p.invoice_no=d.invoice_no)
    OR EXISTS (SELECT 1 FROM pos_security.payment_operations o WHERE o.debt_id=d.id OR o.order_id=p_order) THEN
    RAISE EXCEPTION 'historical installments require separate reconciliation' USING ERRCODE='22023';
  END IF;
  IF p_order IS NULL THEN
    IF d.transaction_id IS NOT NULL OR d.is_opening IS DISTINCT FROM true OR d.paid IS DISTINCT FROM 0::numeric
      OR EXISTS (SELECT 1 FROM public.accounting_entries e WHERE e.invoice_no=d.invoice_no OR e.source_id=d.id)
      OR EXISTS (SELECT 1 FROM public.cash_movements m WHERE m.invoice_no=d.invoice_no OR m.source_id=d.id) THEN
      RAISE EXCEPTION 'ambiguous opening history' USING ERRCODE='22023';
    END IF;
    RETURN;
  END IF;
  SELECT * INTO STRICT t FROM public.transactions WHERE id=p_order;
  IF t.paid IS NULL OR t.dp IS DISTINCT FROM t.paid OR t.created_at IS NULL
    OR t.payment_method IS NULL OR t.payment_method NOT IN ('cash','transfer','qris','hutang')
    OR (t.paid>0 AND t.payment_method='hutang') OR t.paid<0 OR t.total<=0 OR t.paid>=t.total
    OR t.remaining IS DISTINCT FROM t.total-t.paid
    OR t.total::text IN ('NaN','Infinity','-Infinity') OR t.total<>trunc(t.total) OR t.paid<>trunc(t.paid)
    OR d.transaction_id IS DISTINCT FROM t.id OR d.customer_id IS DISTINCT FROM t.customer_id
    OR d.book_id IS DISTINCT FROM t.book_id OR d.invoice_no IS DISTINCT FROM t.invoice_no
    OR d.total_debt IS DISTINCT FROM t.total OR d.paid IS DISTINCT FROM t.paid OR d.remaining IS DISTINCT FROM t.remaining
    OR d.deleted_at IS NOT NULL OR d.status IS DISTINCT FROM 'aktif' OR t.deleted_at IS NOT NULL
    OR lower(btrim(coalesce(t.order_status,''))) IN ('dibatalkan','cancelled','canceled')
    OR lower(btrim(coalesce(t.status,''))) IN ('dibatalkan','cancelled','canceled')
    OR (SELECT count(*) FROM public.debts x WHERE x.invoice_no=t.invoice_no OR x.transaction_id=t.id)<>1 THEN
    RAISE EXCEPTION 'ambiguous initial receipt' USING ERRCODE='22023';
  END IF;
  SELECT count(*),bool_and((e.source_type='sale' AND e.source_id=t.id AND e.invoice_no=t.invoice_no
    AND e.entry_date=(t.created_at AT TIME ZONE 'Asia/Jakarta')::date AND e.cashier_id IS NOT DISTINCT FROM t.cashier_id
    AND ((e.account_code='4000' AND e.debit=0 AND e.credit=t.total)
      OR (e.account_code='1200' AND e.debit=t.remaining AND e.credit=0)
      OR (t.paid>0 AND e.account_code=public.acc_cash_code(t.payment_method) AND e.debit=t.paid AND e.credit=0))) IS TRUE)
    INTO n,valid FROM public.accounting_entries e WHERE e.invoice_no=t.invoice_no OR e.source_id=t.id;
  IF n<>(CASE WHEN t.paid>0 THEN 3 ELSE 2 END) OR valid IS NOT TRUE
    OR (SELECT count(DISTINCT e.account_code) FROM public.accounting_entries e WHERE e.source_type='sale' AND e.source_id=t.id)<>n THEN
    RAISE EXCEPTION 'initial sale journal requires reconciliation' USING ERRCODE='22023';
  END IF;
  SELECT count(*),bool_and((m.source_type='sale' AND m.source_id=t.id AND m.invoice_no=t.invoice_no
    AND m.moved_at=t.created_at AND m.method=t.payment_method AND m.direction='in' AND m.amount=t.paid
    AND m.cashier_id IS NOT DISTINCT FROM t.cashier_id) IS TRUE) INTO n,valid
    FROM public.cash_movements m WHERE m.invoice_no=t.invoice_no OR m.source_id=t.id;
  IF n<>(CASE WHEN t.paid>0 THEN 1 ELSE 0 END) OR (t.paid>0 AND valid IS NOT TRUE) THEN
    RAISE EXCEPTION 'initial cash history requires reconciliation' USING ERRCODE='22023';
  END IF;
END $$;

-- Attestation ONLY: preserve a single already-posted initial DP, never rewrite it.
-- The owner must supply the exact snapshot and a reviewed external evidence ref.
-- Any installment (even soft-deleted), overwritten DP, journal drift or ambiguity
-- requires a separate reviewed per-invoice reconciliation, not this RPC.
CREATE FUNCTION public.pos_reconcile_initial_receipt(p_order_id uuid,p_expected jsonb,p_evidence_ref text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE actor record; t public.transactions; d public.debts; expected_time timestamptz;
BEGIN
  SELECT * INTO actor FROM public.pos_current_profile();
  IF actor.id IS NULL OR actor.role<>'owner' THEN RAISE EXCEPTION 'reconciliation denied' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM pos_security.user_access a WHERE a.auth_user_id=actor.auth_user_id FOR SHARE;
  SELECT * INTO actor FROM public.pos_current_profile();
  IF actor.id IS NULL OR actor.role<>'owner' THEN RAISE EXCEPTION 'reconciliation denied' USING ERRCODE='42501'; END IF;
  IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'isolation unsupported' USING ERRCODE='25000'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('skupy:business-invoice-binding:v1',0));
  SELECT * INTO t FROM public.transactions WHERE id=p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown initial receipt' USING ERRCODE='22023'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('pos-payment:'||t.invoice_no,0));
  PERFORM 1 FROM public.debts x WHERE x.invoice_no=t.invoice_no OR x.transaction_id=t.id ORDER BY x.id FOR UPDATE;
  SELECT * INTO d FROM public.debts WHERE transaction_id=t.id;
  PERFORM 1 FROM public.customers c WHERE c.id=t.customer_id AND c.book_id IS NOT DISTINCT FROM t.book_id
    AND c.deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND OR d.id IS NULL OR t.paid IS NULL OR t.paid<=0
    OR EXISTS (SELECT 1 FROM pos_security.payment_baselines b WHERE b.invoice_no=t.invoice_no)
    OR p_evidence_ref IS NULL OR length(btrim(p_evidence_ref)) NOT BETWEEN 1 AND 1000
    OR p_expected IS NULL OR jsonb_typeof(p_expected)<>'object' THEN
    RAISE EXCEPTION 'invalid reconciliation request' USING ERRCODE='22023';
  END IF;
  BEGIN expected_time := (p_expected->>'created_at')::timestamptz;
  EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'invalid receipt date' USING ERRCODE='22023'; END;
  IF expected_time IS DISTINCT FROM t.created_at OR (p_expected-'created_at') IS DISTINCT FROM
    jsonb_build_object('invoice_no',t.invoice_no,'customer_id',t.customer_id,'book_id',t.book_id,
      'total',t.total,'paid',t.paid,'dp',t.dp,'remaining',t.remaining,'payment_method',t.payment_method) THEN
    RAISE EXCEPTION 'stale initial receipt snapshot' USING ERRCODE='22023';
  END IF;
  PERFORM pos_security.payment_check_initial(t.id,d.id);
  INSERT INTO pos_security.payment_baselines(invoice_no,order_id,debt_id,total,initial_paid,initial_snapshot,attested_by,evidence_ref)
    VALUES (t.invoice_no,t.id,d.id,t.total,t.paid,p_expected,actor.auth_user_id,btrim(p_evidence_ref));
  IF NOT FOUND THEN RAISE EXCEPTION 'baseline insertion failed' USING ERRCODE='23514'; END IF;
  RETURN jsonb_build_object('invoice_no',t.invoice_no,'initial_paid',t.paid,'status','initial_receipt_attested');
EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'receipt reconciliation rejected' USING ERRCODE=SQLSTATE;
END $$;

CREATE OR REPLACE FUNCTION public.pos_record_payment(
  p_operation_id uuid,p_invoice_no text,p_amount numeric,p_method text,p_notes text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  actor record; op pos_security.payment_operations; b pos_security.payment_baselines;
  t public.transactions; d public.debts; candidate_debt public.debts; c public.customers;
  invoice text := btrim(p_invoice_no); v_method text := lower(btrim(p_method)); v_notes text := coalesce(p_notes,''); fingerprint text;
  has_order boolean; debt_count integer := 0; allowed boolean := false;
  v_total numeric; paid_before numeric; remaining_before numeric; paid_after numeric; remaining_after numeric;
  receipt jsonb; payment uuid := gen_random_uuid(); received timestamptz; cash_code text; n integer; valid boolean;
BEGIN
  SELECT * INTO actor FROM public.pos_current_profile();
  IF actor.id IS NULL THEN RAISE EXCEPTION 'payment denied' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM pos_security.user_access a WHERE a.auth_user_id=actor.auth_user_id FOR SHARE;
  SELECT * INTO actor FROM public.pos_current_profile();
  IF actor.id IS NULL THEN RAISE EXCEPTION 'payment denied' USING ERRCODE='42501'; END IF;
  IF p_operation_id IS NULL OR invoice IS NULL OR invoice='' OR length(invoice)>256
    OR p_amount IS NULL OR p_amount::text IN ('NaN','Infinity','-Infinity') OR p_amount<=0 OR p_amount<>trunc(p_amount)
    OR v_method IS NULL OR v_method NOT IN ('cash','transfer','qris') OR length(v_notes)>4000 THEN
    RAISE EXCEPTION 'invalid payment request' USING ERRCODE='22023';
  END IF;
  fingerprint := encode(sha256(convert_to(jsonb_build_object('invoice_no',invoice,'amount',trim_scale(p_amount),
    'method',v_method,'notes',v_notes)::text,'UTF8')),'hex');
  INSERT INTO pos_security.payment_operations(operation_id,actor_auth_user_id,request_fingerprint)
    VALUES (p_operation_id,actor.auth_user_id,fingerprint) ON CONFLICT DO NOTHING;
  SELECT * INTO STRICT op FROM pos_security.payment_operations WHERE operation_id=p_operation_id FOR UPDATE;
  IF op.actor_auth_user_id<>actor.auth_user_id THEN RAISE EXCEPTION 'operation denied' USING ERRCODE='42501'; END IF;
  IF op.request_fingerprint<>fingerprint THEN RAISE EXCEPTION 'operation request changed' USING ERRCODE='22023'; END IF;
  -- Old 009 receipts may replay, but are never converted or reposted by replay.
  IF op.result IS NOT NULL THEN RETURN op.result; END IF;
  IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'isolation unsupported' USING ERRCODE='25000'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('skupy:business-invoice-binding:v1',0));
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('pos-payment:'||invoice,0));
  SELECT * INTO t FROM public.transactions WHERE invoice_no=invoice FOR UPDATE;
  has_order := FOUND;
  FOR candidate_debt IN SELECT * FROM public.debts WHERE invoice_no=invoice OR (has_order AND transaction_id=t.id) ORDER BY id FOR UPDATE LOOP
    debt_count := debt_count+1; d := candidate_debt; allowed := allowed OR pos_security.business_debt(d.id);
  END LOOP;
  IF has_order THEN allowed := pos_security.business_order(t.id) OR
    (pos_security.business_customer(t.customer_id) AND pos_security.business_book(t.book_id)); END IF;
  IF NOT allowed THEN RAISE EXCEPTION 'payment denied' USING ERRCODE='42501'; END IF;
  IF debt_count>1 THEN RAISE EXCEPTION 'ambiguous invoice debt' USING ERRCODE='22023'; END IF;
  IF has_order THEN
    IF t.deleted_at IS NOT NULL OR lower(btrim(coalesce(t.order_status,''))) IN ('dibatalkan','cancelled','canceled')
      OR lower(btrim(coalesce(t.status,''))) IN ('dibatalkan','cancelled','canceled') OR t.customer_id IS NULL THEN
      RAISE EXCEPTION 'order cannot receive payment' USING ERRCODE='22023';
    END IF;
    IF debt_count=1 AND (d.transaction_id IS DISTINCT FROM t.id OR d.customer_id IS DISTINCT FROM t.customer_id
      OR d.book_id IS DISTINCT FROM t.book_id OR d.invoice_no IS DISTINCT FROM t.invoice_no
      OR d.total_debt IS DISTINCT FROM t.total OR d.paid IS DISTINCT FROM t.paid OR d.remaining IS DISTINCT FROM t.remaining) THEN
      RAISE EXCEPTION 'order/debt mismatch' USING ERRCODE='22023';
    END IF;
    v_total := t.total; paid_before := t.paid; remaining_before := t.remaining;
  ELSE
    IF debt_count<>1 OR d.transaction_id IS NOT NULL OR d.is_opening IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'invalid opening debt' USING ERRCODE='22023'; END IF;
    v_total := d.total_debt; paid_before := d.paid; remaining_before := d.remaining;
  END IF;
  IF debt_count=1 AND (d.deleted_at IS NOT NULL OR d.status IS DISTINCT FROM 'aktif') THEN
    RAISE EXCEPTION 'debt cannot receive payment' USING ERRCODE='22023'; END IF;
  IF v_total IS NULL OR paid_before IS NULL OR remaining_before IS NULL
    OR v_total::text IN ('NaN','Infinity','-Infinity') OR paid_before::text IN ('NaN','Infinity','-Infinity')
    OR remaining_before::text IN ('NaN','Infinity','-Infinity') OR v_total<>trunc(v_total) OR paid_before<>trunc(paid_before)
    OR remaining_before<>trunc(remaining_before) OR v_total<=0 OR paid_before<0 OR paid_before>v_total
    OR remaining_before<>v_total-paid_before OR p_amount>remaining_before THEN
    RAISE EXCEPTION 'invalid or insufficient balance' USING ERRCODE='22023'; END IF;
  SELECT * INTO c FROM public.customers WHERE id=CASE WHEN has_order THEN t.customer_id ELSE d.customer_id END FOR UPDATE;
  IF NOT FOUND OR c.deleted_at IS NOT NULL OR c.book_id IS DISTINCT FROM (CASE WHEN has_order THEN t.book_id ELSE d.book_id END) THEN
    RAISE EXCEPTION 'invalid customer/book link' USING ERRCODE='22023'; END IF;
  IF c.book_id IS NOT NULL THEN
    PERFORM 1 FROM public.books WHERE id=c.book_id FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'unknown book' USING ERRCODE='22023'; END IF;
  END IF;
  IF NOT pos_security.business_book(c.book_id) OR NOT (pos_security.business_manager() OR pos_security.business_customer(c.id)
    OR (has_order AND pos_security.business_order(t.id))) THEN RAISE EXCEPTION 'payment denied' USING ERRCODE='42501'; END IF;
  IF has_order AND debt_count=0 THEN
    INSERT INTO public.debts(customer_id,transaction_id,invoice_no,total_debt,paid,remaining,due_date,status,
      cashier_id,cashier_name,customer_name,customer_phone,book_id,is_opening)
      VALUES (c.id,t.id,t.invoice_no,v_total,paid_before,remaining_before,t.due_date,'aktif',t.cashier_id,
        coalesce(t.cashier_name,t.cashier),c.name,c.phone,t.book_id,false) RETURNING * INTO d;
    IF NOT FOUND THEN RAISE EXCEPTION 'debt insertion failed' USING ERRCODE='23514'; END IF;
  END IF;
  SELECT * INTO b FROM pos_security.payment_baselines WHERE invoice_no=invoice FOR UPDATE;
  IF NOT FOUND THEN
    IF paid_before<>0 THEN RAISE EXCEPTION 'historical receipt reconciliation required' USING ERRCODE='22023'; END IF;
    PERFORM pos_security.payment_check_initial(CASE WHEN has_order THEN t.id END,d.id);
    INSERT INTO pos_security.payment_baselines(invoice_no,order_id,debt_id,total,initial_paid,initial_snapshot,attested_by)
      VALUES (invoice,CASE WHEN has_order THEN t.id END,d.id,v_total,0,
        CASE WHEN has_order THEN to_jsonb(t) ELSE to_jsonb(d) END,actor.auth_user_id) RETURNING * INTO b;
    IF NOT FOUND THEN RAISE EXCEPTION 'baseline insertion failed' USING ERRCODE='23514'; END IF;
  END IF;
  IF b.order_id IS DISTINCT FROM (CASE WHEN has_order THEN t.id END) OR b.debt_id IS DISTINCT FROM d.id
    OR pos_security.lifecycle_payment_total(invoice,b.total) IS DISTINCT FROM v_total
    OR paid_before<>pos_security.lifecycle_payment_paid(invoice,b.initial_paid+coalesce((SELECT sum(e.amount) FROM pos_security.payment_events e WHERE e.invoice_no=invoice),0)) THEN
    RAISE EXCEPTION 'receipt ledger balance mismatch' USING ERRCODE='23514'; END IF;
  paid_after := paid_before+p_amount; remaining_after := v_total-paid_after;
  received := clock_timestamp(); cash_code := public.acc_cash_code(v_method);
  INSERT INTO pos_security.payment_write_context VALUES (txid_current(),invoice,payment,paid_after,remaining_after);
  IF has_order THEN
    UPDATE public.transactions SET paid=paid_after,remaining=remaining_after,
      status=CASE WHEN remaining_after=0 THEN 'lunas' ELSE 'pending' END WHERE id=t.id;
    IF NOT FOUND THEN RAISE EXCEPTION 'order update failed' USING ERRCODE='23514'; END IF;
  END IF;
  UPDATE public.debts SET paid=paid_after,remaining=remaining_after,status=CASE WHEN remaining_after=0 THEN 'lunas' ELSE 'aktif' END WHERE id=d.id;
  IF NOT FOUND THEN RAISE EXCEPTION 'debt update failed' USING ERRCODE='23514'; END IF;
  INSERT INTO pos_security.payment_events(payment_id,operation_id,invoice_no,amount,method,received_at,actor_auth_user_id,cashier_id)
    VALUES (payment,p_operation_id,invoice,p_amount,v_method,received,actor.auth_user_id,actor.id);
  IF NOT FOUND THEN RAISE EXCEPTION 'event insertion failed' USING ERRCODE='23514'; END IF;
  INSERT INTO public.debt_payments(id,debt_id,amount,payment_method,notes,paid_at,cashier,cashier_id,invoice_no,cashier_name,customer_id,customer_name,book_id)
    VALUES (payment,d.id,p_amount,v_method,v_notes,received,actor.name,actor.id,invoice,actor.name,c.id,c.name,c.book_id);
  IF NOT FOUND THEN RAISE EXCEPTION 'receipt insertion failed' USING ERRCODE='23514'; END IF;
  INSERT INTO public.accounting_entries(entry_date,source_type,source_id,invoice_no,account_code,debit,credit,description,cashier_id)
    VALUES ((received AT TIME ZONE 'Asia/Jakarta')::date,'debt_payment',payment,invoice,cash_code,p_amount,0,'Receivable payment',actor.id),
      ((received AT TIME ZONE 'Asia/Jakarta')::date,'debt_payment',payment,invoice,'1200',0,p_amount,'Receivable payment',actor.id);
  INSERT INTO public.cash_movements(moved_at,direction,method,amount,source_type,source_id,invoice_no,note,cashier_id)
    VALUES (received,'in',v_method,p_amount,'debt_payment',payment,invoice,'Receivable payment',actor.id);
  SELECT count(*),bool_and((e.source_type='debt_payment' AND e.invoice_no=invoice AND e.cashier_id=actor.id
    AND e.entry_date=(received AT TIME ZONE 'Asia/Jakarta')::date
    AND ((e.account_code=cash_code AND e.debit=p_amount AND e.credit=0) OR (e.account_code='1200' AND e.debit=0 AND e.credit=p_amount))) IS TRUE)
    INTO n,valid FROM public.accounting_entries e WHERE e.source_id=payment;
  IF n<>2 OR valid IS NOT TRUE OR (SELECT count(DISTINCT account_code) FROM public.accounting_entries WHERE source_id=payment)<>2 THEN
    RAISE EXCEPTION 'receipt journal verification failed' USING ERRCODE='23514'; END IF;
  SELECT count(*),bool_and((m.source_type='debt_payment' AND m.invoice_no=invoice AND m.cashier_id=actor.id
    AND m.moved_at=received AND m.direction='in' AND m.method=v_method AND m.amount=p_amount) IS TRUE)
    INTO n,valid FROM public.cash_movements m WHERE m.source_id=payment;
  IF n<>1 OR valid IS NOT TRUE THEN RAISE EXCEPTION 'cash receipt verification failed' USING ERRCODE='23514'; END IF;
  -- Check stored rows, not only row counts: another BEFORE trigger may return a
  -- modified NEW row without raising. Any divergence aborts the entire receipt.
  IF NOT EXISTS (SELECT 1 FROM public.debt_payments p WHERE p.id=payment AND p.debt_id=d.id
      AND p.invoice_no=invoice AND p.amount=p_amount AND p.payment_method=v_method AND p.paid_at=received
      AND p.cashier_id=actor.id AND p.customer_id=c.id AND p.book_id IS NOT DISTINCT FROM c.book_id
      AND p.notes=v_notes AND p.deleted_at IS NULL)
    OR NOT EXISTS (SELECT 1 FROM pos_security.payment_events e WHERE e.payment_id=payment AND e.operation_id=p_operation_id
      AND e.invoice_no=invoice AND e.amount=p_amount AND e.method=v_method AND e.received_at=received
      AND e.actor_auth_user_id=actor.auth_user_id AND e.cashier_id=actor.id)
    OR NOT EXISTS (SELECT 1 FROM public.debts x WHERE x.id=d.id AND x.paid=paid_after AND x.remaining=remaining_after
      AND x.total_debt=v_total AND x.status=CASE WHEN remaining_after=0 THEN 'lunas' ELSE 'aktif' END)
    OR (has_order AND NOT EXISTS (SELECT 1 FROM public.transactions x WHERE x.id=t.id AND x.paid=paid_after
      AND x.remaining=remaining_after AND x.total=v_total AND x.dp IS NOT DISTINCT FROM t.dp
      AND x.status=CASE WHEN remaining_after=0 THEN 'lunas' ELSE 'pending' END)) THEN
    RAISE EXCEPTION 'stored receipt verification failed' USING ERRCODE='23514';
  END IF;
  receipt := jsonb_build_object('invoice_no',invoice,'amount',p_amount,'paid',paid_after,'remaining',remaining_after,
    'status',CASE WHEN remaining_after=0 THEN 'lunas' ELSE 'aktif' END);
  UPDATE pos_security.payment_operations SET payment_id=payment,debt_id=d.id,order_id=CASE WHEN has_order THEN t.id END,
    result=receipt,completed_at=clock_timestamp() WHERE operation_id=p_operation_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'operation completion failed' USING ERRCODE='23514'; END IF;
  DELETE FROM pos_security.payment_write_context WHERE transaction_id=txid_current();
  RETURN receipt;
EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'payment rejected' USING ERRCODE=SQLSTATE;
END $$;

-- Retain exported sale posting for unadopted sales. For an adopted invoice the
-- initial journal stays immutable; subsequent money is posted only by the RPC.
CREATE OR REPLACE FUNCTION public.acc_fn_post_transaction() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_total numeric; v_paid numeric; v_rem numeric; v_cash text; v_date date;
BEGIN
  IF pos_security.lifecycle_has_invoice(CASE WHEN TG_OP='DELETE' THEN OLD.id ELSE NEW.id END)
    OR EXISTS (SELECT 1 FROM pos_security.payment_baselines b WHERE b.order_id=CASE WHEN TG_OP='DELETE' THEN OLD.id ELSE NEW.id END) THEN
    IF TG_OP='DELETE' THEN RAISE EXCEPTION 'receipt lifecycle unsupported' USING ERRCODE='55000'; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' THEN
    DELETE FROM public.accounting_entries WHERE source_type='sale' AND source_id=OLD.id;
    DELETE FROM public.cash_movements WHERE source_type='sale' AND source_id=OLD.id;
    RETURN OLD;
  END IF;
  DELETE FROM public.accounting_entries WHERE source_type='sale' AND source_id=NEW.id;
  DELETE FROM public.cash_movements WHERE source_type='sale' AND source_id=NEW.id;
  IF coalesce(NEW.order_status,'')='dibatalkan' THEN RETURN NEW; END IF;
  v_total := round(coalesce(NEW.total,0)); v_paid := round(coalesce(NEW.paid,0)); v_rem := greatest(0,v_total-v_paid);
  v_cash := public.acc_cash_code(NEW.payment_method);
  v_date := (coalesce(NEW.created_at,now()) AT TIME ZONE 'Asia/Jakarta')::date;
  IF v_total<=0 THEN RETURN NEW; END IF;
  INSERT INTO public.accounting_entries(entry_date,source_type,source_id,invoice_no,account_code,debit,credit,description,cashier_id)
    VALUES (v_date,'sale',NEW.id,NEW.invoice_no,'4000',0,v_total,'Penjualan '||coalesce(NEW.invoice_no,''),NEW.cashier_id);
  IF v_paid>0 THEN
    INSERT INTO public.accounting_entries(entry_date,source_type,source_id,invoice_no,account_code,debit,credit,description,cashier_id)
      VALUES (v_date,'sale',NEW.id,NEW.invoice_no,v_cash,v_paid,0,'Penerimaan penjualan',NEW.cashier_id);
    INSERT INTO public.cash_movements(moved_at,direction,method,amount,source_type,source_id,invoice_no,note,cashier_id)
      VALUES (coalesce(NEW.created_at,now()),'in',coalesce(NEW.payment_method,'cash'),v_paid,'sale',NEW.id,NEW.invoice_no,'Penjualan',NEW.cashier_id);
  END IF;
  IF v_rem>0 THEN
    INSERT INTO public.accounting_entries(entry_date,source_type,source_id,invoice_no,account_code,debit,credit,description,cashier_id)
      VALUES (v_date,'sale',NEW.id,NEW.invoice_no,'1200',v_rem,0,'Piutang penjualan',NEW.cashier_id);
  END IF;
  RETURN NEW;
  -- Deliberately no catch-and-warning: a posting error aborts its sale statement.
END $$;

CREATE OR REPLACE FUNCTION public.acc_resync() RETURNS json
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM pos_security.business_require(true);
  RAISE EXCEPTION 'legacy resync unsupported by receipt ledger candidate' USING ERRCODE='55000';
END $$;

REVOKE ALL ON FUNCTION pos_security.payment_write_lock(),pos_security.payment_write_guard(),
  pos_security.payment_check_initial(uuid,uuid),public.acc_fn_post_transaction(),
  public.pos_record_payment(uuid,text,numeric,text,text),public.pos_reconcile_initial_receipt(uuid,jsonb,text),public.acc_resync()
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.pos_record_payment(uuid,text,numeric,text,text),
  public.pos_reconcile_initial_receipt(uuid,jsonb,text),public.acc_resync() TO authenticated;
COMMIT;
