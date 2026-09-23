-- Candidate only. Not deployed; does not close legacy business policies.
-- Kept outside automatic migrations. Requires an isolated database first.
BEGIN;

CREATE SCHEMA pos_security;
REVOKE ALL ON SCHEMA pos_security FROM PUBLIC, anon, authenticated;

CREATE TABLE pos_security.user_access (
  auth_user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  admin_id uuid NOT NULL UNIQUE REFERENCES public.admins(id) ON DELETE RESTRICT,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'staff')),
  active boolean NOT NULL DEFAULT false
);
ALTER TABLE pos_security.user_access ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pos_security.user_access FROM PUBLIC, anon, authenticated;

-- No caller-supplied ID and no role read from editable legacy admin records.
CREATE FUNCTION public.pos_current_profile()
RETURNS TABLE (id uuid, username text, name text, role text, auth_user_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT a.id, a.username, coalesce(nullif(a.name, ''), a.username), m.role, m.auth_user_id
  FROM pos_security.user_access AS m
  JOIN public.admins AS a ON a.id = m.admin_id
  WHERE m.auth_user_id = (SELECT auth.uid()) AND m.active = true
$$;
REVOKE ALL ON FUNCTION public.pos_current_profile() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pos_current_profile() TO authenticated;

COMMIT;
