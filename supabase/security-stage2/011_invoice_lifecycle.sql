-- CANDIDATE ONLY. Explicitly after 001-006, 009 and extended 010.
-- No auth cutover, automatic account mapping, history rewrite or production activation.
BEGIN;
SET LOCAL search_path = '';
ALTER TABLE public.transactions ADD COLUMN version bigint NOT NULL DEFAULT 0;

CREATE TABLE pos_security.invoice_account_config (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  refund_account text NOT NULL REFERENCES public.accounts(code)
);
CREATE TABLE pos_security.invoice_states (
  order_id uuid PRIMARY KEY REFERENCES public.transactions(id),
  invoice_no text NOT NULL UNIQUE,
  original_snapshot jsonb NOT NULL,
  state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','cancelled','voided')),
  refunded numeric NOT NULL DEFAULT 0 CHECK(refunded>=0),
  refund_due numeric NOT NULL DEFAULT 0 CHECK(refund_due>=0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE pos_security.invoice_operations (
  operation_id uuid PRIMARY KEY,
  actor_id uuid NOT NULL,
  order_id uuid NOT NULL,
  fingerprint text NOT NULL,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE pos_security.invoice_events (
  operation_id uuid PRIMARY KEY REFERENCES pos_security.invoice_operations(operation_id),
  order_id uuid NOT NULL REFERENCES public.transactions(id),
  actor_id uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN ('edit','cancel','void_error','refund')),
  reason text NOT NULL,
  reference text,
  before_snapshot jsonb NOT NULL,
  after_snapshot jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE pos_security.invoice_write_context (
  transaction_id bigint PRIMARY KEY,
  order_id uuid NOT NULL,
  invoice_no text NOT NULL,
  operation_id uuid NOT NULL
);
DO $$ DECLARE tab text; BEGIN
  FOREACH tab IN ARRAY ARRAY['invoice_account_config','invoice_states','invoice_operations','invoice_events','invoice_write_context'] LOOP
    EXECUTE format('ALTER TABLE pos_security.%I ENABLE ROW LEVEL SECURITY',tab);
    EXECUTE format('REVOKE ALL ON pos_security.%I FROM PUBLIC,anon,authenticated,service_role',tab);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION pos_security.lifecycle_has_invoice(p_id uuid) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS(SELECT 1 FROM pos_security.invoice_states WHERE order_id=p_id)
$$;
CREATE OR REPLACE FUNCTION pos_security.lifecycle_payment_total(p_invoice text,p_default numeric) RETURNS numeric
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce((SELECT t.total FROM public.transactions t JOIN pos_security.invoice_states s ON s.order_id=t.id
    WHERE s.invoice_no=p_invoice),p_default)
$$;
CREATE OR REPLACE FUNCTION pos_security.lifecycle_payment_paid(p_invoice text,p_default numeric) RETURNS numeric
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  SELECT p_default-coalesce((SELECT refunded FROM pos_security.invoice_states WHERE invoice_no=p_invoice),0)
$$;

CREATE OR REPLACE FUNCTION pos_security.lifecycle_write_allowed(p_table text,p_op text,p_old jsonb,p_new jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE ctx pos_security.invoice_write_context; j jsonb:=coalesce(p_new,p_old); managed boolean;
BEGIN
  SELECT * INTO ctx FROM pos_security.invoice_write_context WHERE transaction_id=txid_current();
  IF ctx.transaction_id IS NOT NULL AND p_op<>'DELETE'
    AND j->>'invoice_no'=ctx.invoice_no AND (p_old IS NULL OR p_old->>'invoice_no'=ctx.invoice_no)
    AND ((p_table='transactions' AND (j->>'id')::uuid=ctx.order_id)
      OR (p_table='debts' AND (j->>'transaction_id')::uuid=ctx.order_id)
      OR (p_table IN ('accounting_entries','cash_movements') AND p_op='INSERT'
        AND (j->>'source_id')::uuid=ctx.operation_id AND j->>'source_type' IN ('invoice_edit','invoice_cancel','invoice_void','invoice_refund'))) THEN
    RETURN true;
  END IF;
  managed := EXISTS(SELECT 1 FROM pos_security.invoice_states s WHERE s.invoice_no IN (p_old->>'invoice_no',p_new->>'invoice_no')
    OR (p_table='transactions' AND s.order_id IN ((p_old->>'id')::uuid,(p_new->>'id')::uuid)));
  IF p_table IN ('transactions','debts') THEN
    IF p_op='DELETE' THEN RAISE EXCEPTION 'use invoice removal operation' USING ERRCODE='55000'; END IF;
    -- Production workflow changes are not financial revisions. RLS still checks the actor/book.
    IF p_table='transactions' AND p_op='UPDATE' AND p_old->>'deleted_at' IS NULL
      AND lower(btrim(coalesce(p_old->>'order_status',''))) NOT IN ('dibatalkan','cancelled','canceled')
      AND lower(btrim(coalesce(p_old->>'status',''))) NOT IN ('dibatalkan','cancelled','canceled')
      AND p_new->>'order_status' IN ('menunggu','diproses','produksi','selesai','diambil','dikirim')
      AND jsonb_typeof(p_new->'status_history')='array'
      AND (p_old-ARRAY['order_status','status_history'])=(p_new-ARRAY['order_status','status_history']) THEN
      RETURN true;
    END IF;
    IF p_op='UPDATE' AND (p_table='transactions' OR managed) AND
      (p_old-ARRAY['paid','remaining','status','order_status','status_history','version','updated_at']) IS DISTINCT FROM
      (p_new-ARRAY['paid','remaining','status','order_status','status_history','version','updated_at']) THEN
      RAISE EXCEPTION 'use invoice change operation' USING ERRCODE='55000';
    END IF;
    IF p_op='UPDATE' AND (lower(btrim(p_new->>'order_status')) IN ('dibatalkan','cancelled','canceled')
      OR lower(btrim(p_new->>'status')) IN ('dibatalkan','cancelled','canceled')) THEN
      RAISE EXCEPTION 'use invoice removal operation' USING ERRCODE='55000';
    END IF;
  ELSIF managed AND p_table IN ('accounting_entries','cash_movements') THEN
    IF p_op='INSERT' AND j->>'source_type'='debt_payment'
      AND EXISTS(SELECT 1 FROM pos_security.payment_write_context c WHERE c.transaction_id=txid_current()
        AND c.invoice_no=j->>'invoice_no' AND c.payment_id=(j->>'source_id')::uuid) THEN RETURN false; END IF;
    RAISE EXCEPTION 'invoice journal is immutable' USING ERRCODE='55000';
  END IF;
  RETURN false;
END $$;

CREATE FUNCTION pos_security.invoice_version() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  NEW.version := CASE WHEN TG_OP='INSERT' THEN 0 ELSE OLD.version+1 END;
  RETURN NEW;
END $$;
CREATE TRIGGER "99_invoice_version" BEFORE INSERT OR UPDATE ON public.transactions
  FOR EACH ROW EXECUTE FUNCTION pos_security.invoice_version();

CREATE FUNCTION pos_security.invoice_quote(p_items jsonb,p_discount numeric,p_tax numeric,p_paid numeric) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE item jsonb; qty numeric; price numeric; units text; scaled numeric:=0; subtotal numeric; total numeric;
BEGIN
  IF p_items IS NULL OR jsonb_typeof(p_items)<>'array' OR jsonb_array_length(p_items)=0
    OR jsonb_array_length(p_items)>1000 THEN RAISE EXCEPTION 'invalid items' USING ERRCODE='22023'; END IF;
  FOREACH total IN ARRAY ARRAY[p_discount,p_tax,p_paid] LOOP
    IF total IS NULL OR total::text IN ('NaN','Infinity','-Infinity') OR total<0 OR total<>trunc(total) OR total>9007199254740991 THEN
      RAISE EXCEPTION 'invalid rupiah amount' USING ERRCODE='22023'; END IF;
  END LOOP;
  FOR item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    IF jsonb_typeof(item)<>'object' OR jsonb_typeof(item->'name') IS DISTINCT FROM 'string'
      OR length(btrim(item->>'name')) NOT BETWEEN 1 AND 1000
      OR jsonb_typeof(item->'qty') IS DISTINCT FROM 'number' OR jsonb_typeof(item->'price') IS DISTINCT FROM 'number'
      OR EXISTS(SELECT 1 FROM jsonb_object_keys(item) k WHERE k NOT IN ('productId','name','qty','price','unit')) THEN
      RAISE EXCEPTION 'invalid item' USING ERRCODE='22023'; END IF;
    qty:=(item->>'qty')::numeric; price:=(item->>'price')::numeric; units:=item->>'unit';
    IF units IS NULL OR units NOT IN ('pcs','meter','yard') OR qty<=0 OR qty<>round(qty,2)
      OR (units='pcs' AND qty<>trunc(qty)) OR price<0 OR price<>trunc(price)
      OR qty*100>9007199254740991 OR price>9007199254740991 THEN
      RAISE EXCEPTION 'invalid item amount' USING ERRCODE='22023'; END IF;
    scaled:=scaled+price*qty*100;
    IF scaled>9007199254740991 THEN RAISE EXCEPTION 'invoice too large' USING ERRCODE='22023'; END IF;
  END LOOP;
  subtotal:=round(scaled/100); total:=subtotal-p_discount+p_tax;
  IF p_discount>subtotal OR total>9007199254740991 THEN RAISE EXCEPTION 'invalid invoice total' USING ERRCODE='22023'; END IF;
  RETURN jsonb_build_object('items',p_items,'subtotal',subtotal,'discount',p_discount,'tax',p_tax,'total',total,
    'paid',p_paid,'remaining',greatest(0,total-p_paid),'overpaid',greatest(0,p_paid-total));
END $$;

CREATE FUNCTION pos_security.invoice_verify_ledger(p_order uuid,p_revenue numeric,p_remaining numeric,p_paid numeric,p_refund numeric,p_account text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE t public.transactions; bad boolean; cash numeric; revenue numeric; receivable numeric; liability numeric;
BEGIN
  SELECT * INTO STRICT t FROM public.transactions WHERE id=p_order;
  IF EXISTS(SELECT 1 FROM public.accounting_entries e WHERE (e.invoice_no=t.invoice_no OR e.source_id=t.id)
    AND (e.invoice_no IS DISTINCT FROM t.invoice_no OR e.account_code IS NULL OR e.debit IS NULL OR e.credit IS NULL
      OR e.debit<0 OR e.credit<0 OR e.debit::text IN ('NaN','Infinity','-Infinity') OR e.credit::text IN ('NaN','Infinity','-Infinity')
      OR e.account_code NOT IN ('1000','1100','1200','4000',p_account))) THEN
    RAISE EXCEPTION 'invoice journal mismatch' USING ERRCODE='23514'; END IF;
  SELECT coalesce(sum(debit-credit) FILTER(WHERE account_code IN ('1000','1100')),0),
    coalesce(sum(credit-debit) FILTER(WHERE account_code='4000'),0),
    coalesce(sum(debit-credit) FILTER(WHERE account_code='1200'),0),
    coalesce(sum(credit-debit) FILTER(WHERE account_code=p_account),0)
    INTO cash,revenue,receivable,liability FROM public.accounting_entries WHERE invoice_no=t.invoice_no;
  IF cash IS DISTINCT FROM p_paid OR revenue IS DISTINCT FROM p_revenue OR receivable IS DISTINCT FROM p_remaining
    OR liability IS DISTINCT FROM p_refund THEN RAISE EXCEPTION 'invoice balances require reconciliation' USING ERRCODE='23514'; END IF;
  IF EXISTS(SELECT 1 FROM public.cash_movements m WHERE m.invoice_no=t.invoice_no AND
    (m.direction IS NULL OR m.direction NOT IN ('in','out') OR m.method IS NULL OR
      (m.method NOT IN ('cash','transfer','qris') AND NOT
        (m.method='hutang' AND m.source_type='sale' AND m.source_id=t.id AND t.payment_method='hutang'))
      OR m.amount IS NULL OR m.amount<0 OR m.amount::text IN ('NaN','Infinity','-Infinity'))) THEN
    RAISE EXCEPTION 'invoice cash history mismatch' USING ERRCODE='23514'; END IF;
  IF (SELECT coalesce(sum(CASE WHEN direction='in' THEN amount ELSE -amount END),0)
    FROM public.cash_movements WHERE invoice_no=t.invoice_no) IS DISTINCT FROM p_paid THEN
    RAISE EXCEPTION 'invoice cash balance mismatch' USING ERRCODE='23514'; END IF;
  IF EXISTS(SELECT 1 FROM (VALUES ('1000'),('1100')) c(code) WHERE
    (SELECT coalesce(sum(e.debit-e.credit),0) FROM public.accounting_entries e WHERE e.invoice_no=t.invoice_no AND e.account_code=c.code)
      IS DISTINCT FROM (SELECT coalesce(sum(CASE WHEN m.direction='in' THEN m.amount ELSE -m.amount END),0)
        FROM public.cash_movements m WHERE m.invoice_no=t.invoice_no AND public.acc_cash_code(m.method)=c.code)) THEN
    RAISE EXCEPTION 'invoice tender mismatch' USING ERRCODE='23514'; END IF;
END $$;

CREATE OR REPLACE FUNCTION public.recalculate_customer_summary(p_customer_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  UPDATE public.customers c SET
    total_transactions=(SELECT count(*) FROM public.transactions t WHERE t.customer_id=c.id AND t.deleted_at IS NULL
      AND coalesce(t.order_status,'') NOT IN ('dibatalkan','cancelled','canceled')),
    total_spent=(SELECT coalesce(sum(t.total),0) FROM public.transactions t WHERE t.customer_id=c.id AND t.deleted_at IS NULL
      AND coalesce(t.order_status,'') NOT IN ('dibatalkan','cancelled','canceled')),
    total_debt=(SELECT coalesce(sum(d.remaining),0) FROM public.debts d WHERE d.customer_id=c.id AND d.deleted_at IS NULL AND d.status='aktif')
    WHERE c.id=p_customer_id;
END $$;

CREATE FUNCTION pos_security.invoice_verify_original_receipts(p_order uuid,p_debt uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE t public.transactions; expected jsonb; actual jsonb; expected_postings integer; expected_cash integer;
BEGIN
  SELECT * INTO STRICT t FROM public.transactions WHERE id=p_order;
  -- Legacy installments were folded into the sale's paid/DP fields. The
  -- historical payment rows carry context, but have no separate cash posting.
  IF t.payment_method='hutang' AND t.dp=t.paid THEN
    expected_cash:=CASE WHEN t.paid>0 THEN 1 ELSE 0 END;
    expected_postings:=(CASE WHEN t.total>0 THEN 1 ELSE 0 END)
      +(CASE WHEN t.remaining>0 THEN 1 ELSE 0 END)
      +(CASE WHEN t.paid>0 THEN 1 ELSE 0 END);
    IF t.created_at IS NULL OR t.paid IS NULL OR t.paid<0 OR t.paid>t.total OR
      EXISTS(SELECT 1 FROM public.debt_payments p WHERE (p.invoice_no=t.invoice_no OR p.debt_id=p_debt)
        AND (p.invoice_no=t.invoice_no AND p.debt_id=p_debt
          AND (p.customer_id IS NULL OR p.customer_id IS NOT DISTINCT FROM t.customer_id)
          AND (p.book_id IS NULL OR p.book_id IS NOT DISTINCT FROM t.book_id)
          AND p.deleted_at IS NULL AND p.paid_at IS NOT NULL
          AND p.amount>0 AND p.amount=trunc(p.amount) AND p.amount::text NOT IN ('NaN','Infinity','-Infinity')
          AND p.payment_method IN ('cash','transfer','qris')) IS NOT TRUE) THEN
      RAISE EXCEPTION 'historical aggregate metadata mismatch' USING ERRCODE='23514'; END IF;
    IF (SELECT count(*) FROM public.cash_movements m WHERE m.invoice_no=t.invoice_no OR m.source_id=t.id OR
      m.source_id IN (SELECT p.id FROM public.debt_payments p WHERE p.invoice_no=t.invoice_no OR p.debt_id=p_debt))
      <> expected_cash OR
      EXISTS(SELECT 1 FROM public.cash_movements m WHERE (m.invoice_no=t.invoice_no OR m.source_id=t.id OR
        m.source_id IN (SELECT p.id FROM public.debt_payments p WHERE p.invoice_no=t.invoice_no OR p.debt_id=p_debt))
        AND (m.source_type='sale' AND m.source_id=t.id AND m.invoice_no=t.invoice_no
          AND m.moved_at=t.created_at AND m.direction='in' AND m.method='hutang' AND m.amount=t.paid
          AND m.cashier_id IS NOT DISTINCT FROM t.cashier_id) IS NOT TRUE) THEN
      RAISE EXCEPTION 'historical aggregate cash mismatch' USING ERRCODE='23514'; END IF;
    IF (SELECT count(*) FROM public.accounting_entries e WHERE e.invoice_no=t.invoice_no OR e.source_id=t.id OR
      e.source_id IN (SELECT p.id FROM public.debt_payments p WHERE p.invoice_no=t.invoice_no OR p.debt_id=p_debt))
      <> expected_postings OR
      EXISTS(SELECT 1 FROM public.accounting_entries e WHERE (e.invoice_no=t.invoice_no OR e.source_id=t.id OR
        e.source_id IN (SELECT p.id FROM public.debt_payments p WHERE p.invoice_no=t.invoice_no OR p.debt_id=p_debt))
        AND (e.source_type='sale' AND e.source_id=t.id AND e.invoice_no=t.invoice_no
          AND e.cashier_id IS NOT DISTINCT FROM t.cashier_id AND
          ((t.total>0 AND e.account_code='4000' AND e.debit=0 AND e.credit=t.total)
            OR (t.remaining>0 AND e.account_code='1200' AND e.debit=t.remaining AND e.credit=0)
            OR (t.paid>0 AND e.account_code='1000' AND e.debit=t.paid AND e.credit=0))) IS NOT TRUE) THEN
      RAISE EXCEPTION 'historical aggregate journal mismatch' USING ERRCODE='23514'; END IF;
    IF (SELECT count(DISTINCT e.account_code) FROM public.accounting_entries e
      WHERE e.source_type='sale' AND e.source_id=t.id) <> expected_postings THEN
      RAISE EXCEPTION 'historical aggregate journal mismatch' USING ERRCODE='23514'; END IF;
    RETURN;
  END IF;
  IF t.created_at IS NULL OR t.dp IS NULL OR t.dp<0 OR t.dp<>trunc(t.dp) OR t.dp>t.total
    OR (t.dp>0 AND (t.payment_method IN ('cash','transfer','qris')) IS NOT TRUE)
    OR EXISTS(SELECT 1 FROM public.debt_payments p WHERE (p.invoice_no=t.invoice_no OR p.debt_id=p_debt) AND
      (p.invoice_no=t.invoice_no AND p.debt_id=p_debt AND p.customer_id IS NOT DISTINCT FROM t.customer_id
        AND p.book_id IS NOT DISTINCT FROM t.book_id AND p.deleted_at IS NULL AND p.amount>0
        AND p.amount=trunc(p.amount) AND p.amount::text NOT IN ('NaN','Infinity','-Infinity')
        AND p.paid_at>=t.created_at AND p.payment_method IN ('cash','transfer','qris')) IS NOT TRUE) THEN
    RAISE EXCEPTION 'historical receipt metadata mismatch' USING ERRCODE='23514'; END IF;
  WITH receipts AS (
    SELECT 'sale'::text source_type,t.id source_id,t.created_at moved_at,t.payment_method method,t.dp amount,t.cashier_id
      WHERE t.dp>0
    UNION ALL SELECT 'debt_payment',p.id,p.paid_at,p.payment_method,p.amount,p.cashier_id FROM public.debt_payments p
      WHERE p.invoice_no=t.invoice_no OR p.debt_id=p_debt
  ) SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),'[]'::jsonb) INTO expected FROM receipts r;
  SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),'[]'::jsonb) INTO actual FROM (
    SELECT m.source_type,m.source_id,m.moved_at,m.method,m.amount,m.cashier_id FROM public.cash_movements m
      WHERE (m.invoice_no=t.invoice_no OR m.source_id=t.id OR m.source_id IN
        (SELECT p.id FROM public.debt_payments p WHERE p.invoice_no=t.invoice_no OR p.debt_id=p_debt))
      AND m.direction='in' AND m.invoice_no=t.invoice_no
  ) r;
  IF actual IS DISTINCT FROM expected OR EXISTS(SELECT 1 FROM public.cash_movements m WHERE
    (m.invoice_no=t.invoice_no OR m.source_id=t.id OR m.source_id IN
      (SELECT p.id FROM public.debt_payments p WHERE p.invoice_no=t.invoice_no OR p.debt_id=p_debt))
    AND (m.direction='in' AND m.invoice_no=t.invoice_no) IS NOT TRUE) THEN
    RAISE EXCEPTION 'historical receipt cash mismatch' USING ERRCODE='23514'; END IF;
  WITH postings AS (
    SELECT 'sale'::text source_type,t.id source_id,(t.created_at AT TIME ZONE 'Asia/Jakarta')::date entry_date,
      v.account_code,v.debit,v.credit,t.cashier_id FROM (VALUES
        ('4000',0::numeric,t.total),('1200',t.total-t.dp,0::numeric),
        (public.acc_cash_code(t.payment_method),t.dp,0::numeric)) v(account_code,debit,credit)
      WHERE t.total>0 AND (v.debit>0 OR v.credit>0)
    UNION ALL SELECT 'debt_payment',p.id,(p.paid_at AT TIME ZONE 'Asia/Jakarta')::date,v.account_code,v.debit,v.credit,p.cashier_id
      FROM public.debt_payments p CROSS JOIN LATERAL (VALUES
        (public.acc_cash_code(p.payment_method),p.amount,0::numeric),('1200',0::numeric,p.amount)) v(account_code,debit,credit)
      WHERE p.invoice_no=t.invoice_no OR p.debt_id=p_debt
  ) SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),'[]'::jsonb) INTO expected FROM postings r;
  SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),'[]'::jsonb) INTO actual FROM (
    SELECT e.source_type,e.source_id,e.entry_date,e.account_code,e.debit,e.credit,e.cashier_id FROM public.accounting_entries e
      WHERE e.invoice_no=t.invoice_no OR e.source_id=t.id OR e.source_id IN
        (SELECT p.id FROM public.debt_payments p WHERE p.invoice_no=t.invoice_no OR p.debt_id=p_debt)
  ) r;
  IF actual IS DISTINCT FROM expected OR EXISTS(SELECT 1 FROM public.accounting_entries e WHERE
    (e.source_id=t.id OR e.source_id IN (SELECT p.id FROM public.debt_payments p WHERE p.invoice_no=t.invoice_no OR p.debt_id=p_debt))
      AND e.invoice_no IS DISTINCT FROM t.invoice_no) THEN
    RAISE EXCEPTION 'historical receipt journal mismatch' USING ERRCODE='23514'; END IF;
