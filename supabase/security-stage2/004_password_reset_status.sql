-- Candidate only, outside automatic migrations. NO production execution.
-- Apply after the original 003_password_recovery.sql on an isolated database.
-- Reconcile lost begin/finish responses via status: pending supplies the Auth ID
-- to continue the update; finished confirms completion, not current access.
-- Unavailable/unknown status means uncertain outcome (HTTP 503), not "locked".
-- This adds only the status RPC; do not replay 003 or alter its applied checksum.
BEGIN;

CREATE FUNCTION public.pos_staff_password_reset_status(p_actor uuid, p_target_admin uuid, p_operation uuid)
RETURNS TABLE (state text, auth_user_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  actor pos_security.user_access%ROWTYPE;
  begun pos_security.password_reset_audit%ROWTYPE;
BEGIN
  -- Wait for an in-flight transition using the same lock order as begin/finish.
  PERFORM m.auth_user_id FROM pos_security.user_access AS m
    WHERE m.auth_user_id = p_actor OR m.admin_id = p_target_admin
    ORDER BY m.auth_user_id FOR UPDATE;
  SELECT m.* INTO actor FROM pos_security.user_access AS m WHERE m.auth_user_id = p_actor;
  IF actor.active IS DISTINCT FROM true OR actor.role IS DISTINCT FROM 'owner'
     OR actor.reset_operation IS NOT NULL THEN
    RAISE EXCEPTION 'password reset denied' USING ERRCODE = '42501';
  END IF;
  IF p_target_admin IS NULL OR p_operation IS NULL THEN
    RETURN QUERY SELECT 'unknown'::text, NULL::uuid;
    RETURN;
  END IF;

  SELECT a.* INTO begun FROM pos_security.password_reset_audit AS a
    WHERE a.operation = p_operation AND a.event = 'begun'
      AND a.actor_auth_user_id = p_actor AND a.target_admin_id = p_target_admin;
  IF NOT FOUND THEN
    -- A foreign or incomplete operation must never expose its target identity.
    IF EXISTS (SELECT 1 FROM pos_security.password_reset_audit AS a WHERE a.operation = p_operation)
       OR EXISTS (SELECT 1 FROM pos_security.user_access AS m WHERE m.reset_operation = p_operation) THEN
      RETURN QUERY SELECT 'unknown'::text, NULL::uuid;
    ELSE
      RETURN QUERY SELECT 'not_started'::text, NULL::uuid;
    END IF;
    RETURN;
  END IF;

  -- Completion is historical: it survives later resets or mapping deletion.
  IF EXISTS (
    SELECT 1 FROM pos_security.password_reset_audit AS a
    WHERE a.operation = p_operation AND a.event = 'finished'
      AND a.actor_auth_user_id = p_actor AND a.target_admin_id = p_target_admin
      AND a.target_auth_user_id = begun.target_auth_user_id
  ) THEN
    RETURN QUERY SELECT 'finished'::text, begun.target_auth_user_id;
  ELSIF EXISTS (
    SELECT 1 FROM pos_security.user_access AS m
    WHERE m.admin_id = p_target_admin AND m.auth_user_id = begun.target_auth_user_id
      AND m.reset_operation = p_operation
  ) THEN
    RETURN QUERY SELECT 'pending'::text, begun.target_auth_user_id;
  ELSE
    RETURN QUERY SELECT 'unknown'::text, NULL::uuid;
  END IF;
END
$$;
REVOKE ALL ON FUNCTION public.pos_staff_password_reset_status(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pos_staff_password_reset_status(uuid, uuid, uuid) TO service_role;

COMMIT;
