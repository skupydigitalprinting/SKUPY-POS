-- Read-only checks executed in the production SQL Editor on 2026-09-09.
-- Contains query text only, never credentials or business records.

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';
SELECT jsonb_pretty(jsonb_build_object(
  'checked_at', now(),
  'tables', (SELECT jsonb_agg(jsonb_build_object(
    'name', c.relname, 'rls', c.relrowsecurity,
    'anon_select', has_table_privilege('anon', c.oid, 'SELECT'),
    'anon_insert', has_table_privilege('anon', c.oid, 'INSERT'),
    'anon_update', has_table_privilege('anon', c.oid, 'UPDATE'),
    'anon_delete', has_table_privilege('anon', c.oid, 'DELETE')
  ) ORDER BY c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')),
  'admin_policies', (SELECT jsonb_agg(to_jsonb(p)) FROM pg_policies p
    WHERE schemaname = 'public' AND tablename = 'admins'),
  'open_policy_count', (SELECT count(*) FROM pg_policies
    WHERE schemaname = 'public' AND qual = 'true' AND cmd = 'ALL'),
  'function_summary', (SELECT jsonb_build_object(
    'public_functions', count(*),
    'anon_executable', count(*) FILTER (WHERE has_function_privilege('anon', p.oid, 'EXECUTE')),
    'anon_security_definer', count(*) FILTER (WHERE p.prosecdef AND has_function_privilege('anon', p.oid, 'EXECUTE'))
  ) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prokind = 'f'),
  'password_column_anon_readable', has_column_privilege('anon', 'public.admins', 'password', 'SELECT'),
  'buckets', (SELECT jsonb_agg(jsonb_build_object('id', id, 'public', public)) FROM storage.buckets),
  'auth_user_count', (SELECT count(*) FROM auth.users)
)) AS security_inventory;
ROLLBACK;

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';
SELECT jsonb_pretty(jsonb_build_object(
  'policies', (SELECT jsonb_agg(to_jsonb(p) ORDER BY schemaname, tablename, policyname)
    FROM pg_policies p WHERE schemaname IN ('public', 'storage')),
  'functions', (SELECT jsonb_agg(jsonb_build_object(
    'name', p.proname, 'args', oidvectortypes(p.proargtypes), 'definer', p.prosecdef,
    'search_path', (SELECT s FROM unnest(p.proconfig) s WHERE s LIKE 'search_path=%' LIMIT 1),
    'anon_execute', has_function_privilege('anon', p.oid, 'EXECUTE'),
    'returns', p.prorettype::regtype::text
  ) ORDER BY p.proname) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prokind = 'f'),
  'admin_role_counts', (SELECT jsonb_agg(x) FROM
    (SELECT role, count(*) FROM public.admins GROUP BY role) x),
  'views', (SELECT jsonb_agg(jsonb_build_object('name', c.relname, 'options', c.reloptions))
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('v', 'm'))
)) AS security_details;
ROLLBACK;

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';
SELECT jsonb_pretty(jsonb_build_object(
  'schema_usage', (SELECT jsonb_agg(jsonb_build_object(
    'schema', nspname, 'anon', has_schema_privilege('anon', oid, 'USAGE'),
    'authenticated', has_schema_privilege('authenticated', oid, 'USAGE')
  )) FROM pg_namespace WHERE nspname IN ('public', 'storage')),
  'storage_grants', jsonb_build_object(
    'select', has_table_privilege('anon', 'storage.objects', 'SELECT'),
    'insert', has_table_privilege('anon', 'storage.objects', 'INSERT'),
    'update', has_table_privilege('anon', 'storage.objects', 'UPDATE'),
    'delete', has_table_privilege('anon', 'storage.objects', 'DELETE')
  ),
  'default_privileges', (SELECT jsonb_agg(jsonb_build_object(
    'owner', pg_get_userbyid(d.defaclrole), 'schema', n.nspname,
    'object_type', d.defaclobjtype, 'acl', d.defaclacl::text
  )) FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
    WHERE n.nspname = 'public' OR d.defaclnamespace = 0)
)) AS access_details;
ROLLBACK;
