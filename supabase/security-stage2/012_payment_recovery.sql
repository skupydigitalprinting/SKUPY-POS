-- Candidate only. Apply after 011 in an isolated environment before cutover.
BEGIN;
CREATE TABLE pos_security.payment_client_receipts (
  operation_id uuid PRIMARY KEY REFERENCES pos_security.payment_operations(operation_id),
  request jsonb NOT NULL,
  result jsonb NOT NULL
);
ALTER TABLE pos_security.payment_client_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pos_security.payment_client_receipts FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.pos_payment_status(p_operation_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE actor record; op pos_security.payment_operations; saved pos_security.payment_client_receipts;
  v_book uuid; found_binding boolean;
BEGIN
  SELECT * INTO actor FROM public.pos_current_profile();
  IF actor.id IS NULL THEN RAISE EXCEPTION 'payment status denied' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM pos_security.user_access WHERE auth_user_id=actor.auth_user_id FOR SHARE;
  SELECT * INTO actor FROM public.pos_current_profile();
  IF actor.id IS NULL THEN RAISE EXCEPTION 'payment status denied' USING ERRCODE='42501'; END IF;
  SELECT * INTO op FROM pos_security.payment_operations
    WHERE operation_id=p_operation_id AND actor_auth_user_id=actor.auth_user_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('state','unknown'); END IF;
  SELECT * INTO saved FROM pos_security.payment_client_receipts WHERE operation_id=op.operation_id;
  IF NOT FOUND OR op.result IS NULL THEN RETURN jsonb_build_object('state','pending'); END IF;
  -- A completed receipt remains recoverable after soft deletion, but never
  -- grants access to an operation created by a different authenticated actor.
  IF op.order_id IS NOT NULL THEN
    SELECT book_id INTO v_book FROM public.transactions WHERE id=op.order_id;
  ELSE
    SELECT book_id INTO v_book FROM public.debts WHERE id=op.debt_id;
  END IF;
  found_binding := FOUND;
  IF NOT found_binding OR pos_security.business_book(v_book) IS NOT TRUE THEN
    RAISE EXCEPTION 'payment status denied' USING ERRCODE='42501';
  END IF;
  IF saved.result IS DISTINCT FROM op.result THEN
    RAISE EXCEPTION 'payment receipt mismatch' USING ERRCODE='23514';
  END IF;
  RETURN jsonb_build_object('state','complete','operationId',op.operation_id,'request',saved.request,'result',saved.result);
END $$;

CREATE FUNCTION public.pos_submit_payment(
  p_operation_id uuid,p_invoice_no text,p_amount numeric,p_method text,p_notes text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE receipt jsonb; request jsonb; saved pos_security.payment_client_receipts; status jsonb;
BEGIN
  -- The existing atomic writer owns identity, access, replay, balance and
  -- ledger validation. This wrapper commits recovery evidence in the same TX.
  receipt := public.pos_record_payment(p_operation_id,p_invoice_no,p_amount,p_method,p_notes);
  request := jsonb_build_object('invoiceNo',btrim(p_invoice_no),'amount',p_amount,
    'method',lower(btrim(p_method)),'notes',coalesce(p_notes,''));
  INSERT INTO pos_security.payment_client_receipts(operation_id,request,result)
    VALUES (p_operation_id,request,receipt) ON CONFLICT DO NOTHING;
  SELECT * INTO saved FROM pos_security.payment_client_receipts WHERE operation_id=p_operation_id;
  IF NOT FOUND OR saved.request IS DISTINCT FROM request OR saved.result IS DISTINCT FROM receipt THEN
    RAISE EXCEPTION 'payment recovery evidence mismatch' USING ERRCODE='23514';
  END IF;
  status := public.pos_payment_status(p_operation_id);
  IF status->>'state' IS DISTINCT FROM 'complete' THEN
    RAISE EXCEPTION 'payment recovery unavailable' USING ERRCODE='23514';
  END IF;
  RETURN status;
END $$;

REVOKE ALL ON FUNCTION public.pos_submit_payment(uuid,text,numeric,text,text),public.pos_payment_status(uuid)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.pos_submit_payment(uuid,text,numeric,text,text),public.pos_payment_status(uuid) TO authenticated;
COMMIT;
