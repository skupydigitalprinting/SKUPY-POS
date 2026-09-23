-- Candidate only, after 001_identity_bridge.sql on an isolated test database.
BEGIN;

-- Provision these explicitly. Never copy usernames from publicly writable data.
ALTER TABLE pos_security.user_access ADD COLUMN login_username text UNIQUE
  CHECK (login_username ~ '^[a-z0-9][a-z0-9_.-]{0,63}$');

CREATE FUNCTION public.pos_resolve_login(p_username text)
RETURNS TABLE (auth_user_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT m.auth_user_id FROM pos_security.user_access AS m
  WHERE m.login_username = p_username AND m.active = true
$$;
REVOKE ALL ON FUNCTION public.pos_resolve_login(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pos_resolve_login(text) TO service_role;

CREATE TABLE pos_security.login_buckets (
  bucket_key text PRIMARY KEY,
  window_start timestamptz NOT NULL,
  attempts integer NOT NULL CHECK (attempts >= 0)
);
CREATE INDEX login_buckets_window_idx ON pos_security.login_buckets(window_start);
ALTER TABLE pos_security.login_buckets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pos_security.login_buckets FROM PUBLIC, anon, authenticated;

-- Fixed 15-minute windows: global 1000 IP-admitted attempts, IP 60, username 10.
-- Global-first locking serializes counters across server instances. No raw PII.
CREATE FUNCTION public.pos_consume_login_attempt(p_keys text[])
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  t timestamptz := clock_timestamp();
  limits integer[] := ARRAY[1000, 60, 10];
  n integer;
  i integer;
BEGIN
  IF p_keys IS NULL OR cardinality(p_keys) <> 3 OR array_ndims(p_keys) <> 1
     OR array_lower(p_keys, 1) <> 1 OR array_position(p_keys, NULL) IS NOT NULL
     OR p_keys[1] <> 'global' OR p_keys[2] !~ '^ip:[a-f0-9]{64}$'
     OR p_keys[3] !~ '^user:[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'invalid login buckets';
  END IF;
  -- Lock/reset the global window without charging an already-blocked IP.
  INSERT INTO pos_security.login_buckets AS b (bucket_key, window_start, attempts)
  VALUES ('global', t, 0)
  ON CONFLICT (bucket_key) DO UPDATE SET
    attempts = CASE WHEN b.window_start <= t - interval '15 minutes' THEN 0 ELSE b.attempts END,
    window_start = CASE WHEN b.window_start <= t - interval '15 minutes' THEN t ELSE b.window_start END
  RETURNING attempts INTO n;
  IF n >= limits[1] THEN RETURN false; END IF;
  FOR i IN 2..3 LOOP
    INSERT INTO pos_security.login_buckets AS b (bucket_key, window_start, attempts)
    VALUES (p_keys[i], t, 1)
    ON CONFLICT (bucket_key) DO UPDATE SET
      attempts = CASE WHEN b.window_start <= t - interval '15 minutes'
        THEN 1 ELSE least(b.attempts + 1, limits[i] + 1) END,
      window_start = CASE WHEN b.window_start <= t - interval '15 minutes'
        THEN t ELSE b.window_start END
    RETURNING attempts INTO n;
    IF n > limits[i] THEN RETURN false; END IF;
    IF i = 2 THEN
      UPDATE pos_security.login_buckets SET attempts = attempts + 1 WHERE bucket_key = 'global';
    END IF;
  END LOOP;
  DELETE FROM pos_security.login_buckets WHERE window_start < t - interval '1 day';
  RETURN true;
END
$$;
REVOKE ALL ON FUNCTION public.pos_consume_login_attempt(text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pos_consume_login_attempt(text[]) TO service_role;

COMMIT;
