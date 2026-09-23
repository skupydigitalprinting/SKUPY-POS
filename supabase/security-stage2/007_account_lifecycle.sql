-- Preview candidate only. Requires 001-005, not 006; never replay prior candidates.
-- Auth writes are outside SQL. A durable one-shot claim permits at most one dispatch;
-- lost claims or ambiguous Auth outcomes remain pending, without automatic takeover.
BEGIN;

ALTER TABLE pos_security.user_access ADD COLUMN account_version integer NOT NULL DEFAULT 1 CHECK (account_version > 0);
CREATE TABLE pos_security.account_operations (
  operation uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('create', 'update', 'self_password')),
  actor uuid NOT NULL,
  actor_session uuid NOT NULL,
  target_admin uuid NOT NULL,
  target_auth uuid,
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  request jsonb NOT NULL,
  state text NOT NULL CHECK (state IN ('reserved', 'auth_started', 'finished')),
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz
);
CREATE UNIQUE INDEX account_reserved_username ON pos_security.account_operations ((request->>'username')) WHERE kind = 'create';
ALTER TABLE pos_security.account_operations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pos_security.account_operations FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION pos_security.account_actor(p_actor uuid, p_session uuid, p_owner boolean)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM pos_security.user_access m JOIN auth.sessions s ON s.user_id = m.auth_user_id
    WHERE m.auth_user_id = p_actor AND s.id = p_session AND s.created_at > m.sessions_valid_after
      AND m.active AND m.reset_operation IS NULL AND m.role IN ('owner','admin','staff')
      AND (NOT p_owner OR m.role = 'owner')
  )
