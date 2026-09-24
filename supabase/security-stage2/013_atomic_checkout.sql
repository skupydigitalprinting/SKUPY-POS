-- Candidate only, after 011/012. Requires verified-session checkout clients.
BEGIN;
CREATE TABLE pos_security.checkout_operations (
  operation_id uuid PRIMARY KEY,
  actor_id uuid NOT NULL,
  book_id uuid NOT NULL,
  request jsonb,
  result jsonb,
  abandoned boolean NOT NULL DEFAULT false,
  CHECK ((abandoned AND request IS NULL AND result IS NULL) OR (NOT abandoned AND request IS NOT NULL)),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE pos_security.checkout_operations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pos_security.checkout_operations FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.pos_checkout_status(p_operation_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE actor record; op pos_security.checkout_operations;
BEGIN
  SELECT * INTO actor FROM public.pos_current_profile();
  IF actor.id IS NULL THEN RAISE EXCEPTION 'checkout denied' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM pos_security.user_access WHERE auth_user_id=actor.auth_user_id FOR SHARE;
  SELECT * INTO actor FROM public.pos_current_profile();
  IF actor.id IS NULL THEN RAISE EXCEPTION 'checkout denied' USING ERRCODE='42501'; END IF;
  SELECT * INTO op FROM pos_security.checkout_operations WHERE operation_id=p_operation_id AND actor_id=actor.auth_user_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('state','unknown'); END IF;
  IF pos_security.business_book(op.book_id) IS NOT TRUE THEN RAISE EXCEPTION 'checkout denied' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('state',CASE WHEN op.abandoned THEN 'abandoned' WHEN op.result IS NULL THEN 'pending' ELSE 'complete' END,
    'operationId',op.operation_id,'bookId',op.book_id,'request',op.request,'result',op.result);
END $$;

-- A terminal marker wins the same unique-operation lock as checkout. A delayed
-- request cannot create a sale after the browser is told it may start again.
CREATE FUNCTION public.pos_abandon_checkout(p_operation_id uuid,p_book_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE actor record; op pos_security.checkout_operations;
BEGIN
  SELECT * INTO actor FROM public.pos_current_profile();
  IF actor.id IS NULL THEN RAISE EXCEPTION 'checkout denied' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM pos_security.user_access WHERE auth_user_id=actor.auth_user_id FOR SHARE;
  SELECT * INTO actor FROM public.pos_current_profile();
  IF actor.id IS NULL OR pos_security.business_book(p_book_id) IS NOT TRUE THEN
    RAISE EXCEPTION 'checkout denied' USING ERRCODE='42501'; END IF;
  IF p_operation_id IS NULL OR p_book_id IS NULL THEN RAISE EXCEPTION 'invalid checkout identity' USING ERRCODE='22023'; END IF;
  IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'isolation unsupported' USING ERRCODE='25000'; END IF;
  INSERT INTO pos_security.checkout_operations(operation_id,actor_id,book_id,abandoned)
    VALUES(p_operation_id,actor.auth_user_id,p_book_id,true) ON CONFLICT DO NOTHING;
  SELECT * INTO op FROM pos_security.checkout_operations WHERE operation_id=p_operation_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'checkout evidence missing' USING ERRCODE='23514'; END IF;
  IF op.actor_id IS DISTINCT FROM actor.auth_user_id OR op.book_id IS DISTINCT FROM p_book_id THEN
    RAISE EXCEPTION 'checkout denied' USING ERRCODE='42501'; END IF;
  IF NOT op.abandoned AND op.result IS NULL THEN RAISE EXCEPTION 'checkout still pending' USING ERRCODE='40001'; END IF;
  RETURN public.pos_checkout_status(p_operation_id);
END $$;

CREATE FUNCTION public.pos_checkout(p_operation_id uuid,p_request jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET timezone = 'Asia/Jakarta' AS $$
DECLARE actor record; op pos_security.checkout_operations; t public.transactions; d public.debts;
  c public.customers; b public.books; p public.products; settings public.settings;
  profile public.admin_invoice_profiles; bank public.store_bank_accounts;
  location public.store_locations; contact public.store_contacts;
  book_id uuid; customer_id uuid; quote jsonb; item jsonb; expected jsonb; saved jsonb;
  created timestamptz:=clock_timestamp(); invoice text; order_no text; total numeric; paid numeric; remaining numeric;
  method text; due date; cashier_name text; baseline pos_security.payment_baselines;
BEGIN
  SELECT * INTO actor FROM public.pos_current_profile();
  IF actor.id IS NULL THEN RAISE EXCEPTION 'checkout denied' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM pos_security.user_access WHERE auth_user_id=actor.auth_user_id FOR SHARE;
  SELECT * INTO actor FROM public.pos_current_profile();
  IF actor.id IS NULL THEN RAISE EXCEPTION 'checkout denied' USING ERRCODE='42501'; END IF;
  IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'isolation unsupported' USING ERRCODE='25000'; END IF;
  IF p_operation_id IS NULL OR p_request IS NULL OR jsonb_typeof(p_request)<>'object'
    OR NOT p_request ?& ARRAY['bookId','customerId','customerName','items','discount','paid','method','dueDate','notes']
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_request) k WHERE k NOT IN
      ('bookId','customerId','customerName','items','discount','paid','method','dueDate','notes'))
    OR jsonb_typeof(p_request->'bookId') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_request->'customerId') NOT IN ('string','null')
    OR jsonb_typeof(p_request->'customerName') IS DISTINCT FROM 'string'
    OR length(btrim(p_request->>'customerName')) NOT BETWEEN 1 AND 256
    OR jsonb_typeof(p_request->'discount') IS DISTINCT FROM 'number'
    OR jsonb_typeof(p_request->'paid') IS DISTINCT FROM 'number'
    OR jsonb_typeof(p_request->'method') IS DISTINCT FROM 'string'
    OR p_request->>'method' NOT IN ('cash','transfer','qris','hutang')
    OR jsonb_typeof(p_request->'notes') IS DISTINCT FROM 'string' OR length(p_request->>'notes')>4000
    OR (p_request->'dueDate'<>'null'::jsonb AND (jsonb_typeof(p_request->'dueDate')<>'string'
      OR p_request->>'dueDate' !~ '^\d{4}-\d{2}-\d{2}$')) THEN
    RAISE EXCEPTION 'invalid checkout request' USING ERRCODE='22023'; END IF;
  book_id:=(p_request->>'bookId')::uuid; customer_id:=(p_request->>'customerId')::uuid;
  due:=(p_request->>'dueDate')::date; method:=p_request->>'method';
  quote:=pos_security.invoice_quote(p_request->'items',(p_request->>'discount')::numeric,0,(p_request->>'paid')::numeric);
  total:=(quote->>'total')::numeric; paid:=(quote->>'paid')::numeric; remaining:=(quote->>'remaining')::numeric;
  IF paid>total OR (paid>0 AND method='hutang') OR (remaining>0 AND (customer_id IS NULL OR due IS NULL)) THEN
    RAISE EXCEPTION 'invalid checkout balance or customer' USING ERRCODE='22023'; END IF;
  INSERT INTO pos_security.checkout_operations(operation_id,actor_id,book_id,request)
    VALUES(p_operation_id,actor.auth_user_id,book_id,p_request) ON CONFLICT DO NOTHING;
  SELECT * INTO op FROM pos_security.checkout_operations WHERE operation_id=p_operation_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'checkout evidence missing' USING ERRCODE='23514'; END IF;
  IF op.actor_id IS DISTINCT FROM actor.auth_user_id THEN RAISE EXCEPTION 'checkout denied' USING ERRCODE='42501'; END IF;
  IF op.abandoned AND op.book_id=book_id THEN RETURN public.pos_checkout_status(p_operation_id); END IF;
  IF op.request IS DISTINCT FROM p_request OR op.book_id IS DISTINCT FROM book_id THEN
    RAISE EXCEPTION 'checkout request changed' USING ERRCODE='22023'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('skupy:business-invoice-binding:v1',0));
  SELECT * INTO b FROM public.books x WHERE x.id=book_id AND x.is_active AND x.deleted_at IS NULL FOR SHARE;
  IF NOT FOUND OR pos_security.business_book(book_id) IS NOT TRUE THEN RAISE EXCEPTION 'checkout denied' USING ERRCODE='42501'; END IF;
  IF op.result IS NOT NULL THEN RETURN public.pos_checkout_status(p_operation_id); END IF;
  IF customer_id IS NOT NULL THEN
    SELECT * INTO c FROM public.customers x WHERE x.id=customer_id AND x.deleted_at IS NULL FOR UPDATE;
    IF NOT FOUND OR c.book_id IS DISTINCT FROM book_id OR pos_security.business_customer(c.id) IS NOT TRUE THEN
      RAISE EXCEPTION 'checkout customer denied' USING ERRCODE='42501'; END IF;
  END IF;
  FOR item IN SELECT * FROM jsonb_array_elements(p_request->'items') LOOP
    SELECT * INTO p FROM public.products WHERE id=(item->>'productId')::uuid FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'checkout product unavailable' USING ERRCODE='22023'; END IF;
  END LOOP;
  SELECT * INTO settings FROM public.settings WHERE id=1;
  SELECT * INTO profile FROM public.admin_invoice_profiles WHERE admin_id=actor.id AND is_active AND deleted_at IS NULL;
  SELECT * INTO bank FROM public.store_bank_accounts WHERE id=profile.bank_account_id AND is_active AND deleted_at IS NULL;
  IF bank.id IS NULL THEN
    SELECT (jsonb_populate_record(NULL::public.store_bank_accounts,to_jsonb(x))).* INTO bank FROM public.admin_bank_accounts x
      WHERE x.admin_id=actor.id AND x.is_active AND x.deleted_at IS NULL ORDER BY x.is_default DESC,x.created_at,x.id LIMIT 1;
  END IF;
  SELECT * INTO location FROM public.store_locations WHERE id=profile.location_id AND is_active AND deleted_at IS NULL;
  SELECT * INTO contact FROM public.store_contacts WHERE id=profile.contact_id AND is_active AND deleted_at IS NULL;
  cashier_name:=coalesce(actor.name,'');
  invoice:='INV-'||to_char(created,'YYYYMMDD')||'-'||replace(p_operation_id::text,'-','');
  order_no:='ORD-'||to_char(created,'YYYYMMDD')||'-'||replace(p_operation_id::text,'-','');
  expected:=jsonb_build_object('id',gen_random_uuid(),'invoice_no',invoice,'order_no',order_no,
    'customer_id',customer_id,'customer',btrim(p_request->>'customerName'),'customer_name',btrim(p_request->>'customerName'),
    'customer_phone',coalesce(nullif(c.whatsapp,''),c.phone,''),'customer_address',coalesce(c.address,''),
    'items',p_request->'items','subtotal',(quote->>'subtotal')::numeric,'discount',(quote->>'discount')::numeric,
    'tax',0,'total',total,'paid',paid,'dp',paid,'remaining',remaining,'payment_method',method,
    'status',CASE WHEN remaining=0 THEN 'lunas' ELSE 'pending' END,'order_status','menunggu',
    'cashier',cashier_name,'cashier_name',cashier_name,'cashier_id',actor.id,'cashier_role',actor.role,
    'created_by_admin_id',actor.id,'owner_user_id',coalesce(c.owner_user_id,actor.id),'owner_name',coalesce(c.owner_name,cashier_name),
    'created_at',created,'book_id',book_id,'due_date',due,'notes',p_request->>'notes','version',0,
    'bank_account_id',bank.id,'bank_name',coalesce(bank.bank_name,settings.bank_name,''),
    'bank_account_number',coalesce(bank.account_number,settings.bank_number,''),'bank_account_holder',coalesce(bank.account_holder,settings.bank_holder,''),
    'store_name_snapshot',coalesce(location.store_name,location.location_name,settings.name,''),
    'address_snapshot',coalesce(location.address,settings.address,''),'phone_snapshot',coalesce(nullif(contact.whatsapp,''),contact.phone,settings.phone,''),
    'status_history',jsonb_build_array(jsonb_build_object('order_status','menunggu','changed_at',created,'changed_by',cashier_name)));
  INSERT INTO public.transactions SELECT * FROM jsonb_populate_record(NULL::public.transactions,expected) RETURNING * INTO t;
  IF NOT FOUND THEN RAISE EXCEPTION 'checkout invoice missing' USING ERRCODE='23514'; END IF;
  SELECT * INTO t FROM public.transactions WHERE id=(expected->>'id')::uuid;
  IF NOT FOUND OR (to_jsonb(t) @> expected) IS NOT TRUE THEN RAISE EXCEPTION 'checkout invoice mismatch' USING ERRCODE='23514'; END IF;
  IF remaining>0 THEN
    INSERT INTO public.debts(transaction_id,invoice_no,customer_id,book_id,cashier_id,cashier_name,customer_name,customer_phone,
      total_debt,paid,remaining,due_date,status,notes,is_opening)
      VALUES(t.id,invoice,c.id,book_id,actor.id,cashier_name,c.name,c.phone,total,paid,remaining,due,'aktif',p_request->>'notes',false)
      RETURNING * INTO d;
    IF NOT FOUND THEN RAISE EXCEPTION 'checkout debt missing' USING ERRCODE='23514'; END IF;
    SELECT * INTO d FROM public.debts WHERE transaction_id=t.id;
    IF NOT FOUND OR d.invoice_no IS DISTINCT FROM invoice OR d.customer_id IS DISTINCT FROM c.id OR d.book_id IS DISTINCT FROM book_id
      OR d.total_debt IS DISTINCT FROM total OR d.paid IS DISTINCT FROM paid OR d.remaining IS DISTINCT FROM remaining
      OR d.status IS DISTINCT FROM 'aktif' OR d.deleted_at IS NOT NULL OR d.due_date IS DISTINCT FROM due THEN
      RAISE EXCEPTION 'checkout debt mismatch' USING ERRCODE='23514'; END IF;
    PERFORM pos_security.payment_check_initial(t.id,d.id);
    INSERT INTO pos_security.payment_baselines(invoice_no,order_id,debt_id,total,initial_paid,initial_snapshot,attested_by,evidence_ref)
      VALUES(invoice,t.id,d.id,total,paid,to_jsonb(t),actor.auth_user_id,'checkout:'||p_operation_id::text) RETURNING * INTO baseline;
    IF NOT FOUND OR baseline.initial_snapshot IS DISTINCT FROM to_jsonb(t) OR baseline.invoice_no IS DISTINCT FROM invoice
      OR baseline.order_id IS DISTINCT FROM t.id OR baseline.debt_id IS DISTINCT FROM d.id OR baseline.total IS DISTINCT FROM total
      OR baseline.initial_paid IS DISTINCT FROM paid OR baseline.attested_by IS DISTINCT FROM actor.auth_user_id THEN
      RAISE EXCEPTION 'checkout baseline mismatch' USING ERRCODE='23514'; END IF;
  END IF;
  PERFORM pos_security.invoice_verify_original_receipts(t.id,d.id);
  PERFORM public.recalculate_customer_summary(customer_id);
  IF customer_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.customers x WHERE x.id=customer_id
    AND x.total_transactions=(SELECT count(*) FROM public.transactions y WHERE y.customer_id=x.id AND y.deleted_at IS NULL AND coalesce(y.order_status,'') NOT IN ('dibatalkan','cancelled','canceled'))
    AND x.total_spent=coalesce((SELECT sum(y.total) FROM public.transactions y WHERE y.customer_id=x.id AND y.deleted_at IS NULL AND coalesce(y.order_status,'') NOT IN ('dibatalkan','cancelled','canceled')),0)
    AND x.total_debt=coalesce((SELECT sum(y.remaining) FROM public.debts y WHERE y.customer_id=x.id AND y.deleted_at IS NULL AND y.status='aktif'),0)) THEN
    RAISE EXCEPTION 'checkout customer summary mismatch' USING ERRCODE='23514'; END IF;
  UPDATE pos_security.checkout_operations SET result=to_jsonb(t) WHERE operation_id=p_operation_id;
  SELECT result INTO saved FROM pos_security.checkout_operations WHERE operation_id=p_operation_id;
  IF saved IS DISTINCT FROM to_jsonb(t) THEN RAISE EXCEPTION 'checkout receipt missing' USING ERRCODE='23514'; END IF;
  RETURN public.pos_checkout_status(p_operation_id);
END $$;

REVOKE INSERT ON public.transactions FROM authenticated;
REVOKE ALL ON FUNCTION public.pos_checkout(uuid,jsonb),public.pos_checkout_status(uuid),public.pos_abandon_checkout(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.pos_checkout(uuid,jsonb),public.pos_checkout_status(uuid),public.pos_abandon_checkout(uuid,uuid) TO authenticated;
COMMIT;
