-- CANDIDATE ONLY: outside automatic migrations. Apply after immutable 001-005.
-- Requires the reviewed 41-table catalog. No Storage or identity-table changes.
-- Cutover requires compatible clients and explicit staff book provisioning.
BEGIN;
SET LOCAL search_path = '';

CREATE FUNCTION pos_security.business_role() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT p.role FROM public.pos_current_profile() p
$$;
CREATE FUNCTION pos_security.business_admin_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT p.id FROM public.pos_current_profile() p
$$;
CREATE FUNCTION pos_security.business_manager() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(pos_security.business_role() IN ('owner','admin'), false)
$$;
CREATE FUNCTION pos_security.business_owner() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(pos_security.business_role() = 'owner', false)
$$;
CREATE FUNCTION pos_security.business_book(p_book uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT pos_security.business_manager() OR EXISTS (
    SELECT 1 FROM public.admin_book_access a JOIN public.books b ON b.id=a.book_id
    WHERE a.admin_id=pos_security.business_admin_id() AND a.book_id=p_book
      AND b.is_active AND b.deleted_at IS NULL
  )
$$;
CREATE FUNCTION pos_security.business_customer(p_customer uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT pos_security.business_manager() OR EXISTS (
    SELECT 1 FROM public.customers c WHERE c.id=p_customer
      AND c.owner_user_id=pos_security.business_admin_id()
      AND c.deleted_at IS NULL AND pos_security.business_book(c.book_id)
  )
$$;
CREATE FUNCTION pos_security.business_order(p_order uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT pos_security.business_manager() OR EXISTS (
    SELECT 1 FROM public.transactions t WHERE t.id=p_order
      AND t.cashier_id IS NOT NULL AND t.deleted_at IS NULL AND pos_security.business_book(t.book_id)
  )
$$;
CREATE FUNCTION pos_security.business_debt(p_debt uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT pos_security.business_manager() OR EXISTS (
    SELECT 1 FROM public.debts d JOIN public.customers c ON c.id=d.customer_id
    WHERE d.id=p_debt AND d.deleted_at IS NULL AND c.deleted_at IS NULL
      AND d.book_id=c.book_id AND c.owner_user_id=pos_security.business_admin_id()
      AND pos_security.business_book(d.book_id)
  )
$$;
CREATE FUNCTION pos_security.business_require(p_owner boolean DEFAULT false) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT (CASE WHEN p_owner THEN pos_security.business_owner() ELSE pos_security.business_manager() END) THEN
    RAISE EXCEPTION 'business access denied' USING ERRCODE='42501';
  END IF;
END
$$;

-- Explicit scope: never sweep auth, Storage, or the private identity schema.
DO $$
DECLARE t text; c text; p record;
  tables constant text[] := ARRAY[
    'products','product_categories','transactions','order_customer_changes','customers','debts','debt_payments',
    'customer_owner_changes','receivable_customer_changes','accounts','accounting_entries','cash_movements',
    'expenses','purchases','suppliers','supplier_debts','supplier_debt_payments','bank_loans','bank_loan_payments',
    'employees','employee_cash_advances','employee_cash_advance_payments','expense_categories','assets',
    'asset_categories','asset_purchase_payments','asset_sales','prepaid_rents','prepaid_rent_schedules',
    'liabilities','credibook_income','migration_details','settings','admins','books','admin_book_access',
    'admin_bank_accounts','admin_invoice_profiles','store_locations','store_contacts','store_bank_accounts'];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated',t);
    FOR c IN SELECT attname FROM pg_catalog.pg_attribute
      WHERE attrelid=format('public.%I',t)::regclass AND attnum>0 AND NOT attisdropped LOOP
      EXECUTE format('REVOKE SELECT (%1$I), INSERT (%1$I), UPDATE (%1$I), REFERENCES (%1$I) ON public.%2$I FROM PUBLIC, anon, authenticated',c,t);
    END LOOP;
    FOR p IN SELECT policyname FROM pg_catalog.pg_policies WHERE schemaname='public' AND tablename=t LOOP
      EXECUTE format('DROP POLICY %I ON public.%I',p.policyname,t);
    END LOOP;
  END LOOP;
END
$$;
REVOKE CREATE ON SCHEMA public FROM PUBLIC, anon, authenticated;
-- Remove both global and per-schema defaults for this migration's DDL owner.
ALTER DEFAULT PRIVILEGES REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES REVOKE ALL ON SEQUENCES FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC, anon, authenticated;

GRANT SELECT (id,name,category,price,stock,description,image,created_at,unit,is_favorite),
  INSERT (id,name,category,price,stock,description,image,unit,is_favorite),
  UPDATE (name,category,price,stock,description,image,unit,is_favorite), DELETE
  ON public.products TO authenticated;
CREATE POLICY business_catalog ON public.products FOR ALL TO authenticated
  USING (pos_security.business_role() IS NOT NULL) WITH CHECK (pos_security.business_role() IS NOT NULL);
GRANT SELECT,INSERT,UPDATE,DELETE ON public.product_categories TO authenticated;
CREATE POLICY business_catalog ON public.product_categories FOR ALL TO authenticated
  USING (pos_security.business_role() IS NOT NULL) WITH CHECK (pos_security.business_role() IS NOT NULL);

GRANT SELECT (id,username,name,role,created_at,updated_at) ON public.admins TO authenticated;
CREATE POLICY business_directory ON public.admins FOR SELECT TO authenticated
  USING (pos_security.business_manager() OR id=pos_security.business_admin_id());

DO $$
DECLARE t text; predicate text;
BEGIN
  FOREACH t IN ARRAY ARRAY['settings','books','admin_book_access','admin_bank_accounts',
    'admin_invoice_profiles','store_locations','store_contacts','store_bank_accounts'] LOOP
    predicate := CASE
      WHEN t='books' THEN 'pos_security.business_book(id)'
      WHEN t IN ('admin_book_access','admin_bank_accounts','admin_invoice_profiles')
        THEN '(pos_security.business_manager() OR admin_id=pos_security.business_admin_id())'
      ELSE 'pos_security.business_role() IS NOT NULL' END;
    EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON public.%I TO authenticated',t);
    EXECUTE format('CREATE POLICY business_read ON public.%I FOR SELECT TO authenticated USING (%s)',t,predicate);
    EXECUTE format('CREATE POLICY business_insert ON public.%I FOR INSERT TO authenticated WITH CHECK (pos_security.business_owner())',t);
    EXECUTE format('CREATE POLICY business_update ON public.%I FOR UPDATE TO authenticated USING (pos_security.business_owner()) WITH CHECK (pos_security.business_owner())',t);
    EXECUTE format('CREATE POLICY business_delete ON public.%I FOR DELETE TO authenticated USING (pos_security.business_owner())',t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['accounts','accounting_entries','cash_movements','expenses','purchases','suppliers',
    'supplier_debts','supplier_debt_payments','bank_loans','bank_loan_payments','employees','employee_cash_advances',
    'employee_cash_advance_payments','expense_categories','assets','asset_categories','asset_purchase_payments',
    'asset_sales','prepaid_rents','prepaid_rent_schedules','liabilities','credibook_income','migration_details'] LOOP
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated',t);
    EXECUTE format('CREATE POLICY business_read ON public.%I FOR SELECT TO authenticated USING (pos_security.business_manager())',t);
    IF t IN ('accounting_entries','cash_movements') THEN CONTINUE; END IF;
    predicate := CASE WHEN t IN ('accounts','migration_details') THEN 'pos_security.business_owner()' ELSE 'pos_security.business_manager()' END;
    EXECUTE format('GRANT INSERT,UPDATE,DELETE ON public.%I TO authenticated',t);
    EXECUTE format('CREATE POLICY business_insert ON public.%I FOR INSERT TO authenticated WITH CHECK (%s)',t,predicate);
    EXECUTE format('CREATE POLICY business_update ON public.%I FOR UPDATE TO authenticated USING (%s) WITH CHECK (%s)',t,predicate,predicate);
    EXECUTE format('CREATE POLICY business_delete ON public.%I FOR DELETE TO authenticated USING (pos_security.business_owner())',t);
  END LOOP;
END
$$;

GRANT SELECT,INSERT,UPDATE,DELETE ON public.transactions,public.customers,public.debts,public.debt_payments TO authenticated;
CREATE POLICY business_orders ON public.transactions FOR SELECT TO authenticated USING (
  pos_security.business_manager() OR (cashier_id IS NOT NULL AND deleted_at IS NULL AND pos_security.business_book(book_id)));
CREATE POLICY business_orders_insert ON public.transactions FOR INSERT TO authenticated WITH CHECK (
  pos_security.business_manager() OR (cashier_id=pos_security.business_admin_id() AND deleted_at IS NULL
    AND pos_security.business_book(book_id) AND (customer_id IS NULL OR pos_security.business_customer(customer_id))));
CREATE POLICY business_orders_update ON public.transactions FOR UPDATE TO authenticated
  USING (pos_security.business_order(id)) WITH CHECK (pos_security.business_manager() OR
    (cashier_id=pos_security.business_admin_id() AND deleted_at IS NULL AND pos_security.business_book(book_id)));
CREATE POLICY business_orders_delete ON public.transactions FOR DELETE TO authenticated USING (pos_security.business_owner());
CREATE POLICY business_customers ON public.customers FOR SELECT TO authenticated
  USING (pos_security.business_manager() OR (owner_user_id=pos_security.business_admin_id() AND deleted_at IS NULL AND pos_security.business_book(book_id)));
CREATE POLICY business_customers_insert ON public.customers FOR INSERT TO authenticated
  WITH CHECK (pos_security.business_manager() OR (owner_user_id=pos_security.business_admin_id() AND deleted_at IS NULL AND pos_security.business_book(book_id)));
CREATE POLICY business_customers_update ON public.customers FOR UPDATE TO authenticated
  USING (pos_security.business_customer(id)) WITH CHECK (pos_security.business_manager() OR
    (owner_user_id=pos_security.business_admin_id() AND deleted_at IS NULL AND pos_security.business_book(book_id)));
CREATE POLICY business_customers_delete ON public.customers FOR DELETE TO authenticated USING (pos_security.business_owner());
CREATE POLICY business_debts ON public.debts FOR SELECT TO authenticated USING (pos_security.business_debt(id));
CREATE POLICY business_debts_insert ON public.debts FOR INSERT TO authenticated WITH CHECK (
  pos_security.business_manager() OR (pos_security.business_customer(customer_id) AND pos_security.business_book(book_id) AND deleted_at IS NULL));
CREATE POLICY business_debts_update ON public.debts FOR UPDATE TO authenticated
  USING (pos_security.business_debt(id)) WITH CHECK (pos_security.business_manager() OR
    (pos_security.business_customer(customer_id) AND pos_security.business_book(book_id) AND deleted_at IS NULL));
CREATE POLICY business_debts_delete ON public.debts FOR DELETE TO authenticated USING (pos_security.business_owner());
CREATE POLICY business_payments ON public.debt_payments FOR SELECT TO authenticated
  USING (pos_security.business_manager() OR (pos_security.business_debt(debt_id) AND pos_security.business_book(book_id) AND deleted_at IS NULL));
CREATE POLICY business_payments_insert ON public.debt_payments FOR INSERT TO authenticated WITH CHECK (
  pos_security.business_manager() OR (pos_security.business_debt(debt_id) AND pos_security.business_book(book_id) AND deleted_at IS NULL));
CREATE POLICY business_payments_update ON public.debt_payments FOR UPDATE TO authenticated
  USING (pos_security.business_manager()) WITH CHECK (pos_security.business_manager());
CREATE POLICY business_payments_delete ON public.debt_payments FOR DELETE TO authenticated USING (pos_security.business_owner());
GRANT SELECT ON public.order_customer_changes,public.customer_owner_changes,public.receivable_customer_changes TO authenticated;
CREATE POLICY business_audit ON public.order_customer_changes FOR SELECT TO authenticated USING (pos_security.business_order(order_id));
CREATE POLICY business_audit ON public.customer_owner_changes FOR SELECT TO authenticated USING (pos_security.business_customer(customer_id));
CREATE POLICY business_audit ON public.receivable_customer_changes FOR SELECT TO authenticated USING (pos_security.business_manager());

-- Invoker guard: only actual table-owner execution can bypass immutable fields.
-- This permits reviewed nested definer triggers, never a caller-set GUC or role claim.
CREATE FUNCTION pos_security.business_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE p record; before_row jsonb; after_row jsonb; k text; parent record;
  locked text[] := ARRAY['id','code','created_at','book_id','cashier_id','created_by','created_by_admin_id',
    'owner_user_id','customer_id','transaction_id','debt_id','supplier_debt_id','cash_advance_id','asset_id',
    'loan_id','prepaid_rent_id','employee_id','supplier_id','purchase_id','invoice_no','order_no'];
BEGIN
  IF current_user = (SELECT pg_catalog.pg_get_userbyid(c.relowner) FROM pg_catalog.pg_class c WHERE c.oid=TG_RELID) THEN RETURN NEW; END IF;
  SELECT * INTO p FROM public.pos_current_profile();
  IF p.id IS NULL THEN RAISE EXCEPTION 'business access denied' USING ERRCODE='42501'; END IF;
  after_row := to_jsonb(NEW);
  IF TG_OP='UPDATE' THEN
    before_row := to_jsonb(OLD);
    FOREACH k IN ARRAY locked LOOP
      IF before_row->k IS DISTINCT FROM after_row->k THEN
        RAISE EXCEPTION 'immutable business field: %',k USING ERRCODE='42501';
      END IF;
    END LOOP;
    IF TG_TABLE_NAME='customers' THEN
      FOREACH k IN ARRAY ARRAY['total_transactions','total_spent','total_debt'] LOOP
        IF before_row->k IS DISTINCT FROM after_row->k THEN RAISE EXCEPTION 'derived customer field' USING ERRCODE='42501'; END IF;
      END LOOP;
    END IF;
    IF p.role='staff' AND TG_TABLE_NAME='transactions' AND
      (before_row - ARRAY['paid','dp','remaining','payment_method','status','order_status','status_history','notes','due_date'])
      IS DISTINCT FROM (after_row - ARRAY['paid','dp','remaining','payment_method','status','order_status','status_history','notes','due_date']) THEN
      RAISE EXCEPTION 'staff order edit denied' USING ERRCODE='42501';
    END IF;
    IF p.role='staff' AND TG_TABLE_NAME='debts' AND
      (before_row - ARRAY['paid','remaining','status','notes','due_date','updated_at'])
      IS DISTINCT FROM (after_row - ARRAY['paid','remaining','status','notes','due_date','updated_at']) THEN
      RAISE EXCEPTION 'staff debt edit denied' USING ERRCODE='42501';
    END IF;
    IF TG_TABLE_NAME IN ('supplier_debts','employee_cash_advances') AND before_row->'paid' IS DISTINCT FROM after_row->'paid' THEN
      RAISE EXCEPTION 'payment-derived balance' USING ERRCODE='42501';
    END IF;
  ELSE
    IF TG_TABLE_NAME='customers' THEN
      IF coalesce(NEW.total_transactions,0)<>0 OR coalesce(NEW.total_spent,0)<>0 OR coalesce(NEW.total_debt,0)<>0 THEN
        RAISE EXCEPTION 'derived customer field' USING ERRCODE='42501';
      END IF;
    END IF;
    -- Actor fields are attribution, not authorization; reject impersonation.
    FOREACH k IN ARRAY ARRAY['cashier_id','created_by','created_by_admin_id'] LOOP
      IF after_row ? k THEN
        IF after_row->>k IS NOT NULL AND after_row->>k <> p.id::text THEN
          RAISE EXCEPTION 'actor attribution denied' USING ERRCODE='42501';
        END IF;
        after_row := jsonb_set(after_row,ARRAY[k],to_jsonb(p.id));
      END IF;
    END LOOP;
    NEW := jsonb_populate_record(NEW,after_row);
  END IF;
  IF TG_TABLE_NAME='transactions' THEN
    IF NEW.customer_id IS NOT NULL THEN
      SELECT c.book_id INTO parent FROM public.customers c WHERE c.id=NEW.customer_id;
      IF NOT FOUND OR parent.book_id IS DISTINCT FROM NEW.book_id THEN
        RAISE EXCEPTION 'customer/book mismatch' USING ERRCODE='42501';
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME='debts' THEN
    SELECT c.book_id INTO parent FROM public.customers c WHERE c.id=NEW.customer_id;
    IF NOT FOUND OR (NEW.book_id IS NOT NULL AND parent.book_id IS DISTINCT FROM NEW.book_id) THEN
      RAISE EXCEPTION 'customer/book mismatch' USING ERRCODE='42501';
    END IF;
    NEW.book_id := parent.book_id;
    IF NEW.transaction_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.transactions t
      WHERE t.id=NEW.transaction_id AND t.customer_id=NEW.customer_id AND t.book_id IS NOT DISTINCT FROM NEW.book_id) THEN
      RAISE EXCEPTION 'debt/order mismatch' USING ERRCODE='42501';
    END IF;
  ELSIF TG_TABLE_NAME='debt_payments' THEN
    SELECT d.book_id,d.customer_id,d.invoice_no INTO parent FROM public.debts d WHERE d.id=NEW.debt_id;
    IF NOT FOUND OR (NEW.book_id IS NOT NULL AND NEW.book_id IS DISTINCT FROM parent.book_id)
      OR (NEW.customer_id IS NOT NULL AND NEW.customer_id IS DISTINCT FROM parent.customer_id)
      OR (NEW.invoice_no IS NOT NULL AND NEW.invoice_no IS DISTINCT FROM parent.invoice_no) THEN
      RAISE EXCEPTION 'payment/debt mismatch' USING ERRCODE='42501';
    END IF;
    NEW.book_id := parent.book_id; NEW.customer_id := parent.customer_id; NEW.invoice_no := parent.invoice_no;
    IF NEW.amount IS NULL OR NEW.amount<=0 THEN RAISE EXCEPTION 'positive payment required' USING ERRCODE='22023'; END IF;
  END IF;
  RETURN NEW;
END
$$;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['transactions','customers','debts','debt_payments','expenses','purchases','suppliers',
    'supplier_debts','supplier_debt_payments','bank_loans','bank_loan_payments','employees',
    'employee_cash_advances','employee_cash_advance_payments','assets','asset_purchase_payments','asset_sales',
    'prepaid_rents','prepaid_rent_schedules','liabilities','credibook_income','migration_details'] LOOP
    EXECUTE format('CREATE TRIGGER "00_business_guard" BEFORE INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION pos_security.business_guard()',t);
  END LOOP;
END
$$;

-- Integrity, not authorization: this also checks nested definer writes. The
-- invoker guard and RLS still decide which rows the caller may change.
CREATE FUNCTION pos_security.business_invoice_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE d public.debts; t public.transactions; canonical text;
BEGIN
  -- Cross-table invoice uniqueness needs a common lock and fresh snapshots.
  -- Atomic RPCs must acquire this lock before taking their business row locks.
  IF current_setting('transaction_isolation') NOT IN ('read committed','read uncommitted') THEN
    RAISE EXCEPTION 'invoice writes require read committed isolation' USING ERRCODE='25000';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('skupy:business-invoice-binding:v1',0));
  IF TG_TABLE_NAME='transactions' THEN
    IF EXISTS (SELECT 1 FROM public.debts x WHERE
      (x.transaction_id=NEW.id AND (x.invoice_no IS DISTINCT FROM NEW.invoice_no
        OR x.customer_id IS DISTINCT FROM NEW.customer_id OR x.book_id IS DISTINCT FROM NEW.book_id))
      OR (x.invoice_no=NEW.invoice_no AND x.transaction_id IS DISTINCT FROM NEW.id))
      OR (SELECT count(*) FROM public.debts x WHERE x.transaction_id=NEW.id)>1
      OR EXISTS (SELECT 1 FROM public.debt_payments p JOIN public.debts x ON x.id=p.debt_id
        WHERE (p.invoice_no=NEW.invoice_no OR x.transaction_id=NEW.id) AND
          (x.transaction_id IS DISTINCT FROM NEW.id OR x.invoice_no IS DISTINCT FROM NEW.invoice_no
            OR p.invoice_no IS DISTINCT FROM NEW.invoice_no
            OR (p.customer_id IS NOT NULL AND p.customer_id IS DISTINCT FROM NEW.customer_id)
            OR (p.book_id IS NOT NULL AND p.book_id IS DISTINCT FROM NEW.book_id))) THEN
      RAISE EXCEPTION 'inconsistent invoice binding' USING ERRCODE='42501';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME='debts' THEN
    d := NEW;
  ELSE
    SELECT * INTO d FROM public.debts WHERE id=NEW.debt_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'inconsistent invoice binding' USING ERRCODE='42501'; END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.customers c WHERE c.id=d.customer_id AND c.book_id IS NOT DISTINCT FROM d.book_id) THEN
    RAISE EXCEPTION 'inconsistent invoice binding' USING ERRCODE='42501';
  END IF;
  IF d.transaction_id IS NOT NULL THEN
    SELECT * INTO t FROM public.transactions WHERE id=d.transaction_id;
    IF NOT FOUND OR t.customer_id IS DISTINCT FROM d.customer_id OR t.book_id IS DISTINCT FROM d.book_id THEN
      RAISE EXCEPTION 'inconsistent invoice binding' USING ERRCODE='42501';
    END IF;
    canonical := t.invoice_no;
    -- Only a new debt may omit the invoice. Existing missing/mismatched values
    -- require reviewed repair, never an implicit lookup or reassignment.
    IF d.invoice_no IS DISTINCT FROM canonical AND NOT
      (TG_TABLE_NAME='debts' AND TG_OP='INSERT' AND d.invoice_no IS NULL) THEN
      RAISE EXCEPTION 'inconsistent invoice binding' USING ERRCODE='42501';
    END IF;
  ELSE
    canonical := d.invoice_no;
    IF EXISTS (SELECT 1 FROM public.transactions x WHERE x.invoice_no=canonical) THEN
      RAISE EXCEPTION 'inconsistent invoice binding' USING ERRCODE='42501';
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM public.debts x WHERE x.id<>d.id AND
    (x.invoice_no=canonical OR (d.transaction_id IS NOT NULL AND x.transaction_id=d.transaction_id)))
    OR EXISTS (SELECT 1 FROM public.debt_payments p WHERE p.debt_id=d.id AND
      (p.invoice_no IS DISTINCT FROM canonical
        OR (p.customer_id IS NOT NULL AND p.customer_id IS DISTINCT FROM d.customer_id)
        OR (p.book_id IS NOT NULL AND p.book_id IS DISTINCT FROM d.book_id))) THEN
    RAISE EXCEPTION 'inconsistent invoice binding' USING ERRCODE='42501';
  END IF;
  IF TG_TABLE_NAME='debts' THEN
    NEW.invoice_no := canonical;
  ELSE
    IF (NEW.invoice_no IS NOT NULL AND NEW.invoice_no IS DISTINCT FROM canonical)
      OR (NEW.customer_id IS NOT NULL AND NEW.customer_id IS DISTINCT FROM d.customer_id)
      OR (NEW.book_id IS NOT NULL AND NEW.book_id IS DISTINCT FROM d.book_id) THEN
      RAISE EXCEPTION 'inconsistent invoice binding' USING ERRCODE='42501';
    END IF;
    NEW.invoice_no := canonical; NEW.customer_id := d.customer_id; NEW.book_id := d.book_id;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "01_business_invoice_guard" BEFORE INSERT OR UPDATE ON public.transactions
  FOR EACH ROW EXECUTE FUNCTION pos_security.business_invoice_guard();
CREATE TRIGGER "01_business_invoice_guard" BEFORE INSERT OR UPDATE ON public.debts
  FOR EACH ROW EXECUTE FUNCTION pos_security.business_invoice_guard();
CREATE TRIGGER "01_business_invoice_guard" BEFORE INSERT OR UPDATE ON public.debt_payments
  FOR EACH ROW EXECUTE FUNCTION pos_security.business_invoice_guard();

-- Complete the existing summary helper's event coverage without changing its
-- financial semantics. Run after legacy insert/delete triggers, not before them.
CREATE FUNCTION pos_security.business_customer_summary_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE old_customer uuid; new_customer uuid; customer uuid;
BEGIN
  IF TG_OP<>'INSERT' THEN old_customer := OLD.customer_id; END IF;
  IF TG_OP<>'DELETE' THEN new_customer := NEW.customer_id; END IF;
  -- Stable lock order also covers privileged maintenance that relinks a row.
  FOR customer IN SELECT c.id FROM public.customers c
    WHERE c.id=old_customer OR c.id=new_customer ORDER BY c.id FOR UPDATE LOOP
    PERFORM public.recalculate_customer_summary(customer);
  END LOOP;
  RETURN NULL;
END
$$;
CREATE TRIGGER zz_business_customer_summary AFTER INSERT OR UPDATE OR DELETE ON public.transactions
  FOR EACH ROW EXECUTE FUNCTION pos_security.business_customer_summary_changed();
CREATE TRIGGER zz_business_customer_summary AFTER INSERT OR UPDATE OR DELETE ON public.debts
  FOR EACH ROW EXECUTE FUNCTION pos_security.business_customer_summary_changed();

CREATE FUNCTION public.pos_product_costs() RETURNS TABLE(id uuid,modal numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM pos_security.business_require(true);
  RETURN QUERY SELECT p.id,p.modal FROM public.products p;
END
$$;
CREATE FUNCTION public.pos_save_product(p_id uuid,p_values jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_role text; v_row public.products; result jsonb; k text;
  allowed constant text[] := ARRAY['name','category','price','modal','stock','description','image','unit','is_favorite'];
BEGIN
  v_role := pos_security.business_role();
  IF v_role IS NULL OR (p_values ? 'modal' AND v_role<>'owner') THEN
    RAISE EXCEPTION 'product access denied' USING ERRCODE='42501';
  END IF;
  IF p_values IS NULL OR jsonb_typeof(p_values)<>'object' THEN
    RAISE EXCEPTION 'product object required' USING ERRCODE='22023';
  END IF;
  FOR k IN SELECT jsonb_object_keys(p_values) LOOP
    IF NOT k=ANY(allowed) THEN RAISE EXCEPTION 'unsupported product field' USING ERRCODE='22023'; END IF;
  END LOOP;
  IF p_id IS NULL THEN
    -- Let the real defaults supply omitted fields, then apply only supplied keys.
    INSERT INTO public.products(name) VALUES (p_values->>'name') RETURNING * INTO v_row;
  ELSE
    SELECT * INTO v_row FROM public.products WHERE id=p_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'product not found' USING ERRCODE='P0002'; END IF;
  END IF;
  v_row := jsonb_populate_record(v_row,p_values);
  UPDATE public.products SET name=v_row.name,category=v_row.category,price=v_row.price,modal=v_row.modal,
    stock=v_row.stock,description=v_row.description,image=v_row.image,unit=v_row.unit,is_favorite=v_row.is_favorite
    WHERE products.id=v_row.id RETURNING to_jsonb(products.*) INTO result;
  RETURN CASE WHEN v_role='owner' THEN result ELSE result-'modal' END;
EXCEPTION WHEN OTHERS THEN
  -- Definer constraint errors can include the full row, including hidden cost.
  -- Preserve the SQLSTATE without propagating row details or SQLERRM.
  RAISE EXCEPTION 'product save rejected' USING ERRCODE=SQLSTATE;
END
$$;

-- Preserve reviewed business bodies verbatim behind private checked wrappers.
ALTER FUNCTION public.acc_dashboard(date,date) SET SCHEMA pos_security;
ALTER FUNCTION public.acc_summary(date,date) SET SCHEMA pos_security;
ALTER FUNCTION public.acc_recap_admin(date,date) SET SCHEMA pos_security;
ALTER FUNCTION public.acc_delete_supplier_debt(uuid) SET SCHEMA pos_security;
ALTER FUNCTION public.acc_delete_employee_advance(uuid) SET SCHEMA pos_security;
ALTER FUNCTION public.acc_resync() SET SCHEMA pos_security;
CREATE FUNCTION public.acc_dashboard(p_from date,p_to date) RETURNS json
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN PERFORM pos_security.business_require(); RETURN pos_security.acc_dashboard(p_from,p_to); END $$;
CREATE FUNCTION public.acc_summary(p_from date,p_to date) RETURNS json
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN PERFORM pos_security.business_require(); RETURN pos_security.acc_summary(p_from,p_to); END $$;
CREATE FUNCTION public.acc_recap_admin(p_from date,p_to date) RETURNS TABLE(cashier_id uuid,revenue numeric,cash_in numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN PERFORM pos_security.business_require(); RETURN QUERY SELECT * FROM pos_security.acc_recap_admin(p_from,p_to); END $$;
CREATE FUNCTION public.acc_delete_supplier_debt(p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN PERFORM pos_security.business_require(); PERFORM pos_security.acc_delete_supplier_debt(p_id); END $$;
CREATE FUNCTION public.acc_delete_employee_advance(p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN PERFORM pos_security.business_require(true); PERFORM pos_security.acc_delete_employee_advance(p_id); END $$;
CREATE FUNCTION public.acc_resync() RETURNS json
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN PERFORM pos_security.business_require(true); RETURN pos_security.acc_resync(); END $$;
CREATE OR REPLACE FUNCTION public.acc_bootstrap_migration_details() RETURNS json
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN RAISE EXCEPTION 'bootstrap disabled; reviewed migrations only' USING ERRCODE='42501'; END $$;

-- These trigger helpers formerly ran as invoker and need narrowly-owned writes.
ALTER FUNCTION public.acc_asset_master_changed() SECURITY DEFINER;
ALTER FUNCTION public.acc_asset_payment_changed() SECURITY DEFINER;
ALTER FUNCTION public.acc_repost_asset_purchase(uuid) SECURITY DEFINER;
ALTER FUNCTION public.tg_bump_customer_stats() SECURITY DEFINER;
ALTER FUNCTION public.tg_recalc_customer_after_delete() SECURITY DEFINER;
ALTER FUNCTION public.recalculate_customer_summary(uuid) SECURITY DEFINER;
DO $$
DECLARE f record;
BEGIN
  FOR f IN SELECT p.oid::regprocedure signature FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    WHERE (n.nspname='pos_security' AND (p.proname LIKE 'business_%' OR p.proname=ANY(ARRAY[
      'acc_dashboard','acc_summary','acc_recap_admin','acc_delete_supplier_debt','acc_delete_employee_advance','acc_resync'])))
    OR (n.nspname='public' AND p.proname=ANY(ARRAY[
      'acc_bootstrap_migration_details','acc_cash_code','acc_dashboard','acc_summary','acc_recap_admin',
      'acc_delete_supplier_debt','acc_delete_employee_advance','acc_resync','acc_recalc_bank_loan',
      'acc_repost_asset_purchase','recalculate_customer_summary','acc_asset_master_changed','acc_asset_payment_changed',
      'acc_validate_asset_purchase_payment','acc_fn_post_transaction','acc_fn_post_expense','acc_fn_post_purchase',
      'acc_fn_post_supplier_debt','acc_fn_post_supplier_payment','acc_fn_post_bank_payment',
      'acc_fn_post_employee_advance','acc_fn_post_employee_advance_payment',
      'tg_bump_customer_stats','tg_recalc_customer_after_delete','tg_set_updated_at','rls_auto_enable',
      'pos_product_costs','pos_save_product'])) LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = %L',f.signature,'');
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role',f.signature);
  END LOOP;
END
$$;
GRANT USAGE ON SCHEMA pos_security TO authenticated;
GRANT EXECUTE ON FUNCTION pos_security.business_role(),pos_security.business_admin_id(),
  pos_security.business_manager(),pos_security.business_owner(),pos_security.business_book(uuid),
  pos_security.business_customer(uuid),pos_security.business_order(uuid),pos_security.business_debt(uuid)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.pos_product_costs(),public.pos_save_product(uuid,jsonb),
  public.acc_dashboard(date,date),public.acc_summary(date,date),public.acc_recap_admin(date,date),
  public.acc_delete_supplier_debt(uuid),public.acc_delete_employee_advance(uuid),public.acc_resync()
  TO authenticated;
COMMIT;