$$;
REVOKE ALL ON FUNCTION pos_security.account_actor(uuid,uuid,boolean) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION pos_security.account_public(p_admin uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT jsonb_build_object('id',a.id,'username',m.login_username,'name',a.name,'role',m.role,
    'active',m.active,'pending',m.reset_operation IS NOT NULL,'version',m.account_version)
  FROM pos_security.user_access m JOIN public.admins a ON a.id=m.admin_id WHERE m.admin_id=p_admin
$$;
REVOKE ALL ON FUNCTION pos_security.account_public(uuid) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.pos_managed_accounts(p_actor uuid, p_session uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM 1 FROM pos_security.user_access WHERE auth_user_id=p_actor FOR UPDATE;
  IF NOT pos_security.account_actor(p_actor,p_session,true) THEN RAISE EXCEPTION 'account denied' USING ERRCODE='42501'; END IF;
  RETURN coalesce((SELECT jsonb_agg(item ORDER BY item->>'username') FROM (
    SELECT pos_security.account_public(m.admin_id) AS item FROM pos_security.user_access m WHERE m.role IN ('staff','admin')
    UNION ALL
    SELECT jsonb_build_object('id',o.target_admin,'username',o.request->>'username','name',o.request->>'name',
      'role',o.request->>'role','active',false,'pending',true,'version',0,
      'operationId',CASE WHEN o.actor=p_actor THEN o.operation ELSE NULL END)
    FROM pos_security.account_operations o WHERE o.kind='create' AND o.state<>'finished'
  ) accounts),'[]'::jsonb);
END $$;

CREATE FUNCTION public.pos_account_reserve(p_actor uuid,p_session uuid,p_operation uuid,p_username text,p_name text,p_role text,p_fingerprint text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE o pos_security.account_operations%ROWTYPE; payload jsonb;
BEGIN
  PERFORM 1 FROM pos_security.user_access WHERE auth_user_id=p_actor FOR UPDATE;
  IF NOT pos_security.account_actor(p_actor,p_session,true) THEN RAISE EXCEPTION 'account denied' USING ERRCODE='42501'; END IF;
  IF p_operation IS NULL OR p_username IS NULL OR p_username !~ '^[a-z0-9][a-z0-9_.-]{0,63}$'
    OR p_name IS NULL OR length(btrim(p_name)) NOT BETWEEN 1 AND 100 OR p_name<>btrim(p_name)
    OR p_role IS NULL OR p_role NOT IN ('staff','admin') OR p_fingerprint IS NULL OR p_fingerprint !~ '^[a-f0-9]{64}$'
  THEN RAISE EXCEPTION 'invalid account request' USING ERRCODE='22023'; END IF;
  payload := jsonb_build_object('username',p_username,'name',p_name,'role',p_role);
  SELECT * INTO o FROM pos_security.account_operations WHERE operation=p_operation FOR UPDATE;
  IF FOUND THEN
    IF o.actor<>p_actor OR o.kind<>'create' OR o.fingerprint<>p_fingerprint OR o.request<>payload
      THEN RAISE EXCEPTION 'operation conflict' USING ERRCODE='42501'; END IF;
    RETURN coalesce(o.result,jsonb_build_object('state',o.state,'operationId',o.operation,'id',o.target_admin));
  END IF;
  IF EXISTS (SELECT 1 FROM pos_security.user_access WHERE login_username=p_username)
    OR EXISTS (SELECT 1 FROM public.admins WHERE lower(btrim(username))=p_username)
    THEN RAISE EXCEPTION 'account unavailable' USING ERRCODE='23505'; END IF;
  INSERT INTO pos_security.account_operations(operation,kind,actor,actor_session,target_admin,fingerprint,request,state)
    VALUES(p_operation,'create',p_actor,p_session,gen_random_uuid(),p_fingerprint,payload,'reserved') RETURNING * INTO o;
  RETURN jsonb_build_object('state',o.state,'operationId',o.operation,'id',o.target_admin);
END $$;

CREATE FUNCTION public.pos_account_claim(p_actor uuid,p_session uuid,p_operation uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE o pos_security.account_operations%ROWTYPE;
BEGIN
  PERFORM 1 FROM pos_security.user_access WHERE auth_user_id=p_actor FOR UPDATE;
  IF NOT pos_security.account_actor(p_actor,p_session,true) THEN RAISE EXCEPTION 'account denied' USING ERRCODE='42501'; END IF;
  SELECT * INTO o FROM pos_security.account_operations WHERE operation=p_operation FOR UPDATE;
  IF NOT FOUND OR o.actor<>p_actor OR o.kind<>'create' THEN RAISE EXCEPTION 'operation denied' USING ERRCODE='42501'; END IF;
  IF o.state<>'reserved' THEN RETURN false; END IF;
  UPDATE pos_security.account_operations SET state='auth_started' WHERE operation=p_operation;
  RETURN true;
END $$;

CREATE FUNCTION public.pos_account_finish_create(p_actor uuid,p_session uuid,p_operation uuid,p_auth_user uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE o pos_security.account_operations%ROWTYPE; outcome jsonb;
BEGIN
  PERFORM 1 FROM pos_security.user_access WHERE auth_user_id=p_actor FOR UPDATE;
  IF NOT pos_security.account_actor(p_actor,p_session,true) THEN RAISE EXCEPTION 'account denied' USING ERRCODE='42501'; END IF;
  SELECT * INTO o FROM pos_security.account_operations WHERE operation=p_operation FOR UPDATE;
  IF NOT FOUND OR o.actor<>p_actor OR o.kind<>'create' OR p_auth_user IS NULL
    THEN RAISE EXCEPTION 'operation denied' USING ERRCODE='42501'; END IF;
  IF o.state='finished' THEN
    IF o.target_auth IS DISTINCT FROM p_auth_user THEN RAISE EXCEPTION 'identity conflict' USING ERRCODE='42501'; END IF;
    RETURN o.result;
  END IF;
  IF o.state<>'auth_started' OR NOT EXISTS (SELECT 1 FROM auth.users WHERE id=p_auth_user AND email=p_operation::text||'@staff.skupy.invalid')
    OR EXISTS (SELECT 1 FROM pos_security.user_access WHERE auth_user_id=p_auth_user OR admin_id=o.target_admin)
    THEN RAISE EXCEPTION 'identity denied' USING ERRCODE='42501'; END IF;
  -- The required legacy column is NOT an Auth credential; 006 must deny legacy login/read paths.
  INSERT INTO public.admins(id,username,password,name,role)
    VALUES(o.target_admin,o.request->>'username','!pos-auth-only:'||gen_random_uuid()::text||':'||gen_random_uuid()::text,o.request->>'name',o.request->>'role');
  INSERT INTO pos_security.user_access(auth_user_id,admin_id,role,active,login_username,sessions_valid_after)
    VALUES(p_auth_user,o.target_admin,o.request->>'role',true,o.request->>'username',clock_timestamp());
  outcome := jsonb_build_object('state','finished','operationId',p_operation,'account',pos_security.account_public(o.target_admin));
  UPDATE pos_security.account_operations SET state='finished',target_auth=p_auth_user,result=outcome,finished_at=clock_timestamp() WHERE operation=p_operation;
  RETURN outcome;
END $$;

CREATE FUNCTION public.pos_account_update(p_actor uuid,p_session uuid,p_operation uuid,p_target uuid,p_expected_version integer,p_patch jsonb,p_fingerprint text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE o pos_security.account_operations%ROWTYPE; target pos_security.user_access%ROWTYPE; payload jsonb; outcome jsonb; new_role text; new_active boolean;
BEGIN
  PERFORM auth_user_id FROM pos_security.user_access WHERE auth_user_id=p_actor OR admin_id=p_target ORDER BY auth_user_id FOR UPDATE;
  IF NOT pos_security.account_actor(p_actor,p_session,true) THEN RAISE EXCEPTION 'account denied' USING ERRCODE='42501'; END IF;
  IF p_operation IS NULL OR p_target IS NULL OR p_expected_version IS NULL OR p_expected_version<1
    OR p_fingerprint IS NULL OR p_fingerprint !~ '^[a-f0-9]{64}$' OR p_patch IS NULL OR jsonb_typeof(p_patch)<>'object'
    OR p_patch='{}'::jsonb OR p_patch-ARRAY['name','role','active']<>'{}'::jsonb
    OR (p_patch ? 'name' AND (jsonb_typeof(p_patch->'name')<>'string' OR length(btrim(p_patch->>'name')) NOT BETWEEN 1 AND 100 OR p_patch->>'name'<>btrim(p_patch->>'name')))
    OR (p_patch ? 'role' AND (jsonb_typeof(p_patch->'role')<>'string' OR p_patch->>'role' NOT IN ('staff','admin')))
    OR (p_patch ? 'active' AND jsonb_typeof(p_patch->'active')<>'boolean')
    THEN RAISE EXCEPTION 'invalid account request' USING ERRCODE='22023'; END IF;
  payload:=jsonb_build_object('version',p_expected_version,'patch',p_patch);
  SELECT * INTO o FROM pos_security.account_operations WHERE operation=p_operation FOR UPDATE;
  IF FOUND THEN
    IF o.actor<>p_actor OR o.kind<>'update' OR o.target_admin<>p_target OR o.fingerprint<>p_fingerprint OR o.request<>payload
      THEN RAISE EXCEPTION 'operation conflict' USING ERRCODE='42501'; END IF;
    RETURN o.result;
  END IF;
  SELECT * INTO target FROM pos_security.user_access WHERE admin_id=p_target;
  IF NOT FOUND OR target.role NOT IN ('staff','admin') OR target.auth_user_id=p_actor OR target.reset_operation IS NOT NULL
    THEN RAISE EXCEPTION 'target denied' USING ERRCODE='42501'; END IF;
  IF target.account_version<>p_expected_version THEN RAISE EXCEPTION 'version conflict' USING ERRCODE='40001'; END IF;
  new_role:=coalesce(p_patch->>'role',target.role);
  new_active:=coalesce((p_patch->>'active')::boolean,target.active);
  UPDATE pos_security.user_access SET role=new_role,active=new_active,account_version=account_version+1,
    sessions_valid_after=CASE WHEN new_role<>target.role OR new_active<>target.active THEN greatest(sessions_valid_after,clock_timestamp()) ELSE sessions_valid_after END
    WHERE admin_id=p_target;
  UPDATE public.admins SET name=CASE WHEN p_patch ? 'name' THEN p_patch->>'name' ELSE name END,
    role=new_role,updated_at=clock_timestamp() WHERE id=p_target;
  outcome:=jsonb_build_object('state','finished','operationId',p_operation,'account',pos_security.account_public(p_target));
  INSERT INTO pos_security.account_operations(operation,kind,actor,actor_session,target_admin,target_auth,fingerprint,request,state,result,finished_at)
    VALUES(p_operation,'update',p_actor,p_session,p_target,target.auth_user_id,p_fingerprint,payload,'finished',outcome,clock_timestamp());
  RETURN outcome;
END $$;

CREATE FUNCTION public.pos_account_status(p_actor uuid,p_session uuid,p_operation uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE o pos_security.account_operations%ROWTYPE;
BEGIN
  PERFORM 1 FROM pos_security.user_access WHERE auth_user_id=p_actor FOR UPDATE;
  IF NOT pos_security.account_actor(p_actor,p_session,true) THEN RAISE EXCEPTION 'account denied' USING ERRCODE='42501'; END IF;
  SELECT * INTO o FROM pos_security.account_operations WHERE operation=p_operation FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('state','unknown'); END IF;
  IF o.actor<>p_actor OR o.kind NOT IN ('create','update') THEN RAISE EXCEPTION 'operation denied' USING ERRCODE='42501'; END IF;
  RETURN coalesce(o.result,jsonb_build_object('state',o.state,'operationId',o.operation,'id',o.target_admin));
END $$;

CREATE FUNCTION public.pos_self_password_begin(p_actor uuid,p_session uuid,p_operation uuid,p_fingerprint text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE target pos_security.user_access%ROWTYPE;
BEGIN
  SELECT * INTO target FROM pos_security.user_access WHERE auth_user_id=p_actor FOR UPDATE;
  IF NOT pos_security.account_actor(p_actor,p_session,false) THEN RAISE EXCEPTION 'password change denied' USING ERRCODE='42501'; END IF;
  IF p_operation IS NULL OR p_fingerprint IS NULL OR p_fingerprint !~ '^[a-f0-9]{64}$'
    THEN RAISE EXCEPTION 'invalid password operation' USING ERRCODE='22023'; END IF;
  -- The unique insert is the one-shot Auth dispatch claim, not a renewable lease.
  INSERT INTO pos_security.account_operations(operation,kind,actor,actor_session,target_admin,target_auth,fingerprint,request,state)
    VALUES(p_operation,'self_password',p_actor,p_session,target.admin_id,p_actor,p_fingerprint,'{}','auth_started');
  UPDATE pos_security.user_access SET reset_operation=p_operation,sessions_valid_after=greatest(sessions_valid_after,clock_timestamp()) WHERE auth_user_id=p_actor;
  RETURN jsonb_build_object('state','auth_started','operationId',p_operation,'dispatch',true);
END $$;

CREATE FUNCTION public.pos_self_password_finish(p_actor uuid,p_session uuid,p_operation uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE o pos_security.account_operations%ROWTYPE; target pos_security.user_access%ROWTYPE; outcome jsonb;
BEGIN
  SELECT * INTO target FROM pos_security.user_access WHERE auth_user_id=p_actor FOR UPDATE;
  SELECT * INTO o FROM pos_security.account_operations WHERE operation=p_operation FOR UPDATE;
  IF NOT FOUND OR o.kind<>'self_password' OR o.actor IS DISTINCT FROM p_actor OR o.actor_session IS DISTINCT FROM p_session OR o.target_auth IS DISTINCT FROM p_actor
    THEN RAISE EXCEPTION 'password operation denied' USING ERRCODE='42501'; END IF;
  IF o.state='finished' THEN RETURN o.result; END IF;
  -- Begin already invalidated the caller. Only this private, exact operation can finish.
  IF o.state<>'auth_started' OR target.active IS DISTINCT FROM true OR target.admin_id IS DISTINCT FROM o.target_admin
    OR target.reset_operation IS DISTINCT FROM p_operation THEN RAISE EXCEPTION 'password operation denied' USING ERRCODE='42501'; END IF;
  UPDATE pos_security.user_access SET reset_operation=NULL,sessions_valid_after=greatest(sessions_valid_after,clock_timestamp()),account_version=account_version+1 WHERE auth_user_id=p_actor;
  outcome:=jsonb_build_object('state','finished','operationId',p_operation,'reauthenticationRequired',true);
  UPDATE pos_security.account_operations SET state='finished',result=outcome,finished_at=clock_timestamp() WHERE operation=p_operation;
  RETURN outcome;
END $$;

CREATE FUNCTION public.pos_self_password_status(p_actor uuid,p_session uuid,p_operation uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE o pos_security.account_operations%ROWTYPE;
BEGIN
  PERFORM 1 FROM pos_security.user_access WHERE auth_user_id=p_actor FOR UPDATE;
  SELECT * INTO o FROM pos_security.account_operations WHERE operation=p_operation FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('state','unknown'); END IF;
  IF o.kind<>'self_password' OR o.actor IS DISTINCT FROM p_actor OR o.actor_session IS DISTINCT FROM p_session
    THEN RAISE EXCEPTION 'password operation denied' USING ERRCODE='42501'; END IF;
  RETURN coalesce(o.result,jsonb_build_object('state',o.state,'operationId',o.operation));
END $$;

REVOKE ALL ON FUNCTION public.pos_managed_accounts(uuid,uuid), public.pos_account_reserve(uuid,uuid,uuid,text,text,text,text),
  public.pos_account_claim(uuid,uuid,uuid), public.pos_account_finish_create(uuid,uuid,uuid,uuid),
  public.pos_account_update(uuid,uuid,uuid,uuid,integer,jsonb,text), public.pos_account_status(uuid,uuid,uuid),
  public.pos_self_password_begin(uuid,uuid,uuid,text), public.pos_self_password_finish(uuid,uuid,uuid),
  public.pos_self_password_status(uuid,uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pos_managed_accounts(uuid,uuid), public.pos_account_reserve(uuid,uuid,uuid,text,text,text,text),
  public.pos_account_claim(uuid,uuid,uuid), public.pos_account_finish_create(uuid,uuid,uuid,uuid),
  public.pos_account_update(uuid,uuid,uuid,uuid,integer,jsonb,text), public.pos_account_status(uuid,uuid,uuid),
  public.pos_self_password_begin(uuid,uuid,uuid,text), public.pos_self_password_finish(uuid,uuid,uuid),
  public.pos_self_password_status(uuid,uuid,uuid) TO service_role;
COMMIT;
