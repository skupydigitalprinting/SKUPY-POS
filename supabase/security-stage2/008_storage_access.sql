-- Candidate only. Apply with authenticated clients and business RLS after a backup.
BEGIN;

DO $$
DECLARE p record;
BEGIN
  IF (SELECT count(*) FROM storage.buckets) <> 3 OR
     (SELECT count(*) FROM storage.buckets WHERE id IN ('products','logos','invoices')) <> 3 THEN
    RAISE EXCEPTION 'Unexpected Storage buckets: review policies before cutover';
  END IF;
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname='storage' AND tablename='objects' LOOP
    EXECUTE format('DROP POLICY %I ON storage.objects',p.policyname);
  END LOOP;
  REVOKE ALL ON storage.objects FROM PUBLIC,anon,authenticated;
  FOR p IN SELECT attname FROM pg_attribute WHERE attrelid='storage.objects'::regclass AND attnum>0 AND NOT attisdropped LOOP
    EXECUTE format('REVOKE ALL (%I) ON storage.objects FROM PUBLIC,anon,authenticated',p.attname);
  END LOOP;
END $$;
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE,DELETE ON storage.objects TO authenticated;
GRANT USAGE ON SCHEMA storage,pos_security TO authenticated;

CREATE FUNCTION pos_security.can_access_invoice_object(object_name text)
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path=''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.pos_current_profile() p
    WHERE p.role IN ('owner','admin') OR (
      p.role='staff' AND EXISTS (
        SELECT 1 FROM public.transactions t
        WHERE t.id = CASE
          WHEN object_name ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/[^/]+$'
          THEN split_part(object_name,'/',1)::uuid END
      )
    )
  )
$$;
REVOKE ALL ON FUNCTION pos_security.can_access_invoice_object(text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION pos_security.can_access_invoice_object(text) TO authenticated;

CREATE POLICY pos_storage_read ON storage.objects FOR SELECT TO authenticated
USING (
  EXISTS(SELECT 1 FROM public.pos_current_profile()) AND (
    bucket_id IN ('products','logos') OR
    (bucket_id='invoices' AND pos_security.can_access_invoice_object(name))
  )
);
CREATE POLICY pos_storage_insert ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  EXISTS(SELECT 1 FROM public.pos_current_profile()) AND (
    bucket_id='products' OR
    (bucket_id='logos' AND (SELECT role FROM public.pos_current_profile())='owner') OR
    (bucket_id='invoices' AND pos_security.can_access_invoice_object(name))
  )
);
CREATE POLICY pos_storage_update ON storage.objects FOR UPDATE TO authenticated
USING (
  EXISTS(SELECT 1 FROM public.pos_current_profile()) AND (
    bucket_id='products' OR
    (bucket_id='logos' AND (SELECT role FROM public.pos_current_profile())='owner') OR
    (bucket_id='invoices' AND pos_security.can_access_invoice_object(name))
  )
)
WITH CHECK (
  EXISTS(SELECT 1 FROM public.pos_current_profile()) AND (
    bucket_id='products' OR
    (bucket_id='logos' AND (SELECT role FROM public.pos_current_profile())='owner') OR
    (bucket_id='invoices' AND pos_security.can_access_invoice_object(name))
  )
);
CREATE POLICY pos_storage_delete ON storage.objects FOR DELETE TO authenticated
USING (
  EXISTS(SELECT 1 FROM public.pos_current_profile()) AND (
    bucket_id='products' OR
    (bucket_id='logos' AND (SELECT role FROM public.pos_current_profile())='owner') OR
    (bucket_id='invoices' AND pos_security.can_access_invoice_object(name))
  )
);
UPDATE storage.buckets SET public=false WHERE id='invoices';
UPDATE storage.buckets SET file_size_limit=10485760,
  allowed_mime_types=ARRAY['image/png','image/jpeg','image/webp']
WHERE id IN ('products','logos','invoices');
COMMIT;
