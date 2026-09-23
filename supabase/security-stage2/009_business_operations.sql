-- CANDIDATE ONLY, outside automatic migrations; requires business schema + 001-006.
-- Does not replace 006, modify identity authority, or touch Storage.
BEGIN;
SET LOCAL search_path = '';

CREATE TABLE pos_security.payment_operations (
  operation_id uuid PRIMARY KEY,
  actor_auth_user_id uuid NOT NULL,
  request_fingerprint text NOT NULL CHECK (length(request_fingerprint)=64),
  payment_id uuid UNIQUE,
  debt_id uuid,
  order_id uuid,
  result jsonb CHECK (jsonb_typeof(result)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz
);
ALTER TABLE pos_security.payment_operations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pos_security.payment_operations FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.pos_record_payment(
  p_operation_id uuid,p_invoice_no text,p_amount numeric,p_method text,p_notes text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  actor record; op pos_security.payment_operations;
  t public.transactions; d public.debts; candidate_debt public.debts; c public.customers;
  invoice text := btrim(p_invoice_no); method text := lower(btrim(p_method));
  notes text := coalesce(p_notes,''); fingerprint text;
  has_order boolean; debt_count integer := 0; allowed boolean := false;
  total numeric; paid_before numeric; remaining_before numeric; paid_after numeric; remaining_after numeric;
  receipt jsonb; payment uuid := gen_random_uuid(); cash_code text; posted record; movement record;
BEGIN
  SELECT * INTO actor FROM public.pos_current_profile();
  IF actor.id IS NULL THEN RAISE EXCEPTION 'payment denied' USING ERRCODE='42501'; END IF;
  -- Serialize against mapping deactivation/reset and the book replacement RPC.
  PERFORM 1 FROM pos_security.user_access a WHERE a.auth_user_id=actor.auth_user_id FOR SHARE;
  SELECT * INTO actor FROM public.pos_current_profile();
  IF actor.id IS NULL THEN RAISE EXCEPTION 'payment denied' USING ERRCODE='42501'; END IF;
  IF p_operation_id IS NULL OR invoice IS NULL OR invoice='' OR length(invoice)>256
    OR p_amount IS NULL OR p_amount::text IN ('NaN','Infinity','-Infinity')
    OR p_amount<=0 OR p_amount<>trunc(p_amount)
    OR method IS NULL OR method NOT IN ('cash','transfer','qris') OR length(notes)>4000 THEN
    RAISE EXCEPTION 'invalid payment request' USING ERRCODE='22023';
  END IF;
  fingerprint := encode(sha256(convert_to(jsonb_build_object(
    'invoice_no',invoice,'amount',trim_scale(p_amount),'method',method,'notes',notes)::text,'UTF8')),'hex');
  -- Reservation and receipt commit with the money changes; failed calls leave no row.
  INSERT INTO pos_security.payment_operations(operation_id,actor_auth_user_id,request_fingerprint)
    VALUES (p_operation_id,actor.auth_user_id,fingerprint) ON CONFLICT DO NOTHING;
  SELECT * INTO STRICT op FROM pos_security.payment_operations WHERE operation_id=p_operation_id FOR UPDATE;
  IF op.actor_auth_user_id<>actor.auth_user_id THEN RAISE EXCEPTION 'operation denied' USING ERRCODE='42501'; END IF;
  IF op.request_fingerprint<>fingerprint THEN RAISE EXCEPTION 'operation request changed' USING ERRCODE='22023'; END IF;
  IF op.result IS NOT NULL THEN RETURN op.result; END IF;

  IF current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION 'payment requires read committed isolation' USING ERRCODE='25000';
  END IF;
  -- Coordinate with 006's cross-table binding guard BEFORE taking order/debt locks.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('skupy:business-invoice-binding:v1',0));
  -- Invoice lock covers the absent-debt case; row order is always order then debts.
  -- Hash collisions merely serialize unrelated invoices; they do not grant access.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('pos-payment:'||invoice,0));
  SELECT * INTO t FROM public.transactions WHERE invoice_no=invoice FOR UPDATE;
  has_order := FOUND;
  FOR candidate_debt IN SELECT * FROM public.debts
    WHERE invoice_no=invoice OR (has_order AND transaction_id=t.id) ORDER BY id FOR UPDATE LOOP
    debt_count := debt_count+1;
    d := candidate_debt;
    allowed := allowed OR pos_security.business_debt(d.id);
  END LOOP;
  IF has_order THEN
    allowed := pos_security.business_order(t.id) OR
      (pos_security.business_customer(t.customer_id) AND pos_security.business_book(t.book_id));
  END IF;
  IF NOT allowed THEN RAISE EXCEPTION 'payment denied' USING ERRCODE='42501'; END IF;
  IF debt_count>1 THEN RAISE EXCEPTION 'ambiguous invoice debt' USING ERRCODE='22023'; END IF;
  IF has_order THEN
    IF t.deleted_at IS NOT NULL OR coalesce(t.order_status,'') IN ('dibatalkan','cancelled','canceled')
      OR coalesce(t.status,'') IN ('dibatalkan','cancelled','canceled') OR t.customer_id IS NULL THEN
      RAISE EXCEPTION 'order cannot receive payment' USING ERRCODE='22023';
    END IF;
    -- The legacy sale trigger reposts cumulative paid under the original tender.
    -- Do not accept cash/bank crossings until allocation has a reviewed contract.
    -- acc_cash_code('hutang') = '1000': only cash receipts are supported there.
    IF public.acc_cash_code(method)<>public.acc_cash_code(t.payment_method) THEN
      RAISE EXCEPTION 'mixed cash/bank tender unsupported' USING ERRCODE='22023';
    END IF;
    IF debt_count=1 AND (d.transaction_id IS DISTINCT FROM t.id OR d.customer_id IS DISTINCT FROM t.customer_id
      OR d.book_id IS DISTINCT FROM t.book_id OR d.invoice_no IS DISTINCT FROM t.invoice_no
      OR d.total_debt IS DISTINCT FROM t.total OR d.paid IS DISTINCT FROM t.paid
      OR d.remaining IS DISTINCT FROM t.remaining) THEN
      RAISE EXCEPTION 'order/debt mismatch' USING ERRCODE='22023';
    END IF;
    total := t.total; paid_before := t.paid; remaining_before := t.remaining;
  ELSE
    -- Absence under caller RLS is never consulted. A dangling/hidden link is not opening debt.
    IF debt_count<>1 OR d.transaction_id IS NOT NULL THEN RAISE EXCEPTION 'invalid opening debt' USING ERRCODE='22023'; END IF;
    total := d.total_debt; paid_before := d.paid; remaining_before := d.remaining;
  END IF;
  IF debt_count=1 AND (d.deleted_at IS NOT NULL OR d.status IS DISTINCT FROM 'aktif') THEN
    RAISE EXCEPTION 'debt cannot receive payment' USING ERRCODE='22023';
  END IF;
  IF total IS NULL OR paid_before IS NULL OR remaining_before IS NULL
    OR total::text IN ('NaN','Infinity','-Infinity') OR paid_before::text IN ('NaN','Infinity','-Infinity')
    OR remaining_before::text IN ('NaN','Infinity','-Infinity')
    OR total<>trunc(total) OR paid_before<>trunc(paid_before) OR remaining_before<>trunc(remaining_before)
    OR total<=0 OR paid_before<0 OR paid_before>total OR remaining_before<>total-paid_before
    OR p_amount>remaining_before THEN
    RAISE EXCEPTION 'invalid or insufficient balance' USING ERRCODE='22023';
  END IF;
  SELECT * INTO c FROM public.customers WHERE id=CASE WHEN has_order THEN t.customer_id ELSE d.customer_id END FOR UPDATE;
  IF NOT FOUND OR c.deleted_at IS NOT NULL OR c.book_id IS DISTINCT FROM (CASE WHEN has_order THEN t.book_id ELSE d.book_id END) THEN
    RAISE EXCEPTION 'invalid customer/book link' USING ERRCODE='22023';
  END IF;
  IF c.book_id IS NOT NULL THEN
    PERFORM 1 FROM public.books WHERE id=c.book_id FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'unknown book' USING ERRCODE='22023'; END IF;
  END IF;
  IF NOT pos_security.business_book(c.book_id) OR NOT (
    pos_security.business_manager() OR pos_security.business_customer(c.id)
    OR (has_order AND pos_security.business_order(t.id))) THEN
    RAISE EXCEPTION 'payment denied' USING ERRCODE='42501';
  END IF;

  IF has_order AND debt_count=0 THEN
    INSERT INTO public.debts(customer_id,transaction_id,invoice_no,total_debt,paid,remaining,due_date,status,
      cashier_id,cashier_name,customer_name,customer_phone,book_id,is_opening)
    VALUES (c.id,t.id,t.invoice_no,total,paid_before,remaining_before,t.due_date,'aktif',t.cashier_id,
      coalesce(t.cashier_name,t.cashier),c.name,c.phone,t.book_id,false) RETURNING * INTO d;
  END IF;
  paid_after := paid_before+p_amount; remaining_after := total-paid_after;
  IF has_order THEN
    -- Preserve initial DP and sale tender. The existing sale trigger reposts cumulative paid.
    UPDATE public.transactions SET paid=paid_after,remaining=remaining_after,
      status=CASE WHEN remaining_after=0 THEN 'lunas' ELSE 'pending' END WHERE id=t.id;
  END IF;
  UPDATE public.debts SET paid=paid_after,remaining=remaining_after,
    status=CASE WHEN remaining_after=0 THEN 'lunas' ELSE 'aktif' END WHERE id=d.id;
  INSERT INTO public.debt_payments(id,debt_id,amount,payment_method,notes,paid_at,cashier,cashier_id,
    invoice_no,cashier_name,customer_id,customer_name,book_id)
  VALUES (payment,d.id,p_amount,method,notes,clock_timestamp(),actor.name,actor.id,
    invoice,actor.name,c.id,c.name,c.book_id);

  IF has_order THEN
    -- Legacy posting functions catch errors. Validate their exact expected shape
    -- so a swallowed exception rolls back this RPC instead of recording success.
    cash_code := public.acc_cash_code(t.payment_method);
    SELECT count(*) AS n,coalesce(sum(debit),0) AS debits,coalesce(sum(credit),0) AS credits,
      coalesce(sum(debit) FILTER (WHERE account_code=cash_code),0) AS cash,
      coalesce(sum(debit) FILTER (WHERE account_code='1200'),0) AS receivable,
      coalesce(sum(credit) FILTER (WHERE account_code='4000'),0) AS revenue
      INTO posted FROM public.accounting_entries WHERE source_type='sale' AND source_id=t.id;
    SELECT count(*) AS n,coalesce(sum(cm.amount),0) AS amount,
      bool_and(cm.direction='in' AND cm.method=coalesce(t.payment_method,'cash')) AS valid
      INTO movement FROM public.cash_movements cm WHERE cm.source_type='sale' AND cm.source_id=t.id;
    IF posted.n<>(CASE WHEN remaining_after>0 THEN 3 ELSE 2 END) OR posted.debits<>total OR posted.credits<>total
      OR posted.cash<>paid_after OR posted.receivable<>remaining_after OR posted.revenue<>total
      OR movement.n<>1 OR movement.amount<>paid_after OR movement.valid IS NOT TRUE THEN
      RAISE EXCEPTION 'payment journal verification failed' USING ERRCODE='23514';
    END IF;
  ELSE
    -- Opening debts have no order posting trigger. Record only the actual receipt,
    -- not a fabricated opening sale or balance; the operation makes it exactly once.
    cash_code := public.acc_cash_code(method);
    INSERT INTO public.accounting_entries(entry_date,source_type,source_id,invoice_no,account_code,debit,credit,description,cashier_id)
    VALUES (current_date,'debt_payment',payment,invoice,cash_code,p_amount,0,'Receivable payment',actor.id),
      (current_date,'debt_payment',payment,invoice,'1200',0,p_amount,'Receivable payment',actor.id);
    INSERT INTO public.cash_movements(moved_at,direction,method,amount,source_type,source_id,invoice_no,note,cashier_id)
    VALUES (clock_timestamp(),'in',method,p_amount,'debt_payment',payment,invoice,'Receivable payment',actor.id);
  END IF;
  receipt := jsonb_build_object('invoice_no',invoice,'amount',p_amount,'paid',paid_after,'remaining',remaining_after,
    'status',CASE WHEN remaining_after=0 THEN 'lunas' ELSE 'aktif' END);
  UPDATE pos_security.payment_operations SET payment_id=payment,debt_id=d.id,
    order_id=CASE WHEN has_order THEN t.id ELSE NULL END,result=receipt,completed_at=clock_timestamp()
    WHERE operation_id=p_operation_id;
  RETURN receipt;
EXCEPTION WHEN OTHERS THEN
  -- Never expose a definer error's full business row or private operation metadata.
  RAISE EXCEPTION 'payment rejected' USING ERRCODE=SQLSTATE;
END
$$;

-- Keep revisions even if a mapping is removed: never recycle an old expectation.
CREATE TABLE pos_security.admin_book_revisions (
  admin_id uuid PRIMARY KEY,
  version bigint NOT NULL DEFAULT 0 CHECK (version BETWEEN 0 AND 9007199254740991)
);
ALTER TABLE pos_security.admin_book_revisions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pos_security.admin_book_revisions FROM PUBLIC,anon,authenticated,service_role;

-- A versioned setter is ineffective if old clients can mutate the table directly.
REVOKE INSERT,UPDATE,DELETE ON public.admin_book_access FROM PUBLIC,anon,authenticated;
DO $$
DECLARE col text;
BEGIN
  FOR col IN SELECT attname FROM pg_catalog.pg_attribute
    WHERE attrelid='public.admin_book_access'::regclass AND attnum>0 AND NOT attisdropped LOOP
    EXECUTE format('REVOKE INSERT (%1$I),UPDATE (%1$I) ON public.admin_book_access FROM PUBLIC,anon,authenticated',col);
  END LOOP;
END
$$;
DROP FUNCTION IF EXISTS public.pos_set_admin_books(uuid,uuid[]);

CREATE FUNCTION public.pos_admin_book_access(p_admin_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE actor record; target pos_security.user_access; result jsonb;
BEGIN
  SELECT * INTO actor FROM public.pos_current_profile();
  IF actor.id IS NULL OR actor.role<>'owner' THEN RAISE EXCEPTION 'book access denied' USING ERRCODE='42501'; END IF;
  IF current_setting('transaction_isolation') NOT IN ('read committed','read uncommitted') THEN
    RAISE EXCEPTION 'book access requires read committed isolation' USING ERRCODE='25000';
  END IF;
  PERFORM 1 FROM pos_security.user_access a WHERE a.auth_user_id=actor.auth_user_id OR a.admin_id=p_admin_id
    ORDER BY a.auth_user_id FOR SHARE;
  SELECT * INTO actor FROM public.pos_current_profile();
  SELECT * INTO target FROM pos_security.user_access WHERE admin_id=p_admin_id;
  IF actor.id IS NULL OR actor.role<>'owner' OR target.admin_id IS NULL OR target.role<>'staff'
    OR NOT target.active OR target.reset_operation IS NOT NULL THEN
    RAISE EXCEPTION 'book access denied' USING ERRCODE='42501';
  END IF;
  -- One snapshot, including inactive/missing book IDs that remain assigned.
  -- A read does not initialize a revision or silently filter the stored state.
  SELECT jsonb_build_object('admin_id',p_admin_id,
    'book_ids',coalesce((SELECT jsonb_agg(b.book_id ORDER BY b.book_id) FROM public.admin_book_access b
      WHERE b.admin_id=p_admin_id),'[]'::jsonb),
    'version',coalesce((SELECT r.version FROM pos_security.admin_book_revisions r WHERE r.admin_id=p_admin_id),0))
    INTO result;
  RETURN result;
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'book access rejected' USING ERRCODE=SQLSTATE;
END
$$;

CREATE FUNCTION public.pos_set_admin_books(p_admin_id uuid,p_book_ids uuid[],p_expected_version bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE actor record; target pos_security.user_access; wanted uuid[]; locked_count integer; current_version bigint;
BEGIN
  SELECT * INTO actor FROM public.pos_current_profile();
  IF actor.id IS NULL OR actor.role<>'owner' THEN RAISE EXCEPTION 'book assignment denied' USING ERRCODE='42501'; END IF;
  IF current_setting('transaction_isolation') NOT IN ('read committed','read uncommitted') THEN
    RAISE EXCEPTION 'book assignment requires read committed isolation' USING ERRCODE='25000';
  END IF;
  -- Match the identity/reset lock order. No private identity values are changed.
  PERFORM 1 FROM pos_security.user_access a WHERE a.auth_user_id=actor.auth_user_id OR a.admin_id=p_admin_id
    ORDER BY a.auth_user_id FOR UPDATE;
  SELECT * INTO actor FROM public.pos_current_profile();
  SELECT * INTO target FROM pos_security.user_access WHERE admin_id=p_admin_id;
  IF actor.id IS NULL OR actor.role<>'owner' OR target.admin_id IS NULL OR target.role<>'staff'
    OR NOT target.active OR target.reset_operation IS NOT NULL THEN
    RAISE EXCEPTION 'book assignment denied' USING ERRCODE='42501';
  END IF;
  IF p_expected_version IS NULL OR p_expected_version<0 OR p_expected_version>9007199254740991 THEN
    RAISE EXCEPTION 'invalid book version' USING ERRCODE='22023';
  END IF;
  IF p_book_ids IS NULL OR coalesce(array_ndims(p_book_ids),1)>1 THEN
    RAISE EXCEPTION 'invalid book set' USING ERRCODE='22023';
  END IF;
  IF array_position(p_book_ids,NULL) IS NOT NULL OR cardinality(p_book_ids)>1000 THEN
    RAISE EXCEPTION 'invalid book set' USING ERRCODE='22023';
  END IF;
  INSERT INTO pos_security.admin_book_revisions(admin_id) VALUES (p_admin_id) ON CONFLICT DO NOTHING;
  SELECT version INTO STRICT current_version FROM pos_security.admin_book_revisions WHERE admin_id=p_admin_id FOR UPDATE;
  IF current_version<>p_expected_version THEN RAISE EXCEPTION 'stale book version' USING ERRCODE='40001'; END IF;
  IF current_version=9007199254740991 THEN RAISE EXCEPTION 'book version exhausted' USING ERRCODE='22023'; END IF;
  SELECT coalesce(array_agg(DISTINCT b ORDER BY b),'{}'::uuid[]) INTO wanted FROM unnest(p_book_ids) b;
  PERFORM 1 FROM public.books WHERE id=ANY(wanted) AND is_active AND deleted_at IS NULL ORDER BY id FOR SHARE;
  GET DIAGNOSTICS locked_count=ROW_COUNT;
  IF locked_count<>cardinality(wanted) THEN RAISE EXCEPTION 'invalid book set' USING ERRCODE='22023'; END IF;
  DELETE FROM public.admin_book_access WHERE admin_id=p_admin_id AND NOT book_id=ANY(wanted);
  INSERT INTO public.admin_book_access(admin_id,book_id)
    SELECT p_admin_id,b FROM unnest(wanted) b ON CONFLICT (admin_id,book_id) DO NOTHING;
  -- Even a no-op is a sequencing barrier against older delayed requests.
  UPDATE pos_security.admin_book_revisions SET version=current_version+1 WHERE admin_id=p_admin_id;
  RETURN jsonb_build_object('admin_id',p_admin_id,'book_ids',to_jsonb(wanted),'version',current_version+1);
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'book assignment rejected' USING ERRCODE=SQLSTATE;
END
$$;
REVOKE ALL ON FUNCTION public.pos_record_payment(uuid,text,numeric,text,text),
  public.pos_admin_book_access(uuid),public.pos_set_admin_books(uuid,uuid[],bigint)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.pos_record_payment(uuid,text,numeric,text,text),
  public.pos_admin_book_access(uuid),public.pos_set_admin_books(uuid,uuid[],bigint)
  TO authenticated;
COMMIT;