END $$;

CREATE FUNCTION public.pos_apply_invoice_change(p_operation_id uuid,p_invoice_id uuid,p_expected_version bigint,p_kind text,p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
<<invoice_op>>
DECLARE actor record; t public.transactions; before_t public.transactions; d public.debts; s pos_security.invoice_states;
  op pos_security.invoice_operations; fingerprint text; quote jsonb; reason text; refund_account text;
  new_total numeric; new_paid numeric; new_remaining numeric; new_refund numeric; new_state text;
  amount numeric:=0; method text; occurred timestamptz:=clock_timestamp(); source text;
  delta numeric; account text; cash record; v_result jsonb; expected_t jsonb; expected_d jsonb;
  old_revenue numeric; new_revenue numeric; entries_before integer; posted integer:=0; changes integer;
  expected_cash jsonb:='[]'; actual_cash jsonb; expected_entries jsonb:='[]'; actual_entries jsonb; expected_baseline jsonb;
BEGIN
  SELECT * INTO actor FROM public.pos_current_profile();
  IF actor.id IS NULL THEN RAISE EXCEPTION 'invoice access denied' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM pos_security.user_access WHERE auth_user_id=actor.auth_user_id FOR SHARE;
  SELECT * INTO actor FROM public.pos_current_profile();
  IF actor.id IS NULL THEN RAISE EXCEPTION 'invoice access denied' USING ERRCODE='42501'; END IF;
  IF p_operation_id IS NULL OR p_invoice_id IS NULL OR p_expected_version IS NULL OR p_expected_version<0
    OR p_kind IS NULL OR p_kind NOT IN ('edit','cancel','void_error','refund')
    OR p_payload IS NULL OR jsonb_typeof(p_payload)<>'object'
    OR jsonb_typeof(p_payload->'reason') IS DISTINCT FROM 'string' OR length(btrim(p_payload->>'reason')) NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'invalid invoice request' USING ERRCODE='22023'; END IF;
  reason:=btrim(p_payload->>'reason');
  IF EXISTS(SELECT 1 FROM jsonb_object_keys(p_payload) k WHERE NOT k=ANY(CASE p_kind
    WHEN 'edit' THEN ARRAY['items','discount','customerName','notes','due_date','reason']
    WHEN 'refund' THEN ARRAY['amount','method','occurred_at','reference','reason'] ELSE ARRAY['reason'] END)) THEN
    RAISE EXCEPTION 'unexpected invoice field' USING ERRCODE='22023'; END IF;
  fingerprint:=encode(sha256(convert_to(jsonb_build_object('invoice',p_invoice_id,'version',p_expected_version,'kind',p_kind,'payload',p_payload)::text,'UTF8')),'hex');
  INSERT INTO pos_security.invoice_operations(operation_id,actor_id,order_id,fingerprint)
    VALUES(p_operation_id,actor.auth_user_id,p_invoice_id,fingerprint) ON CONFLICT DO NOTHING;
  SELECT * INTO STRICT op FROM pos_security.invoice_operations WHERE operation_id=p_operation_id FOR UPDATE;
  IF op.actor_id<>actor.auth_user_id THEN RAISE EXCEPTION 'invoice operation denied' USING ERRCODE='42501'; END IF;
  IF op.fingerprint<>fingerprint THEN RAISE EXCEPTION 'invoice request changed' USING ERRCODE='22023'; END IF;
  IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'isolation unsupported' USING ERRCODE='25000'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('skupy:business-invoice-binding:v1',0));
  SELECT * INTO t FROM public.transactions WHERE id=p_invoice_id FOR UPDATE;
  IF NOT FOUND OR (pos_security.business_manager() OR (t.cashier_id IS NOT NULL AND pos_security.business_book(t.book_id))) IS NOT TRUE THEN
    RAISE EXCEPTION 'invoice access denied' USING ERRCODE='42501'; END IF;
  IF op.result IS NOT NULL THEN RETURN op.result; END IF;
  IF t.version<>p_expected_version THEN RAISE EXCEPTION 'invoice changed; refresh before retry'
    USING ERRCODE='40001',HINT='invoice_revision_conflict',DETAIL=p_operation_id::text; END IF;
  SELECT * INTO s FROM pos_security.invoice_states WHERE order_id=t.id FOR UPDATE;
  IF (t.deleted_at IS NOT NULL OR lower(btrim(t.order_status)) IN ('dibatalkan','cancelled','canceled')
    OR lower(btrim(t.status)) IN ('dibatalkan','cancelled','canceled')) AND s.order_id IS NULL THEN
    RAISE EXCEPTION 'removed historical invoice requires reconciliation' USING ERRCODE='22023'; END IF;
  IF s.order_id IS NOT NULL AND s.state<>'active' AND p_kind<>'refund' THEN RAISE EXCEPTION 'invoice already removed' USING ERRCODE='22023'; END IF;
  SELECT c.refund_account INTO refund_account FROM pos_security.invoice_account_config c JOIN public.accounts a ON a.code=c.refund_account
    WHERE a.type='liability' AND a.normal='credit' AND a.code NOT IN ('1000','1100','1200','2000','2100','4000') FOR SHARE OF a,c;
  IF refund_account IS NULL THEN RAISE EXCEPTION 'customer refund account not configured' USING ERRCODE='55000'; END IF;
  PERFORM 1 FROM public.debts x WHERE x.transaction_id=t.id OR x.invoice_no=t.invoice_no ORDER BY x.id FOR UPDATE;
  IF (SELECT count(*) FROM public.debts x WHERE x.transaction_id=t.id OR x.invoice_no=t.invoice_no)>1 THEN
    RAISE EXCEPTION 'invoice debt ambiguous' USING ERRCODE='23514'; END IF;
  SELECT * INTO d FROM public.debts WHERE transaction_id=t.id OR invoice_no=t.invoice_no;
  IF d.id IS NOT NULL AND (d.transaction_id IS DISTINCT FROM t.id OR d.invoice_no IS DISTINCT FROM t.invoice_no
    OR d.customer_id IS DISTINCT FROM t.customer_id OR d.book_id IS DISTINCT FROM t.book_id
    OR d.total_debt IS DISTINCT FROM t.total OR d.paid IS DISTINCT FROM t.paid OR d.remaining IS DISTINCT FROM t.remaining) THEN
    RAISE EXCEPTION 'invoice debt mismatch' USING ERRCODE='23514'; END IF;
  IF t.customer_id IS NOT NULL THEN
    PERFORM 1 FROM public.customers c WHERE c.id=t.customer_id AND c.deleted_at IS NULL AND c.book_id IS NOT DISTINCT FROM t.book_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'invoice customer mismatch' USING ERRCODE='23514'; END IF;
  END IF;
  IF t.total IS NULL OR t.paid IS NULL OR t.remaining IS NULL OR t.total<0 OR t.paid<0
    OR t.total<>trunc(t.total) OR t.paid<>trunc(t.paid) OR t.total::text IN ('NaN','Infinity','-Infinity')
    OR t.paid::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'invalid stored invoice' USING ERRCODE='23514'; END IF;
  old_revenue:=CASE WHEN coalesce(s.state,'active')='active' THEN t.total ELSE 0 END;
  PERFORM pos_security.invoice_verify_ledger(t.id,old_revenue,t.remaining,t.paid,coalesce(s.refund_due,0),refund_account);
  IF s.order_id IS NULL THEN
    IF t.remaining<>greatest(0,t.total-t.paid) OR t.paid>t.total OR t.dp IS NULL
      OR EXISTS(SELECT 1 FROM public.debt_payments p WHERE (p.invoice_no=t.invoice_no OR p.debt_id=d.id) AND p.deleted_at IS NOT NULL)
      OR (t.payment_method<>'hutang' AND t.dp+coalesce((SELECT sum(p.amount) FROM public.debt_payments p WHERE p.invoice_no=t.invoice_no OR p.debt_id=d.id),0)<>t.paid)
      OR (t.payment_method='hutang' AND t.dp<>t.paid) THEN
      RAISE EXCEPTION 'historical receipt totals mismatch' USING ERRCODE='23514'; END IF;
    PERFORM pos_security.invoice_verify_original_receipts(t.id,d.id);
    INSERT INTO pos_security.invoice_states(order_id,invoice_no,original_snapshot) VALUES(t.id,t.invoice_no,to_jsonb(t)) RETURNING * INTO s;
    IF NOT FOUND THEN RAISE EXCEPTION 'invoice adoption failed' USING ERRCODE='23514'; END IF;
  END IF;
  before_t:=t; new_total:=t.total; new_paid:=t.paid; new_remaining:=t.remaining; new_refund:=s.refund_due; new_state:=s.state;
  IF p_kind='edit' THEN
    IF jsonb_typeof(p_payload->'discount') IS DISTINCT FROM 'number'
      OR jsonb_typeof(p_payload->'customerName') IS DISTINCT FROM 'string' OR length(btrim(p_payload->>'customerName')) NOT BETWEEN 1 AND 256
      OR jsonb_typeof(p_payload->'notes') IS DISTINCT FROM 'string' OR length(p_payload->>'notes')>4000
      OR NOT p_payload?'due_date' OR (p_payload->'due_date'<>'null'::jsonb AND (jsonb_typeof(p_payload->'due_date')<>'string'
        OR p_payload->>'due_date' !~ '^\d{4}-\d{2}-\d{2}$')) THEN RAISE EXCEPTION 'invalid invoice edit' USING ERRCODE='22023'; END IF;
    quote:=pos_security.invoice_quote(p_payload->'items',(p_payload->>'discount')::numeric,t.tax,t.paid);
    new_total:=(quote->>'total')::numeric; new_remaining:=(quote->>'remaining')::numeric; new_refund:=(quote->>'overpaid')::numeric;
    t.items:=p_payload->'items'; t.subtotal:=(quote->>'subtotal')::numeric; t.discount:=(quote->>'discount')::numeric;
    t.customer:=btrim(p_payload->>'customerName'); t.customer_name:=t.customer; t.notes:=p_payload->>'notes'; t.due_date:=(p_payload->>'due_date')::date;
  ELSIF p_kind IN ('cancel','void_error') THEN
    new_state:=CASE WHEN p_kind='cancel' THEN 'cancelled' ELSE 'voided' END;
    new_remaining:=0; new_refund:=CASE WHEN p_kind='cancel' THEN t.paid ELSE 0 END;
    IF p_kind='void_error' THEN new_paid:=0; END IF;
    t.deleted_at:=occurred; t.order_status:='dibatalkan';
  ELSE
    IF jsonb_typeof(p_payload->'amount') IS DISTINCT FROM 'number'
      OR jsonb_typeof(p_payload->'method') IS DISTINCT FROM 'string' OR p_payload->>'method' NOT IN ('cash','transfer','qris')
      OR jsonb_typeof(p_payload->'reference') IS DISTINCT FROM 'string' OR length(btrim(p_payload->>'reference')) NOT BETWEEN 1 AND 1000
      OR jsonb_typeof(p_payload->'occurred_at') IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'invalid refund' USING ERRCODE='22023'; END IF;
    amount:=(p_payload->>'amount')::numeric; method:=p_payload->>'method'; occurred:=(p_payload->>'occurred_at')::timestamptz;
    IF amount<=0 OR amount<>trunc(amount) OR amount>s.refund_due OR occurred>clock_timestamp() OR occurred<t.created_at THEN
      RAISE EXCEPTION 'invalid refund amount or date' USING ERRCODE='22023'; END IF;
    new_paid:=t.paid-amount; new_refund:=s.refund_due-amount;
  END IF;
  new_revenue:=CASE WHEN new_state='active' THEN new_total ELSE 0 END;
  t.total:=new_total; t.paid:=new_paid; t.remaining:=new_remaining;
  t.status:=CASE WHEN new_state<>'active' THEN 'dibatalkan' WHEN new_remaining=0 THEN 'lunas' ELSE 'pending' END;
  expected_t:=to_jsonb(t)||jsonb_build_object('version',t.version+1);
  INSERT INTO pos_security.invoice_write_context VALUES(txid_current(),t.id,t.invoice_no,p_operation_id);
  UPDATE public.transactions SET items=t.items,subtotal=t.subtotal,discount=t.discount,total=t.total,paid=t.paid,remaining=t.remaining,
    customer=t.customer,customer_name=t.customer_name,notes=t.notes,due_date=t.due_date,status=t.status,
    order_status=t.order_status,deleted_at=t.deleted_at WHERE id=t.id;
  IF NOT FOUND THEN RAISE EXCEPTION 'invoice update suppressed' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.transactions x WHERE x.id=t.id AND to_jsonb(x)=expected_t) THEN
    RAISE EXCEPTION 'invoice update mismatch' USING ERRCODE='23514'; END IF;
  IF d.id IS NULL AND t.customer_id IS NOT NULL THEN
    INSERT INTO public.debts(transaction_id,invoice_no,customer_id,book_id,cashier_id,total_debt,paid,remaining,status,is_opening)
      VALUES(t.id,t.invoice_no,t.customer_id,t.book_id,t.cashier_id,t.total,t.paid,t.remaining,'aktif',false) RETURNING * INTO d;
    IF NOT FOUND THEN RAISE EXCEPTION 'invoice debt insertion suppressed' USING ERRCODE='23514'; END IF;
  END IF;
  IF d.id IS NOT NULL THEN
    d.total_debt:=t.total; d.paid:=t.paid; d.remaining:=t.remaining; d.due_date:=t.due_date; d.customer_name:=t.customer;
    d.deleted_at:=t.deleted_at; d.status:=CASE WHEN new_state<>'active' THEN 'dibatalkan' WHEN t.remaining=0 THEN 'lunas' ELSE 'aktif' END;
    expected_d:=to_jsonb(d)-'updated_at';
    UPDATE public.debts SET total_debt=d.total_debt,paid=d.paid,remaining=d.remaining,due_date=d.due_date,customer_name=d.customer_name,
      deleted_at=d.deleted_at,status=d.status WHERE id=d.id;
    IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public.debts x WHERE x.id=d.id AND (to_jsonb(x)-'updated_at')=expected_d) THEN
      RAISE EXCEPTION 'invoice debt update mismatch' USING ERRCODE='23514'; END IF;
    IF greatest(before_t.total,new_total)>0 AND NOT EXISTS(SELECT 1 FROM pos_security.payment_baselines b WHERE b.invoice_no=t.invoice_no) THEN
      expected_baseline:=jsonb_build_object('invoice_no',t.invoice_no,'order_id',t.id,'debt_id',d.id,
        'total',greatest(before_t.total,new_total),'initial_paid',before_t.paid-coalesce((SELECT sum(e.amount) FROM pos_security.payment_events e WHERE e.invoice_no=t.invoice_no),0),
        'initial_snapshot',to_jsonb(before_t),'attested_by',actor.auth_user_id,'evidence_ref','exact-ledger-reconciliation');
      INSERT INTO pos_security.payment_baselines(invoice_no,order_id,debt_id,total,initial_paid,initial_snapshot,attested_by,evidence_ref)
        VALUES(t.invoice_no,t.id,d.id,greatest(before_t.total,new_total),before_t.paid-coalesce((SELECT sum(e.amount) FROM pos_security.payment_events e WHERE e.invoice_no=t.invoice_no),0),
          to_jsonb(before_t),actor.auth_user_id,'exact-ledger-reconciliation') ON CONFLICT(invoice_no) DO NOTHING;
      IF NOT EXISTS(SELECT 1 FROM pos_security.payment_baselines b WHERE b.invoice_no=t.invoice_no
        AND (to_jsonb(b)-'created_at')=expected_baseline) THEN
        RAISE EXCEPTION 'invoice payment baseline mismatch' USING ERRCODE='23514'; END IF;
    END IF;
  END IF;
  source:=CASE p_kind WHEN 'edit' THEN 'invoice_edit' WHEN 'cancel' THEN 'invoice_cancel' WHEN 'void_error' THEN 'invoice_void' ELSE 'invoice_refund' END;
  FOR account,delta IN SELECT * FROM (VALUES
    ('4000',old_revenue-new_revenue),('1200',new_remaining-before_t.remaining),(refund_account,s.refund_due-new_refund)) v(code,net) LOOP
    IF delta<>0 THEN
      INSERT INTO public.accounting_entries(entry_date,source_type,source_id,invoice_no,account_code,debit,credit,description,cashier_id)
        VALUES((occurred AT TIME ZONE 'Asia/Jakarta')::date,source,p_operation_id,t.invoice_no,account,greatest(delta,0),greatest(-delta,0),reason,actor.id);
      IF NOT FOUND THEN RAISE EXCEPTION 'invoice journal suppressed' USING ERRCODE='23514'; END IF;
      posted:=posted+1;
      expected_entries:=expected_entries||jsonb_build_array(jsonb_build_object('account_code',account,'debit',greatest(delta,0),'credit',greatest(-delta,0)));
    END IF;
  END LOOP;
  IF p_kind IN ('void_error','refund') THEN
    FOR cash IN SELECT m.method,sum(CASE WHEN m.direction='in' THEN m.amount ELSE -m.amount END) amount
      FROM public.cash_movements m WHERE m.invoice_no=t.invoice_no AND p_kind='void_error' GROUP BY m.method
      UNION ALL SELECT method,amount WHERE p_kind='refund' LOOP
      IF cash.amount<0 THEN RAISE EXCEPTION 'negative receipt tender' USING ERRCODE='23514'; END IF;
      IF cash.amount=0 THEN CONTINUE; END IF;
      INSERT INTO public.accounting_entries(entry_date,source_type,source_id,invoice_no,account_code,debit,credit,description,cashier_id)
        VALUES((occurred AT TIME ZONE 'Asia/Jakarta')::date,source,p_operation_id,t.invoice_no,public.acc_cash_code(cash.method),0,cash.amount,reason,actor.id);
      IF NOT FOUND THEN RAISE EXCEPTION 'cash journal suppressed' USING ERRCODE='23514'; END IF;
      posted:=posted+1;
      expected_entries:=expected_entries||jsonb_build_array(jsonb_build_object('account_code',public.acc_cash_code(cash.method),'debit',0,'credit',cash.amount));
      INSERT INTO public.cash_movements(moved_at,direction,method,amount,source_type,source_id,invoice_no,note,cashier_id)
        VALUES(occurred,'out',cash.method,cash.amount,source,p_operation_id,t.invoice_no,reason,actor.id);
      IF NOT FOUND THEN RAISE EXCEPTION 'cash adjustment suppressed' USING ERRCODE='23514'; END IF;
      expected_cash:=expected_cash||jsonb_build_array(jsonb_build_object('moved_at',occurred,'direction','out','method',cash.method,
        'amount',cash.amount,'source_type',source,'source_id',p_operation_id,'invoice_no',t.invoice_no,'note',reason,'cashier_id',actor.id));
    END LOOP;
  END IF;
  IF (SELECT count(*) FROM public.accounting_entries WHERE source_id=p_operation_id)<>posted OR EXISTS(
    SELECT 1 FROM public.accounting_entries e WHERE e.source_id=p_operation_id AND
      (e.source_type=source AND e.invoice_no=t.invoice_no AND e.cashier_id=actor.id AND e.description=invoice_op.reason
        AND e.entry_date=(occurred AT TIME ZONE 'Asia/Jakarta')::date) IS NOT TRUE) THEN
    RAISE EXCEPTION 'invoice journal attribution mismatch' USING ERRCODE='23514'; END IF;
  SELECT coalesce(jsonb_agg(value ORDER BY value::text),'[]'::jsonb) INTO actual_entries FROM (
    SELECT jsonb_build_object('account_code',e.account_code,'debit',e.debit,'credit',e.credit) value
      FROM public.accounting_entries e WHERE e.source_id=p_operation_id) rows;
  IF actual_entries IS DISTINCT FROM (SELECT coalesce(jsonb_agg(value ORDER BY value::text),'[]'::jsonb) FROM jsonb_array_elements(expected_entries)) THEN
    RAISE EXCEPTION 'invoice journal amount mismatch' USING ERRCODE='23514'; END IF;
  PERFORM pos_security.invoice_verify_ledger(t.id,new_revenue,new_remaining,new_paid,new_refund,refund_account);
  SELECT coalesce(jsonb_agg(value ORDER BY value::text),'[]'::jsonb) INTO actual_cash FROM (
    SELECT jsonb_build_object('moved_at',m.moved_at,'direction',m.direction,'method',m.method,'amount',m.amount,
      'source_type',m.source_type,'source_id',m.source_id,'invoice_no',m.invoice_no,'note',m.note,'cashier_id',m.cashier_id) value
      FROM public.cash_movements m WHERE m.source_id=p_operation_id) rows;
  IF actual_cash IS DISTINCT FROM (SELECT coalesce(jsonb_agg(value ORDER BY value::text),'[]'::jsonb) FROM jsonb_array_elements(expected_cash)) THEN
    RAISE EXCEPTION 'cash adjustment verification failed' USING ERRCODE='23514'; END IF;
  UPDATE pos_security.invoice_states SET state=new_state,refund_due=new_refund,refunded=refunded+amount WHERE order_id=t.id;
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM pos_security.invoice_states x WHERE x.order_id=t.id AND x.invoice_no=t.invoice_no
    AND x.state=new_state AND x.refund_due=new_refund AND x.refunded=s.refunded+amount AND x.original_snapshot=s.original_snapshot) THEN
    RAISE EXCEPTION 'invoice state update mismatch' USING ERRCODE='23514'; END IF;
  PERFORM public.recalculate_customer_summary(t.customer_id);
  IF t.customer_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.customers c WHERE c.id=t.customer_id
    AND c.total_transactions=(SELECT count(*) FROM public.transactions x WHERE x.customer_id=c.id AND x.deleted_at IS NULL
      AND coalesce(x.order_status,'') NOT IN ('dibatalkan','cancelled','canceled'))
    AND c.total_spent=(SELECT coalesce(sum(x.total),0) FROM public.transactions x WHERE x.customer_id=c.id AND x.deleted_at IS NULL
      AND coalesce(x.order_status,'') NOT IN ('dibatalkan','cancelled','canceled'))
    AND c.total_debt=(SELECT coalesce(sum(x.remaining),0) FROM public.debts x WHERE x.customer_id=c.id AND x.deleted_at IS NULL AND x.status='aktif')) THEN
    RAISE EXCEPTION 'customer summary mismatch' USING ERRCODE='23514'; END IF;
  INSERT INTO pos_security.invoice_events(operation_id,order_id,actor_id,kind,reason,reference,before_snapshot,after_snapshot,occurred_at)
    VALUES(p_operation_id,t.id,actor.auth_user_id,p_kind,reason,p_payload->>'reference',to_jsonb(before_t),expected_t,occurred);
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM pos_security.invoice_events e WHERE e.operation_id=p_operation_id AND e.order_id=t.id
    AND e.actor_id=actor.auth_user_id AND e.kind=p_kind AND e.reason=invoice_op.reason AND e.reference IS NOT DISTINCT FROM p_payload->>'reference'
    AND e.before_snapshot=to_jsonb(before_t) AND e.after_snapshot=expected_t AND e.occurred_at=occurred) THEN
    RAISE EXCEPTION 'invoice audit mismatch' USING ERRCODE='23514'; END IF;
  v_result:=jsonb_build_object('operationId',p_operation_id,'invoiceId',t.id,'invoiceNo',t.invoice_no,'version',before_t.version+1,
    'state',new_state,'total',t.total,'paid',t.paid,'remaining',t.remaining,'refundDue',new_refund);
  UPDATE pos_security.invoice_operations SET result=v_result WHERE operation_id=p_operation_id;
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM pos_security.invoice_operations x WHERE x.operation_id=p_operation_id AND x.result=v_result
    AND x.actor_id=actor.auth_user_id AND x.order_id=t.id AND x.fingerprint=invoice_op.fingerprint) THEN
    RAISE EXCEPTION 'invoice operation mismatch' USING ERRCODE='23514'; END IF;
  DELETE FROM pos_security.invoice_write_context WHERE transaction_id=txid_current();
  IF EXISTS(SELECT 1 FROM pos_security.invoice_write_context WHERE transaction_id=txid_current()) THEN
    RAISE EXCEPTION 'invoice capability cleanup failed' USING ERRCODE='23514'; END IF;
  RETURN v_result;
