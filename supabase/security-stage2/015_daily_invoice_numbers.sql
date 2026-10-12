-- After 013. Only new checkout receipts receive a daily, global SKP number.
-- Existing invoice references, order numbers, payments and replay receipts stay intact.
BEGIN;
SET LOCAL lock_timeout = '10s';

CREATE TABLE IF NOT EXISTS pos_security.invoice_daily_counters (
  invoice_day date PRIMARY KEY,
  last_number bigint NOT NULL CHECK (last_number > 0)
);
ALTER TABLE pos_security.invoice_daily_counters ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pos_security.invoice_daily_counters FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION pos_security.next_invoice_number(p_created timestamptz) RETURNS text
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  business_day date := (p_created AT TIME ZONE 'Asia/Jakarta')::date;
  head text;
  next_number bigint;
  seed bigint;
BEGIN
  IF business_day IS NULL OR NOT isfinite(p_created) THEN
    RAISE EXCEPTION 'invalid invoice date' USING ERRCODE='22023';
  END IF;
  head := 'SKP-INV-' || to_char(business_day, 'YYYYMMDD') || '-';

  -- The row lock serializes allocations across cashiers and books. Never reset
  -- this high-water mark when a sale is cancelled or deleted.
  UPDATE pos_security.invoice_daily_counters SET last_number = last_number + 1
    WHERE invoice_day = business_day RETURNING last_number INTO next_number;
  IF NOT FOUND THEN
    -- Include all already-issued invoices on the first allocation of a day.
    SELECT greatest(
      (SELECT count(*) FROM public.transactions
        WHERE created_at >= business_day::timestamp AT TIME ZONE 'Asia/Jakarta'
          AND created_at < (business_day + 1)::timestamp AT TIME ZONE 'Asia/Jakarta'),
      coalesce((SELECT max(substring(invoice_no FROM length(head) + 1)::bigint)
        FROM public.transactions WHERE invoice_no ~ ('^' || head || '[0-9]{4,18}$')), 0)
    ) INTO seed;
    INSERT INTO pos_security.invoice_daily_counters AS counters(invoice_day,last_number)
      VALUES(business_day,seed + 1)
      ON CONFLICT (invoice_day) DO UPDATE SET last_number = counters.last_number + 1
      RETURNING last_number INTO next_number;
  END IF;
  RETURN head || lpad(next_number::text, greatest(4,length(next_number::text)), '0');
END $$;
REVOKE ALL ON FUNCTION pos_security.next_invoice_number(timestamptz) FROM PUBLIC,anon,authenticated,service_role;

-- Preserve the deployed checkout body and its security/replay checks. Fail closed
-- if the expected assignment changed, rather than replacing other production fixes.
DO $migration$
DECLARE
  definition text := pg_get_functiondef('public.pos_checkout(uuid,jsonb)'::regprocedure);
  old_assignment text := $old$invoice:='INV-'||to_char(created,'YYYYMMDD')||'-'||replace(p_operation_id::text,'-','');$old$;
  new_assignment text := 'invoice:=pos_security.next_invoice_number(created);';
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i JOIN pg_attribute a
      ON a.attrelid=i.indrelid AND a.attnum=i.indkey[0]
    WHERE i.indrelid='public.transactions'::regclass AND i.indisunique AND i.indisvalid
      AND i.indnkeyatts=1 AND i.indpred IS NULL AND a.attname='invoice_no'
  ) THEN
    RAISE EXCEPTION 'global invoice uniqueness constraint required';
  END IF;
  IF position(old_assignment IN definition)>0 THEN
    IF (length(definition)-length(replace(definition,old_assignment,'')))/length(old_assignment) <> 1 THEN
      RAISE EXCEPTION 'unexpected checkout numbering definition';
    END IF;
    EXECUTE replace(definition,old_assignment,new_assignment);
  ELSIF position(new_assignment IN definition)=0 THEN
    RAISE EXCEPTION 'checkout numbering assignment not recognized';
  END IF;
END $migration$;
COMMIT;
