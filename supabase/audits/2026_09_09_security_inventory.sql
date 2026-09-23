-- Stage 1: metadata-only inventory. Run with the project owner's SQL Editor.
-- No customer rows, password values, tokens, or function bodies are selected.
-- This transaction cannot modify application data or access rules.
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';

SELECT jsonb_pretty(jsonb_build_object(
  'checked_at', now(),
  'tables_and_views', (
    SELECT coalesce(jsonb_agg(jsonb_build_object(
      'schema', n.nspname, 'name', c.relname, 'kind', c.relkind,
      'rls_enabled', c.relrowsecurity, 'rls_forced', c.relforcerowsecurity,
      'view_options', c.reloptions,
      'anon_select', has_table_privilege('anon', c.oid, 'SELECT'),
      'anon_insert', has_table_privilege('anon', c.oid, 'INSERT'),
      'anon_update', has_table_privilege('anon', c.oid, 'UPDATE'),
      'anon_delete', has_table_privilege('anon', c.oid, 'DELETE'),
      'authenticated_select', has_table_privilege('authenticated', c.oid, 'SELECT'),
      'authenticated_insert', has_table_privilege('authenticated', c.oid, 'INSERT'),
      'authenticated_update', has_table_privilege('authenticated', c.oid, 'UPDATE'),
      'authenticated_delete', has_table_privilege('authenticated', c.oid, 'DELETE')
    ) ORDER BY n.nspname, c.relname), '[]'::jsonb)
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('public', 'storage') AND c.relkind IN ('r', 'p', 'v', 'm')
  ),
  'policies', (
    SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.schemaname, p.tablename, p.policyname), '[]'::jsonb)
    FROM pg_policies p WHERE p.schemaname IN ('public', 'storage')
  ),
  'public_functions', (
    SELECT coalesce(jsonb_agg(jsonb_build_object(
      'name', p.proname, 'arguments', oidvectortypes(p.proargtypes),
      'security_definer', p.prosecdef,
      'search_path', (SELECT s FROM unnest(p.proconfig) s WHERE s LIKE 'search_path=%' LIMIT 1),
      'anon_execute', has_function_privilege('anon', p.oid, 'EXECUTE'),
      'authenticated_execute', has_function_privilege('authenticated', p.oid, 'EXECUTE')
    ) ORDER BY p.proname, p.oid), '[]'::jsonb)
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prokind = 'f'
  ),
  'default_privileges', (
    SELECT coalesce(jsonb_agg(jsonb_build_object(
      'owner', pg_get_userbyid(d.defaclrole), 'schema', n.nspname,
      'object_type', d.defaclobjtype, 'acl', d.defaclacl::text
    )), '[]'::jsonb)
    FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
    WHERE d.defaclnamespace = 0 OR n.nspname IN ('public', 'storage')
  ),
  'credential_columns', (
    SELECT coalesce(jsonb_agg(jsonb_build_object(
      'table', c.table_name, 'column', c.column_name, 'type', c.data_type,
      'anon_select', has_column_privilege('anon', format('%I.%I', c.table_schema, c.table_name), c.column_name, 'SELECT')
    )), '[]'::jsonb)
    FROM information_schema.columns c WHERE c.table_schema = 'public'
      AND c.column_name ~* '(password|secret|token|hash)'
  ),
  'storage_buckets', (
    SELECT coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'public', b.public) ORDER BY b.id), '[]'::jsonb)
    FROM storage.buckets b
  ),
  'auth_user_count', (SELECT count(*) FROM auth.users)
)) AS security_inventory;

ROLLBACK;
