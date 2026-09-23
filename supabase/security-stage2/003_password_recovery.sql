-- Candidate only, outside automatic migrations. NO production execution.
-- Apply after 001 and 002 on an isolated database with auth.jwt/auth.sessions.
-- Server contract: verify owner bearer/current password, commit begin, perform
-- Auth password update, then finish ONLY on confirmed success. An ambiguous
-- Auth/update/finish failure stays locked; there is deliberately no auto-unlock.
-- p_actor is the server-verified Auth user ID; p_target_admin is the legacy ID.
-- Use a fresh operation UUID per attempt; never reuse a completed operation.
-- These RPCs cannot verify the external Auth update or protect business tables
-- that bypass pos_current_profile. Full RLS/Storage and real Auth tests remain gates.
BEGIN;

ALTER TABLE pos_security.user_access
  ADD COLUMN sessions_valid_after timestamptz NOT NULL DEFAULT '-infinity',
  ADD COLUMN reset_operation uuid;

CREATE OR REPLACE FUNCTION public.pos_current_profile()
RETURNS TABLE (id uuid, username text, name text, role text, auth_user_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT a.id, a.username, coalesce(nullif(a.name, ''), a.username), m.role, m.auth_user_id
  FROM pos_security.user_access AS m
  JOIN public.admins AS a ON a.id = m.admin_id
  WHERE m.auth_user_id = (SELECT auth.uid())
    AND m.active = true
    AND m.reset_operation IS NULL
    AND EXISTS (
      SELECT 1 FROM auth.sessions AS s
      WHERE s.user_id = m.auth_user_id
        -- CASE guards the cast regardless of predicate evaluation order.
        AND s.id = (SELECT CASE
          WHEN auth.jwt()->>'session_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          THEN (auth.jwt()->>'session_id')::uuid
          ELSE NULL::uuid END)
        -- A refreshed JWT keeps its session ID; iat/exp are not a reset fence.
        AND s.created_at > m.sessions_valid_after
    )
$$;
REVOKE ALL ON FUNCTION public.pos_current_profile() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pos_current_profile() TO authenticated;

-- Only immutable identifiers/state transitions, never passwords or JWTs.
-- No cascading foreign keys: retain the audit after account deletion.
CREATE TABLE pos_security.password_reset_audit (
  operation uuid NOT NULL,
  event text NOT NULL CHECK (event IN ('begun', 'finished')),
  actor_auth_user_id uuid NOT NULL,
  target_admin_id uuid NOT NULL,
  target_auth_user_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (operation, event)
);
ALTER TABLE pos_security.password_reset_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pos_security.password_reset_audit FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.pos_begin_staff_password_reset(p_actor uuid, p_target_admin uuid, p_operation uuid)
RETURNS TABLE (auth_user_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  actor pos_security.user_access%ROWTYPE;
  target pos_security.user_access%ROWTYPE;
  cutoff timestamptz;
BEGIN
  IF p_actor IS NULL OR p_target_admin IS NULL OR p_operation IS NULL THEN
    RAISE EXCEPTION 'password reset denied' USING ERRCODE = '42501';
  END IF;
  -- Both RPCs acquire the same mapping rows in Auth-ID order before checking
  -- authority/state. Keep mapping IDs immutable in administrative workflows.
  PERFORM m.auth_user_id FROM pos_security.user_access AS m
    WHERE m.auth_user_id = p_actor OR m.admin_id = p_target_admin
    ORDER BY m.auth_user_id FOR UPDATE;

  SELECT m.* INTO actor FROM pos_security.user_access AS m WHERE m.auth_user_id = p_actor;
  SELECT m.* INTO target FROM pos_security.user_access AS m WHERE m.admin_id = p_target_admin;
  IF actor.active IS DISTINCT FROM true OR actor.role IS DISTINCT FROM 'owner'
     OR actor.reset_operation IS NOT NULL
     OR target.active IS DISTINCT FROM true OR target.role NOT IN ('admin', 'staff')
     OR target.auth_user_id = p_actor OR target.reset_operation IS NOT NULL THEN
    RAISE EXCEPTION 'password reset denied' USING ERRCODE = '42501';
  END IF;

  cutoff := clock_timestamp();
  UPDATE pos_security.user_access AS m
    SET reset_operation = p_operation, sessions_valid_after = cutoff
    WHERE m.auth_user_id = target.auth_user_id;
  INSERT INTO pos_security.password_reset_audit
    (operation, event, actor_auth_user_id, target_admin_id, target_auth_user_id, occurred_at)
    VALUES (p_operation, 'begun', p_actor, target.admin_id, target.auth_user_id, cutoff);
  RETURN QUERY SELECT target.auth_user_id;
END
$$;
REVOKE ALL ON FUNCTION public.pos_begin_staff_password_reset(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pos_begin_staff_password_reset(uuid, uuid, uuid) TO service_role;

CREATE FUNCTION public.pos_finish_staff_password_reset(p_actor uuid, p_target_admin uuid, p_operation uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  actor pos_security.user_access%ROWTYPE;
  target pos_security.user_access%ROWTYPE;
  cutoff timestamptz;
BEGIN
  IF p_actor IS NULL OR p_target_admin IS NULL OR p_operation IS NULL THEN
    RAISE EXCEPTION 'password reset denied' USING ERRCODE = '42501';
  END IF;
  PERFORM m.auth_user_id FROM pos_security.user_access AS m
    WHERE m.auth_user_id = p_actor OR m.admin_id = p_target_admin
    ORDER BY m.auth_user_id FOR UPDATE;

  SELECT m.* INTO actor FROM pos_security.user_access AS m WHERE m.auth_user_id = p_actor;
  SELECT m.* INTO target FROM pos_security.user_access AS m WHERE m.admin_id = p_target_admin;
  IF actor.active IS DISTINCT FROM true OR actor.role IS DISTINCT FROM 'owner'
     OR actor.reset_operation IS NOT NULL
     OR target.active IS DISTINCT FROM true OR target.role NOT IN ('admin', 'staff')
     OR target.auth_user_id = p_actor OR target.reset_operation IS DISTINCT FROM p_operation THEN
    RAISE EXCEPTION 'password reset denied' USING ERRCODE = '42501';
  END IF;

  cutoff := clock_timestamp();
  UPDATE pos_security.user_access AS m
    SET reset_operation = NULL, sessions_valid_after = cutoff
    WHERE m.auth_user_id = target.auth_user_id;
  INSERT INTO pos_security.password_reset_audit
    (operation, event, actor_auth_user_id, target_admin_id, target_auth_user_id, occurred_at)
    VALUES (p_operation, 'finished', p_actor, target.admin_id, target.auth_user_id, cutoff);
  RETURN true;
END
$$;
REVOKE ALL ON FUNCTION public.pos_finish_staff_password_reset(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pos_finish_staff_password_reset(uuid, uuid, uuid) TO service_role;

COMMIT;
