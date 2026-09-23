-- Candidate only, outside automatic migrations. NO production execution.
-- Apply after 001 through 004 on an isolated database; earlier SQL is unchanged.
-- Display data for the owner reset picker, not a login resolver or reset grant.
BEGIN;

CREATE FUNCTION public.pos_resettable_staff()
RETURNS TABLE (id uuid, username text, name text, role text, reset_pending boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  -- Reuse the trusted active mapping, pending-reset and session-creation fence.
  IF NOT EXISTS (SELECT 1 FROM public.pos_current_profile() AS p WHERE p.role = 'owner') THEN
    RAISE EXCEPTION 'staff directory denied' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
    SELECT a.id, coalesce(m.login_username, a.username),
      coalesce(nullif(a.name, ''), m.login_username, a.username),
      m.role, m.reset_operation IS NOT NULL
    FROM pos_security.user_access AS m
    JOIN public.admins AS a ON a.id = m.admin_id
    WHERE m.active = true AND m.role IN ('admin', 'staff')
    ORDER BY coalesce(m.login_username, a.username), a.id;
END
$$;
REVOKE ALL ON FUNCTION public.pos_resettable_staff() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pos_resettable_staff() TO authenticated;

COMMIT;