END $$;

CREATE FUNCTION public.pos_invoice_change_status(p_operation_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE actor record; op pos_security.invoice_operations; t public.transactions;
BEGIN
  SELECT * INTO actor FROM public.pos_current_profile();
  IF actor.id IS NULL THEN RAISE EXCEPTION 'invoice access denied' USING ERRCODE='42501'; END IF;
  SELECT * INTO op FROM pos_security.invoice_operations WHERE operation_id=p_operation_id AND actor_id=actor.auth_user_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('state','unknown'); END IF;
  SELECT * INTO t FROM public.transactions WHERE id=op.order_id;
  IF NOT FOUND OR (pos_security.business_manager() OR (t.cashier_id=actor.id AND pos_security.business_book(t.book_id))) IS NOT TRUE THEN
    RAISE EXCEPTION 'invoice access denied' USING ERRCODE='42501'; END IF;
  RETURN CASE WHEN op.result IS NULL THEN jsonb_build_object('state','pending') ELSE jsonb_build_object('state','complete','result',op.result) END;
END $$;

REVOKE ALL ON FUNCTION pos_security.invoice_version(),pos_security.invoice_quote(jsonb,numeric,numeric,numeric),
  pos_security.invoice_verify_original_receipts(uuid,uuid),
  pos_security.invoice_verify_ledger(uuid,numeric,numeric,numeric,numeric,text),
  public.pos_apply_invoice_change(uuid,uuid,bigint,text,jsonb),public.pos_invoice_change_status(uuid)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.pos_apply_invoice_change(uuid,uuid,bigint,text,jsonb),public.pos_invoice_change_status(uuid) TO authenticated;
COMMIT;
