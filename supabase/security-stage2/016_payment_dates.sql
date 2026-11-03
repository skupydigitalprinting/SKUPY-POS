-- Explicitly apply after 015. Never run against production without reviewed rollout.
-- paid_at is the effective day; recorded_at/received_at preserve input provenance.
BEGIN;
SET LOCAL search_path = '';
SET LOCAL lock_timeout = '10s';

-- Follow the same lock order as payment and invoice operations during backfill.
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('skupy:business-invoice-binding:v1',0));
-- The implementation below preserves the reviewed 010 writer. Stop rather than
-- overwrite an independently patched deployment (also checked read-only live).
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.pos_record_payment(uuid,text,numeric,text,text)')
    AND md5(prosrc)='75e7c05b8cae0bc0b8f866fa64d3f6fa' AND prosecdef
    AND proconfig @> ARRAY['search_path=""']) THEN
    RAISE EXCEPTION 'Unreviewed payment writer definition: compare deployment with the 010 baseline before installing payment dates'
      USING ERRCODE='55000';
  END IF;
END $$;
ALTER TABLE public.debt_payments ADD COLUMN recorded_at timestamptz;
ALTER TABLE pos_security.payment_events ADD COLUMN effective_at timestamptz;

CREATE TABLE pos_security.payment_date_operations (
  operation_id uuid PRIMARY KEY,
  payment_id uuid NOT NULL REFERENCES public.debt_payments(id),
  actor_auth_user_id uuid NOT NULL,
  request_fingerprint text NOT NULL,
  reason text NOT NULL,
  old_paid_at timestamptz NOT NULL,
  new_paid_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL,
  changed_at timestamptz NOT NULL,
  result jsonb NOT NULL
);
CREATE TABLE pos_security.payment_date_write_context (
  transaction_id bigint PRIMARY KEY,
  payment_id uuid NOT NULL,
  invoice_no text,
  old_paid_at timestamptz,
  new_paid_at timestamptz,
  backfill boolean NOT NULL DEFAULT false
);
ALTER TABLE pos_security.payment_date_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE pos_security.payment_date_write_context ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pos_security.payment_date_operations,pos_security.payment_date_write_context
  FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION pos_security.payment_date_write_allowed(p_table text,p_op text,p_old jsonb,p_new jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE ctx pos_security.payment_date_write_context;
BEGIN
  IF p_op<>'UPDATE' OR p_old IS NULL OR p_new IS NULL THEN RETURN false; END IF;
  SELECT * INTO ctx FROM pos_security.payment_date_write_context WHERE transaction_id=txid_current();
  IF NOT FOUND THEN RETURN false; END IF;
  IF ctx.backfill THEN
    RETURN p_table='debt_payments' AND (p_old->>'id')::uuid=ctx.payment_id
      AND p_old->>'recorded_at' IS NULL AND (p_new->>'recorded_at')::timestamptz=ctx.old_paid_at
      AND (p_old-'recorded_at')=(p_new-'recorded_at');
  END IF;
  IF p_old->>'invoice_no' IS DISTINCT FROM ctx.invoice_no OR p_new->>'invoice_no' IS DISTINCT FROM ctx.invoice_no THEN
    RETURN false;
  END IF;
  IF p_table='debt_payments' THEN
    RETURN (p_old->>'id')::uuid=ctx.payment_id AND (p_old-'paid_at')=(p_new-'paid_at')
      AND (p_old->>'paid_at')::timestamptz=ctx.old_paid_at AND (p_new->>'paid_at')::timestamptz=ctx.new_paid_at;
  END IF;
  IF p_old->>'source_type' IS DISTINCT FROM 'debt_payment' OR (p_old->>'source_id')::uuid IS DISTINCT FROM ctx.payment_id THEN
    RETURN false;
  END IF;
  IF p_table='cash_movements' THEN
    RETURN (p_old-'moved_at')=(p_new-'moved_at') AND (p_old->>'moved_at')::timestamptz=ctx.old_paid_at
      AND (p_new->>'moved_at')::timestamptz=ctx.new_paid_at;
  ELSIF p_table='accounting_entries' THEN
    RETURN (p_old-'entry_date')=(p_new-'entry_date')
      AND (p_old->>'entry_date')::date=(ctx.old_paid_at AT TIME ZONE 'Asia/Jakarta')::date
      AND (p_new->>'entry_date')::date=(ctx.new_paid_at AT TIME ZONE 'Asia/Jakarta')::date;
  END IF;
  RETURN false;
END $$;

-- Preserve 011's protection in full. The 010 guard calls this extension before
-- considering its own write capability, including for lifecycle-managed invoices.
ALTER FUNCTION pos_security.lifecycle_write_allowed(text,text,jsonb,jsonb) RENAME TO lifecycle_write_allowed_before_payment_dates;
CREATE FUNCTION pos_security.lifecycle_write_allowed(p_table text,p_op text,p_old jsonb,p_new jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF pos_security.payment_date_write_allowed(p_table,p_op,p_old,p_new) IS TRUE THEN RETURN true; END IF;
  RETURN pos_security.lifecycle_write_allowed_before_payment_dates(p_table,p_op,p_old,p_new);
END $$;
REVOKE ALL ON FUNCTION pos_security.payment_date_write_allowed(text,text,jsonb,jsonb),
  pos_security.lifecycle_write_allowed(text,text,jsonb,jsonb),
  pos_security.lifecycle_write_allowed_before_payment_dates(text,text,jsonb,jsonb)
  FROM PUBLIC,anon,authenticated,service_role;

-- The binding trigger normally fills legacy NULL metadata. Timestamp-only
-- operations must preserve it. Admit only an exact private date capability;
-- correction RPCs validate the locked parent bindings before opening it.
-- All other receipt/binding changes still run the original guard.
DO $migration$
DECLARE definition text:=pg_get_functiondef('pos_security.business_invoice_guard()'::regprocedure);
  anchor text:='  -- Cross-table invoice uniqueness needs a common lock and fresh snapshots.';
  addition text:=$body$  IF TG_TABLE_NAME='debt_payments' AND TG_OP='UPDATE'
    AND pos_security.payment_date_write_allowed(TG_TABLE_NAME,TG_OP,to_jsonb(OLD),to_jsonb(NEW)) IS TRUE THEN
    RETURN NEW;
  END IF;
$body$;
BEGIN
  IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 THEN
    RAISE EXCEPTION 'Unrecognized invoice binding guard';
  END IF;
  EXECUTE replace(definition,anchor,addition||anchor);
END $migration$;

-- No default-now backfill: that would falsely date old receipts to migration day.
DO $$ DECLARE p public.debt_payments; BEGIN
  IF EXISTS(SELECT 1 FROM public.debt_payments WHERE paid_at IS NULL OR NOT isfinite(paid_at)) THEN
    RAISE EXCEPTION 'Payment timestamp missing: reconcile historical paid_at before installing payment dates' USING ERRCODE='55000';
  END IF;
  FOR p IN SELECT * FROM public.debt_payments ORDER BY id FOR UPDATE LOOP
    INSERT INTO pos_security.payment_date_write_context(transaction_id,payment_id,invoice_no,old_paid_at,backfill)
      VALUES(txid_current(),p.id,p.invoice_no,p.paid_at,true);
    UPDATE public.debt_payments SET recorded_at=p.paid_at WHERE id=p.id;
    IF NOT EXISTS(SELECT 1 FROM public.debt_payments x WHERE x.id=p.id
      AND to_jsonb(x)=jsonb_set(to_jsonb(p),'{recorded_at}',to_jsonb(p.paid_at))) THEN
      RAISE EXCEPTION 'Payment timestamp backfill verification failed' USING ERRCODE='23514';
    END IF;
    DELETE FROM pos_security.payment_date_write_context WHERE transaction_id=txid_current();
  END LOOP;
  IF EXISTS(SELECT 1 FROM pos_security.payment_events e LEFT JOIN public.debt_payments r ON r.id=e.payment_id
    WHERE r.id IS NULL OR r.paid_at IS DISTINCT FROM e.received_at) THEN
    RAISE EXCEPTION 'Receipt/event timestamp mismatch: reconcile before installing payment dates' USING ERRCODE='23514';
  END IF;
  UPDATE pos_security.payment_events e SET effective_at=r.paid_at FROM public.debt_payments r WHERE r.id=e.payment_id;
  IF EXISTS(SELECT 1 FROM pos_security.payment_events e JOIN public.debt_payments r ON r.id=e.payment_id
    WHERE e.effective_at IS DISTINCT FROM r.paid_at) THEN
    RAISE EXCEPTION 'Event timestamp backfill verification failed' USING ERRCODE='23514';
  END IF;
END $$;
ALTER TABLE public.debt_payments ALTER COLUMN recorded_at SET DEFAULT clock_timestamp(), ALTER COLUMN recorded_at SET NOT NULL;
ALTER TABLE pos_security.payment_events ALTER COLUMN effective_at SET NOT NULL;

CREATE FUNCTION pos_security.payment_recorded_at_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.recorded_at IS DISTINCT FROM OLD.recorded_at THEN
    RAISE EXCEPTION 'Payment recording timestamp is immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "03_payment_recorded_at_guard" BEFORE UPDATE ON public.debt_payments
  FOR EACH ROW EXECUTE FUNCTION pos_security.payment_recorded_at_guard();
REVOKE ALL ON FUNCTION pos_security.payment_recorded_at_guard() FROM PUBLIC,anon,authenticated,service_role;

-- These legacy SQL aggregates cast timestamptz to date. Fix their execution
-- timezone explicitly, including direct internal invocations and every source.
ALTER FUNCTION pos_security.acc_dashboard(date,date) SET timezone = 'Asia/Jakarta';
ALTER FUNCTION pos_security.acc_summary(date,date) SET timezone = 'Asia/Jakarta';
ALTER FUNCTION pos_security.acc_recap_admin(date,date) SET timezone = 'Asia/Jakarta';

-- Retain the complete existing receipt validator, changing only the precision
-- of the invoice/payment ordering rule. Fail closed on an unfamiliar definition.
DO $migration$
DECLARE definition text:=pg_get_functiondef('pos_security.invoice_verify_original_receipts(uuid,uuid)'::regprocedure);
  old_check text:='p.paid_at>=t.created_at';
  new_check text:='(p.paid_at AT TIME ZONE ''Asia/Jakarta'')::date >= (t.created_at AT TIME ZONE ''Asia/Jakarta'')::date';
BEGIN
  IF (length(definition)-length(replace(definition,old_check,'')))/length(old_check)<>1 THEN
    RAISE EXCEPTION 'Unrecognized original receipt date validator';
  END IF;
  EXECUTE replace(definition,old_check,new_check);
END $migration$;

CREATE FUNCTION pos_security.record_payment_with_date(
  p_operation_id uuid,p_invoice_no text,p_amount numeric,p_method text,p_notes text,p_payment_date date,p_dated boolean
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  actor record; op pos_security.payment_operations; b pos_security.payment_baselines;
  t public.transactions; d public.debts; candidate_debt public.debts; c public.customers;
  invoice text := btrim(p_invoice_no); v_method text := lower(btrim(p_method)); v_notes text := coalesce(p_notes,''); fingerprint text;
  has_order boolean; debt_count integer := 0; allowed boolean := false;
  v_total numeric; paid_before numeric; remaining_before numeric; paid_after numeric; remaining_after numeric;
  receipt jsonb; payment uuid := gen_random_uuid(); received timestamptz; effective timestamptz; cash_code text; n integer; valid boolean;
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
  IF p_dated AND (p_payment_date IS NULL OR NOT isfinite(p_payment_date)
    OR p_payment_date<DATE '1900-01-01'
    OR p_payment_date>(clock_timestamp() AT TIME ZONE 'Asia/Jakarta')::date) THEN
    RAISE EXCEPTION 'invalid payment day' USING ERRCODE='22023';
  END IF;
  fingerprint := encode(sha256(convert_to((jsonb_build_object('invoice_no',invoice,'amount',trim_scale(p_amount),
    'method',v_method,'notes',v_notes) || CASE WHEN p_dated THEN jsonb_build_object('payment_date',to_char(p_payment_date,'YYYY-MM-DD'))
      ELSE '{}'::jsonb END)::text,'UTF8')),'hex');
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
    IF p_dated AND (t.created_at IS NULL OR p_payment_date<(t.created_at AT TIME ZONE 'Asia/Jakarta')::date) THEN
      RAISE EXCEPTION 'payment day cannot precede invoice day' USING ERRCODE='22023';
    END IF;
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
  received := clock_timestamp();
  effective := CASE WHEN p_dated THEN p_payment_date::timestamp AT TIME ZONE 'Asia/Jakarta' ELSE received END;
  cash_code := public.acc_cash_code(v_method);
  INSERT INTO pos_security.payment_write_context VALUES (txid_current(),invoice,payment,paid_after,remaining_after);
  IF has_order THEN
    UPDATE public.transactions SET paid=paid_after,remaining=remaining_after,
      status=CASE WHEN remaining_after=0 THEN 'lunas' ELSE 'pending' END WHERE id=t.id;
    IF NOT FOUND THEN RAISE EXCEPTION 'order update failed' USING ERRCODE='23514'; END IF;
  END IF;
  UPDATE public.debts SET paid=paid_after,remaining=remaining_after,status=CASE WHEN remaining_after=0 THEN 'lunas' ELSE 'aktif' END WHERE id=d.id;
  IF NOT FOUND THEN RAISE EXCEPTION 'debt update failed' USING ERRCODE='23514'; END IF;
  INSERT INTO pos_security.payment_events(payment_id,operation_id,invoice_no,amount,method,received_at,effective_at,actor_auth_user_id,cashier_id)
    VALUES (payment,p_operation_id,invoice,p_amount,v_method,received,effective,actor.auth_user_id,actor.id);
  IF NOT FOUND THEN RAISE EXCEPTION 'event insertion failed' USING ERRCODE='23514'; END IF;
  INSERT INTO public.debt_payments(id,debt_id,amount,payment_method,notes,paid_at,recorded_at,cashier,cashier_id,invoice_no,cashier_name,customer_id,customer_name,book_id)
    VALUES (payment,d.id,p_amount,v_method,v_notes,effective,received,actor.name,actor.id,invoice,actor.name,c.id,c.name,c.book_id);
  IF NOT FOUND THEN RAISE EXCEPTION 'receipt insertion failed' USING ERRCODE='23514'; END IF;
  INSERT INTO public.accounting_entries(entry_date,source_type,source_id,invoice_no,account_code,debit,credit,description,cashier_id)
    VALUES ((effective AT TIME ZONE 'Asia/Jakarta')::date,'debt_payment',payment,invoice,cash_code,p_amount,0,'Receivable payment',actor.id),
      ((effective AT TIME ZONE 'Asia/Jakarta')::date,'debt_payment',payment,invoice,'1200',0,p_amount,'Receivable payment',actor.id);
  INSERT INTO public.cash_movements(moved_at,direction,method,amount,source_type,source_id,invoice_no,note,cashier_id)
    VALUES (effective,'in',v_method,p_amount,'debt_payment',payment,invoice,'Receivable payment',actor.id);
  SELECT count(*),bool_and((e.source_type='debt_payment' AND e.invoice_no=invoice AND e.cashier_id=actor.id
    AND e.entry_date=(effective AT TIME ZONE 'Asia/Jakarta')::date
    AND ((e.account_code=cash_code AND e.debit=p_amount AND e.credit=0) OR (e.account_code='1200' AND e.debit=0 AND e.credit=p_amount))) IS TRUE)
    INTO n,valid FROM public.accounting_entries e WHERE e.source_id=payment;
  IF n<>2 OR valid IS NOT TRUE OR (SELECT count(DISTINCT account_code) FROM public.accounting_entries WHERE source_id=payment)<>2 THEN
    RAISE EXCEPTION 'receipt journal verification failed' USING ERRCODE='23514'; END IF;
  SELECT count(*),bool_and((m.source_type='debt_payment' AND m.invoice_no=invoice AND m.cashier_id=actor.id
    AND m.moved_at=effective AND m.direction='in' AND m.method=v_method AND m.amount=p_amount) IS TRUE)
    INTO n,valid FROM public.cash_movements m WHERE m.source_id=payment;
  IF n<>1 OR valid IS NOT TRUE THEN RAISE EXCEPTION 'cash receipt verification failed' USING ERRCODE='23514'; END IF;
  -- Check stored rows, not only row counts: another BEFORE trigger may return a
  -- modified NEW row without raising. Any divergence aborts the entire receipt.
  IF NOT EXISTS (SELECT 1 FROM public.debt_payments p WHERE p.id=payment AND p.debt_id=d.id
      AND p.invoice_no=invoice AND p.amount=p_amount AND p.payment_method=v_method AND p.paid_at=effective AND p.recorded_at=received
      AND p.cashier_id=actor.id AND p.customer_id=c.id AND p.book_id IS NOT DISTINCT FROM c.book_id
      AND p.notes=v_notes AND p.deleted_at IS NULL)
    OR NOT EXISTS (SELECT 1 FROM pos_security.payment_events e WHERE e.payment_id=payment AND e.operation_id=p_operation_id
      AND e.invoice_no=invoice AND e.amount=p_amount AND e.method=v_method AND e.received_at=received AND e.effective_at=effective
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

CREATE OR REPLACE FUNCTION public.pos_record_payment(
  p_operation_id uuid,p_invoice_no text,p_amount numeric,p_method text,p_notes text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  RETURN pos_security.record_payment_with_date(p_operation_id,p_invoice_no,p_amount,p_method,p_notes,NULL,false);
END $$;

CREATE FUNCTION public.pos_submit_payment_dated(
  p_operation_id uuid,p_invoice_no text,p_amount numeric,p_method text,p_notes text,p_payment_date date
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE receipt jsonb; request jsonb; saved pos_security.payment_client_receipts; status jsonb;
BEGIN
  receipt:=pos_security.record_payment_with_date(p_operation_id,p_invoice_no,p_amount,p_method,p_notes,p_payment_date,true);
  request:=jsonb_build_object('invoiceNo',btrim(p_invoice_no),'amount',p_amount,
    'method',lower(btrim(p_method)),'notes',coalesce(p_notes,''),'paymentDate',to_char(p_payment_date,'YYYY-MM-DD'));
  INSERT INTO pos_security.payment_client_receipts(operation_id,request,result)
    VALUES(p_operation_id,request,receipt) ON CONFLICT DO NOTHING;
  SELECT * INTO saved FROM pos_security.payment_client_receipts WHERE operation_id=p_operation_id;
  IF NOT FOUND OR saved.request IS DISTINCT FROM request OR saved.result IS DISTINCT FROM receipt THEN
    RAISE EXCEPTION 'payment recovery evidence mismatch' USING ERRCODE='23514';
  END IF;
  status:=public.pos_payment_status(p_operation_id);
  IF status->>'state' IS DISTINCT FROM 'complete' THEN
    RAISE EXCEPTION 'payment recovery unavailable' USING ERRCODE='23514';
  END IF;
  RETURN status;
END $$;

CREATE FUNCTION pos_security.payment_date_check(p public.debt_payments) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE n integer; valid boolean; cash_code text:=public.acc_cash_code(p.payment_method); e pos_security.payment_events;
  b pos_security.payment_baselines; s pos_security.invoice_states;
  expected_paid numeric; expected_total numeric; expected_remaining numeric; refund_account text;
BEGIN
  SELECT * INTO b FROM pos_security.payment_baselines WHERE invoice_no=p.invoice_no;
  IF FOUND THEN
    expected_paid:=pos_security.lifecycle_payment_paid(b.invoice_no,b.initial_paid+
      coalesce((SELECT sum(amount) FROM pos_security.payment_events WHERE invoice_no=b.invoice_no),0));
    expected_total:=pos_security.lifecycle_payment_total(b.invoice_no,b.total);
    expected_remaining:=expected_total-expected_paid;
    SELECT * INTO s FROM pos_security.invoice_states WHERE order_id=b.order_id;
    IF s.order_id IS NOT NULL THEN
      -- A reduced active invoice can retain cash above its new total until a
      -- refund is paid. Clamp receivables only with matching refund evidence.
      expected_remaining:=greatest(expected_remaining,0);
      IF s.invoice_no IS DISTINCT FROM b.invoice_no OR s.state IS DISTINCT FROM 'active'
        OR s.refund_due IS DISTINCT FROM greatest(expected_paid-expected_total,0)
        OR s.refunded<0 OR s.refunded<>trunc(s.refunded) OR s.refunded::text IN ('NaN','Infinity','-Infinity') THEN
        RAISE EXCEPTION 'Payment refund state mismatch: reconcile with owner first' USING ERRCODE='23514';
      END IF;
      SELECT config.refund_account INTO refund_account FROM pos_security.invoice_account_config config WHERE singleton;
      IF refund_account IS NULL THEN
        RAISE EXCEPTION 'Payment refund account missing: reconcile with owner first' USING ERRCODE='23514';
      END IF;
      PERFORM pos_security.invoice_verify_ledger(s.order_id,expected_total,expected_remaining,expected_paid,s.refund_due,refund_account);
    END IF;
    IF expected_paid<0 OR expected_remaining<0 OR b.debt_id IS DISTINCT FROM p.debt_id
      OR NOT EXISTS(SELECT 1 FROM public.debts d WHERE d.id=b.debt_id AND d.paid=expected_paid
        AND d.total_debt=expected_total AND d.remaining=expected_remaining)
      OR (b.order_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.transactions t WHERE t.id=b.order_id
        AND t.paid=expected_paid AND t.total=expected_total AND t.remaining=expected_remaining)) THEN
      RAISE EXCEPTION 'Payment ledger balance mismatch: reconcile with owner first' USING ERRCODE='23514';
    END IF;
  END IF;
  SELECT count(*),bool_and((j.source_type='debt_payment' AND j.invoice_no=p.invoice_no
    AND j.cashier_id IS NOT DISTINCT FROM p.cashier_id
    AND j.entry_date=(p.paid_at AT TIME ZONE 'Asia/Jakarta')::date
    AND ((j.account_code=cash_code AND j.debit=p.amount AND j.credit=0)
      OR (j.account_code='1200' AND j.debit=0 AND j.credit=p.amount))) IS TRUE)
    INTO n,valid FROM public.accounting_entries j WHERE j.source_id=p.id;
  IF n<>2 OR valid IS NOT TRUE OR (SELECT count(DISTINCT account_code) FROM public.accounting_entries WHERE source_id=p.id)<>2 THEN
    RAISE EXCEPTION 'Payment date cannot change: reconcile missing or inconsistent separate receipt postings with owner first' USING ERRCODE='55000';
  END IF;
  SELECT count(*),bool_and((m.source_type='debt_payment' AND m.invoice_no=p.invoice_no
    AND m.cashier_id IS NOT DISTINCT FROM p.cashier_id AND m.moved_at=p.paid_at
    AND m.direction='in' AND m.method=p.payment_method AND m.amount=p.amount) IS TRUE)
    INTO n,valid FROM public.cash_movements m WHERE m.source_id=p.id;
  IF n<>1 OR valid IS NOT TRUE THEN
    RAISE EXCEPTION 'Payment date cannot change: reconcile missing or inconsistent separate cash postings with owner first' USING ERRCODE='55000';
  END IF;
  SELECT * INTO e FROM pos_security.payment_events WHERE payment_id=p.id;
  IF FOUND AND (e.invoice_no IS DISTINCT FROM p.invoice_no OR e.amount IS DISTINCT FROM p.amount
    OR e.method IS DISTINCT FROM p.payment_method OR e.cashier_id IS DISTINCT FROM p.cashier_id
    OR e.received_at IS DISTINCT FROM p.recorded_at OR e.effective_at IS DISTINCT FROM p.paid_at
    OR NOT EXISTS(SELECT 1 FROM pos_security.payment_operations o WHERE o.operation_id=e.operation_id
      AND o.payment_id=p.id AND o.debt_id=p.debt_id AND o.actor_auth_user_id=e.actor_auth_user_id
      AND o.result IS NOT NULL)) THEN
    RAISE EXCEPTION 'Payment event evidence mismatch: reconcile with owner first' USING ERRCODE='23514';
  END IF;
END $$;

CREATE FUNCTION public.pos_change_payment_date(
  p_operation_id uuid,p_payment_id uuid,p_expected_paid_at timestamptz,p_payment_date date,p_reason text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
<<date_change>>
DECLARE actor record; p public.debt_payments; d public.debts; t public.transactions; c public.customers;
  op pos_security.payment_date_operations; before_event jsonb; before_journal jsonb; before_cash jsonb;
  after_rows jsonb; expected_rows jsonb; new_paid timestamptz; fingerprint text; result jsonb;
  reason text:=btrim(p_reason); changed timestamptz; invoice text; n integer;
BEGIN
  SELECT * INTO actor FROM public.pos_current_profile();
  IF actor.id IS NULL THEN RAISE EXCEPTION 'Payment date change denied' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM pos_security.user_access WHERE auth_user_id=actor.auth_user_id FOR SHARE;
  SELECT * INTO actor FROM public.pos_current_profile();
  IF actor.id IS NULL THEN RAISE EXCEPTION 'Payment date change denied' USING ERRCODE='42501'; END IF;
  IF p_operation_id IS NULL OR p_payment_id IS NULL OR p_expected_paid_at IS NULL OR NOT isfinite(p_expected_paid_at)
    OR p_payment_date IS NULL OR NOT isfinite(p_payment_date)
    OR p_payment_date<DATE '1900-01-01'
    OR p_payment_date>(clock_timestamp() AT TIME ZONE 'Asia/Jakarta')::date
    OR reason IS NULL OR length(reason) NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'Invalid payment date correction request' USING ERRCODE='22023';
  END IF;
  IF current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION 'Payment date correction requires read committed' USING ERRCODE='25000';
  END IF;
  fingerprint:=encode(sha256(convert_to(jsonb_build_object('payment_id',p_payment_id,
    'expected_paid_at',extract(epoch FROM p_expected_paid_at),'payment_date',to_char(p_payment_date,'YYYY-MM-DD'),
    'reason',reason)::text,'UTF8')),'hex');
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('pos-payment-date-operation:'||p_operation_id::text,0));
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('skupy:business-invoice-binding:v1',0));
  SELECT invoice_no INTO invoice FROM public.debt_payments WHERE id=p_payment_id;
  IF NOT FOUND OR invoice IS NULL THEN RAISE EXCEPTION 'Payment date change denied' USING ERRCODE='42501'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('pos-payment:'||invoice,0));
  SELECT * INTO t FROM public.transactions WHERE invoice_no=invoice FOR UPDATE;
  SELECT x.* INTO d FROM public.debts x JOIN public.debt_payments y ON y.debt_id=x.id WHERE y.id=p_payment_id FOR UPDATE OF x;
  SELECT * INTO c FROM public.customers WHERE id=d.customer_id FOR UPDATE;
  SELECT * INTO p FROM public.debt_payments WHERE id=p_payment_id FOR UPDATE;
  -- Match collection scope, not attribution: a book-authorized invoice operator
  -- or the customer's PIC may correct a receipt entered by another cashier.
  IF p.id IS NULL OR d.id IS NULL OR c.id IS NULL OR pos_security.business_book(d.book_id) IS NOT TRUE
    OR (pos_security.business_debt(d.id) OR (t.id IS NOT NULL AND pos_security.business_order(t.id))) IS NOT TRUE THEN
    RAISE EXCEPTION 'Payment date change denied' USING ERRCODE='42501';
  END IF;
  IF p.invoice_no IS DISTINCT FROM invoice OR p.invoice_no IS DISTINCT FROM d.invoice_no
    OR (p.book_id IS NOT NULL AND p.book_id IS DISTINCT FROM d.book_id)
    OR (p.customer_id IS NOT NULL AND p.customer_id IS DISTINCT FROM d.customer_id)
    OR c.book_id IS DISTINCT FROM d.book_id
    OR (t.id IS NOT NULL AND (d.transaction_id IS DISTINCT FROM t.id OR t.customer_id IS DISTINCT FROM d.customer_id
      OR t.book_id IS DISTINCT FROM d.book_id)) OR (t.id IS NULL AND (d.transaction_id IS NOT NULL OR d.is_opening IS DISTINCT FROM true)) THEN
    RAISE EXCEPTION 'Payment binding mismatch: reconcile with owner first' USING ERRCODE='23514';
  END IF;
  SELECT * INTO op FROM pos_security.payment_date_operations WHERE operation_id=p_operation_id;
  IF FOUND THEN
    IF op.actor_auth_user_id IS DISTINCT FROM actor.auth_user_id THEN
      RAISE EXCEPTION 'Payment date operation denied' USING ERRCODE='42501';
    END IF;
    IF op.request_fingerprint IS DISTINCT FROM fingerprint THEN
      RAISE EXCEPTION 'Payment date operation request changed' USING ERRCODE='22023';
    END IF;
    RETURN op.result;
  END IF;
  IF p.deleted_at IS NOT NULL OR d.deleted_at IS NOT NULL OR c.deleted_at IS NOT NULL
    OR (t.id IS NOT NULL AND (t.deleted_at IS NOT NULL
      OR lower(btrim(coalesce(t.order_status,''))) IN ('dibatalkan','cancelled','canceled')
      OR lower(btrim(coalesce(t.status,''))) IN ('dibatalkan','cancelled','canceled'))) THEN
    RAISE EXCEPTION 'Inactive invoice: review payment date correction with owner first' USING ERRCODE='55000';
  END IF;
  IF t.id IS NOT NULL AND (t.created_at IS NULL OR p_payment_date<(t.created_at AT TIME ZONE 'Asia/Jakarta')::date) THEN
    RAISE EXCEPTION 'Payment day cannot precede invoice day' USING ERRCODE='22023';
  END IF;
  IF p.paid_at IS DISTINCT FROM p_expected_paid_at THEN
    RAISE EXCEPTION 'Payment date changed: reload payment history before correcting' USING ERRCODE='40001';
  END IF;
  IF p.amount IS NULL OR p.amount<=0 OR p.amount<>trunc(p.amount) OR p.amount::text IN ('NaN','Infinity','-Infinity')
    OR p.payment_method IS NULL OR p.payment_method NOT IN ('cash','transfer','qris')
    OR p.paid_at IS NULL OR NOT isfinite(p.paid_at) OR p.recorded_at IS NULL OR NOT isfinite(p.recorded_at) THEN
    RAISE EXCEPTION 'Invalid receipt: reconcile with owner first' USING ERRCODE='23514';
  END IF;
  PERFORM pos_security.payment_date_check(p);
  new_paid:=CASE WHEN (p.paid_at AT TIME ZONE 'Asia/Jakarta')::date=p_payment_date THEN p.paid_at
    ELSE p_payment_date::timestamp AT TIME ZONE 'Asia/Jakarta' END;
  SELECT to_jsonb(e) INTO before_event FROM pos_security.payment_events e WHERE payment_id=p.id FOR UPDATE;
  SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) INTO before_journal FROM public.accounting_entries e WHERE source_id=p.id;
  SELECT jsonb_agg(to_jsonb(m) ORDER BY m.id) INTO before_cash FROM public.cash_movements m WHERE source_id=p.id;
  INSERT INTO pos_security.payment_date_write_context(transaction_id,payment_id,invoice_no,old_paid_at,new_paid_at)
    VALUES(txid_current(),p.id,p.invoice_no,p.paid_at,new_paid);
  UPDATE public.debt_payments SET paid_at=new_paid WHERE id=p.id;
  GET DIAGNOSTICS n=ROW_COUNT;
  IF n<>1 THEN RAISE EXCEPTION 'Receipt date update failed' USING ERRCODE='23514'; END IF;
  IF before_event IS NOT NULL THEN
    UPDATE pos_security.payment_events SET effective_at=new_paid WHERE payment_id=p.id;
    GET DIAGNOSTICS n=ROW_COUNT;
    IF n<>1 OR (SELECT to_jsonb(e) FROM pos_security.payment_events e WHERE payment_id=p.id)
      IS DISTINCT FROM jsonb_set(before_event,'{effective_at}',to_jsonb(new_paid)) THEN
      RAISE EXCEPTION 'Event date update failed' USING ERRCODE='23514';
    END IF;
  END IF;
  UPDATE public.accounting_entries SET entry_date=(new_paid AT TIME ZONE 'Asia/Jakarta')::date WHERE source_id=p.id;
  GET DIAGNOSTICS n=ROW_COUNT;
  IF n<>2 THEN RAISE EXCEPTION 'Journal date update failed' USING ERRCODE='23514'; END IF;
  UPDATE public.cash_movements SET moved_at=new_paid WHERE source_id=p.id;
  GET DIAGNOSTICS n=ROW_COUNT;
  IF n<>1 THEN RAISE EXCEPTION 'Cash date update failed' USING ERRCODE='23514'; END IF;
  IF (SELECT to_jsonb(x) FROM public.debt_payments x WHERE id=p.id)
    IS DISTINCT FROM jsonb_set(to_jsonb(p),'{paid_at}',to_jsonb(new_paid)) THEN
    RAISE EXCEPTION 'Stored receipt date verification failed' USING ERRCODE='23514';
  END IF;
  SELECT jsonb_agg(jsonb_set(x,'{entry_date}',to_jsonb((new_paid AT TIME ZONE 'Asia/Jakarta')::date)) ORDER BY x->>'id')
    INTO expected_rows FROM jsonb_array_elements(before_journal) x;
  SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) INTO after_rows FROM public.accounting_entries e WHERE source_id=p.id;
  IF after_rows IS DISTINCT FROM expected_rows THEN RAISE EXCEPTION 'Stored journal date verification failed' USING ERRCODE='23514'; END IF;
  SELECT jsonb_agg(jsonb_set(x,'{moved_at}',to_jsonb(new_paid)) ORDER BY x->>'id')
    INTO expected_rows FROM jsonb_array_elements(before_cash) x;
  SELECT jsonb_agg(to_jsonb(m) ORDER BY m.id) INTO after_rows FROM public.cash_movements m WHERE source_id=p.id;
  IF after_rows IS DISTINCT FROM expected_rows THEN RAISE EXCEPTION 'Stored cash date verification failed' USING ERRCODE='23514'; END IF;
  result:=jsonb_build_object('payment_id',p.id,'paid_at',new_paid,'recorded_at',p.recorded_at);
  changed:=clock_timestamp();
  INSERT INTO pos_security.payment_date_operations(operation_id,payment_id,actor_auth_user_id,request_fingerprint,reason,
    old_paid_at,new_paid_at,recorded_at,changed_at,result)
    VALUES(p_operation_id,p.id,actor.auth_user_id,fingerprint,reason,p.paid_at,new_paid,p.recorded_at,changed,result);
  IF NOT EXISTS(SELECT 1 FROM pos_security.payment_date_operations x WHERE x.operation_id=p_operation_id
    AND x.payment_id=p.id AND x.actor_auth_user_id=actor.auth_user_id AND x.request_fingerprint=fingerprint
    AND x.reason=date_change.reason AND x.old_paid_at=p.paid_at AND x.new_paid_at=new_paid AND x.recorded_at=p.recorded_at
    AND x.changed_at=changed AND x.result=date_change.result) THEN
    RAISE EXCEPTION 'Payment date audit verification failed' USING ERRCODE='23514';
  END IF;
  DELETE FROM pos_security.payment_date_write_context WHERE transaction_id=txid_current();
  RETURN result;
END $$;

REVOKE ALL ON FUNCTION pos_security.record_payment_with_date(uuid,text,numeric,text,text,date,boolean),
  pos_security.payment_date_check(public.debt_payments),public.pos_record_payment(uuid,text,numeric,text,text),
  public.pos_submit_payment_dated(uuid,text,numeric,text,text,date),
  public.pos_change_payment_date(uuid,uuid,timestamptz,date,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.pos_record_payment(uuid,text,numeric,text,text),
  public.pos_submit_payment_dated(uuid,text,numeric,text,text,date),
  public.pos_change_payment_date(uuid,uuid,timestamptz,date,text) TO authenticated;
COMMIT;
