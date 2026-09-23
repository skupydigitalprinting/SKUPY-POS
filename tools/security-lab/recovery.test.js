import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'

const candidate = new URL('../../supabase/security-stage2/003_password_recovery.sql', import.meta.url)
const statusCandidate = new URL('../../supabase/security-stage2/004_password_reset_status.sql', import.meta.url)
const directoryCandidate = new URL('../../supabase/security-stage2/005_staff_directory.sql', import.meta.url)
const prerequisites = await Promise.all(['001_identity_bridge.sql', '002_username_login.sql'].map(file =>
  readFile(new URL(`../../supabase/security-stage2/${file}`, import.meta.url), 'utf8')))
// A missing candidate runs the baseline so RED demonstrates the existing vulnerability.
const recovery = await readFile(candidate, 'utf8').catch(error => {
  if (error.code === 'ENOENT') return ''
  throw error
})
const uuid = (prefix, n) => `${prefix}0000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const users = Object.fromEntries(['owner', 'staff', 'admin', 'owner2', 'inactive', 'unmapped'].map((name, i) =>
  [name, { auth: uuid(1, i + 1), admin: uuid(2, i + 1), session: uuid(3, i + 1) }]))
const operation = uuid(4, 1)
const otherOperation = uuid(4, 2)
const beginSql = 'SELECT * FROM public.pos_begin_staff_password_reset($1, $2, $3)'
const finishSql = 'SELECT public.pos_finish_staff_password_reset($1, $2, $3) AS finished'
const statusSql = 'SELECT * FROM public.pos_staff_password_reset_status($1, $2, $3)'
const directorySql = 'SELECT * FROM public.pos_resettable_staff() ORDER BY id'

async function setup(t, { applyStatus = true } = {}) {
  // In-memory only: no URLs, credentials, environment files, or real Auth calls.
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
    CREATE ROLE unrelated NOLOGIN;
    ALTER DEFAULT PRIVILEGES GRANT ALL ON TABLES TO PUBLIC, anon, authenticated;
    ALTER DEFAULT PRIVILEGES GRANT ALL ON SEQUENCES TO PUBLIC, anon, authenticated;
    ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO PUBLIC, anon, authenticated;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE TABLE auth.sessions(id uuid PRIMARY KEY, user_id uuid REFERENCES auth.users(id), created_at timestamptz);
    REVOKE ALL ON auth.sessions FROM PUBLIC, anon, authenticated;
    CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS
      $$ SELECT nullif(current_setting('request.jwt.claims', true), '')::jsonb $$;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
      $$ SELECT (auth.jwt()->>'sub')::uuid $$;
    CREATE TABLE public.admins(id uuid PRIMARY KEY, username text, name text, role text, password text);
  `)
  for (const sql of prerequisites) await db.exec(sql)
  // Existing mappings must acquire a usable default when the candidate is applied.
  for (const [name, user] of Object.entries(users)) {
    await db.query('INSERT INTO auth.users VALUES ($1)', [user.auth])
    await db.query("INSERT INTO public.admins VALUES ($1, $2, '', $3, 'dummy-never-audit')",
      [user.admin, name, name === 'owner' ? 'staff' : 'owner'])
    await db.query("INSERT INTO auth.sessions VALUES ($1, $2, clock_timestamp() - interval '1 day')", [user.session, user.auth])
    if (name !== 'unmapped') await db.query(`
      INSERT INTO pos_security.user_access(auth_user_id, admin_id, role, active, login_username)
      VALUES ($1, $2, $3, $4, $5)`,
    [user.auth, user.admin, name.startsWith('owner') ? 'owner' : name === 'admin' ? 'admin' : 'staff', name !== 'inactive', name])
  }
  if (recovery) await db.exec(recovery)
  if (applyStatus) {
    await db.exec(await readFile(statusCandidate, 'utf8'))
    await db.exec(await readFile(directoryCandidate, 'utf8'))
  }
  return db
}

async function asRole(db, role, sql, params = [], claims = {}) {
  // PGlite transactions queue the entire callback, not interleaved SET ROLE calls.
  return db.transaction(async tx => {
    await tx.exec(`SET LOCAL ROLE ${role}`)
    await tx.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)])
    return tx.query(sql, params)
  })
}
const begin = (db, actor = users.owner.auth, target = users.staff.admin, op = operation) =>
  asRole(db, 'service_role', beginSql, [actor, target, op])
const finish = (db, actor = users.owner.auth, target = users.staff.admin, op = operation) =>
  asRole(db, 'service_role', finishSql, [actor, target, op])
const resetStatus = (db, actor = users.owner.auth, target = users.staff.admin, op = operation) =>
  asRole(db, 'service_role', statusSql, [actor, target, op])
const directory = (db, user = users.owner, extra = {}) => asRole(db, 'authenticated',
  directorySql, [], { sub: user.auth, session_id: user.session, ...extra })
const profile = (db, user = users.staff, extra = {}) => asRole(db, 'authenticated',
  'SELECT * FROM public.pos_current_profile()', [], { sub: user.auth, session_id: user.session, ...extra })
const state = async db => (await db.query(`SELECT reset_operation, sessions_valid_after::text AS cutoff
  FROM pos_security.user_access WHERE auth_user_id = $1`, [users.staff.auth])).rows[0]
const audit = async db => (await db.query('SELECT * FROM pos_security.password_reset_audit ORDER BY occurred_at, event')).rows

test('profile denies absent, malformed, unknown, foreign, deleted and undated sessions', async t => {
  const db = await setup(t)
  for (const session_id of [undefined, null, '', 'not-a-uuid', `${users.staff.session}x`, uuid(3, 99),
    users.owner.session, 123, {}, [], '00000000-0000-0000-0000-00000000000g']) {
    assert.deepEqual((await profile(db, users.staff, { session_id })).rows, [], `session ${JSON.stringify(session_id)}`)
  }
  await db.query('UPDATE auth.sessions SET created_at = NULL WHERE id = $1', [users.staff.session])
  assert.deepEqual((await profile(db)).rows, [])
  await db.query('DELETE FROM auth.sessions WHERE id = $1', [users.staff.session])
  assert.deepEqual((await profile(db)).rows, [])
})

test('profile preserves its columns and trusts only active private roles', async t => {
  const db = await setup(t)
  assert.deepEqual((await profile(db)).rows, [{ id: users.staff.admin, username: 'staff', name: 'staff', role: 'staff', auth_user_id: users.staff.auth }])
  assert.equal((await profile(db, users.owner)).rows[0].role, 'owner')
  for (const user of [users.inactive, users.unmapped]) assert.deepEqual((await profile(db, user)).rows, [])
  assert.deepEqual((await profile(db, users.staff, { sub: undefined })).rows, [])
  await assert.rejects(asRole(db, 'anon', 'SELECT * FROM public.pos_current_profile()'), /permission denied/)
})

test('service-only reset RPCs defeat inherited PUBLIC and direct grants even for an owner JWT', async t => {
  const db = await setup(t)
  for (const role of ['anon', 'authenticated', 'unrelated']) {
    for (const user of [users.owner, users.staff]) {
      for (const sql of [beginSql, finishSql]) await assert.rejects(asRole(db, role, sql,
        [users.owner.auth, users.staff.admin, operation], { sub: user.auth, session_id: user.session }), /permission denied/)
    }
  }
  assert.deepEqual((await begin(db)).rows, [{ auth_user_id: users.staff.auth }])
})

test('begin accepts trusted owner and staff/admin targets, advances cutoff and audits no secrets', async t => {
  const db = await setup(t)
  assert.deepEqual(await state(db), { reset_operation: null, cutoff: '-infinity' })
  const { rows: [before] } = await db.query('SELECT clock_timestamp()::text AS time')
  assert.deepEqual((await begin(db)).rows, [{ auth_user_id: users.staff.auth }])
  const pending = await state(db)
  assert.equal(pending.reset_operation, operation)
  assert.ok(Date.parse(pending.cutoff) >= Date.parse(before.time))
  assert.deepEqual((await begin(db, users.owner.auth, users.admin.admin, otherOperation)).rows, [{ auth_user_id: users.admin.auth }])
  const events = await audit(db)
  assert.equal(events.length, 2)
  assert.deepEqual(Object.keys(events[0]).sort(), ['actor_auth_user_id', 'event', 'occurred_at', 'operation', 'target_admin_id', 'target_auth_user_id'].sort())
  assert.equal(events[0].actor_auth_user_id, users.owner.auth)
  assert.equal(events[0].target_admin_id, users.staff.admin)
  assert.equal(events[0].target_auth_user_id, users.staff.auth)
  assert.equal(events[0].event, 'begun')
  assert.equal(events[0].operation, operation)
  assert.ok(!JSON.stringify(events).includes('dummy-never-audit'))
})

test('begin rejects untrusted actors, owners, self, inactive/unmapped targets and null identifiers atomically', async t => {
  const db = await setup(t)
  for (const actor of [users.staff.auth, users.admin.auth, users.inactive.auth, users.unmapped.auth, null]) {
    await assert.rejects(begin(db, actor), /password reset denied/)
  }
  for (const target of [users.owner.admin, users.owner2.admin, users.inactive.admin, users.unmapped.admin, users.staff.auth, null]) {
    await assert.rejects(begin(db, users.owner.auth, target), /password reset denied/)
  }
  await assert.rejects(begin(db, users.owner.auth, users.staff.admin, null), /password reset denied/)
  assert.deepEqual(await state(db), { reset_operation: null, cutoff: '-infinity' })
  assert.deepEqual(await audit(db), [])
})

test('inactive or reset-pending trusted owner cannot begin or finish', async t => {
  const db = await setup(t)
  await begin(db)
  for (const update of ['active = false', `active = true, reset_operation = '${otherOperation}'`]) {
    await db.exec(`UPDATE pos_security.user_access SET ${update} WHERE auth_user_id = '${users.owner.auth}'`)
    await assert.rejects(begin(db, users.owner.auth, users.admin.admin, otherOperation), /password reset denied/)
    await assert.rejects(finish(db), /password reset denied/)
    assert.deepEqual((await profile(db, users.owner)).rows, [])
  }
  assert.equal((await state(db)).reset_operation, operation)
  assert.equal((await audit(db)).length, 1)
})

test('double begin cannot replace the pending operation or its cutoff', async t => {
  const db = await setup(t)
  await begin(db)
  const pending = await state(db)
  for (const op of [operation, otherOperation]) await assert.rejects(begin(db, users.owner2.auth, users.staff.admin, op), /password reset denied/)
  assert.deepEqual(await state(db), pending)
  assert.equal((await audit(db)).length, 1)
})

test('queued competing begins have exactly one winner (not a multi-connection lock proof)', async t => {
  const db = await setup(t)
  const results = await Promise.allSettled([begin(db), begin(db, users.owner2.auth, users.staff.admin, otherOperation)])
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  assert.match(results.find(r => r.status === 'rejected').reason.message, /password reset denied/)
  assert.equal((await audit(db)).length, 1)
})

test('Auth failure stays fail-closed even for new sessions until explicit matching finish', async t => {
  const db = await setup(t)
  await begin(db)
  const pending = await state(db)
  await db.query('UPDATE auth.sessions SET created_at = clock_timestamp() WHERE id = $1', [users.staff.session])
  for (let i = 0; i < 3; i++) {
    assert.deepEqual((await profile(db, users.staff, { iat: 9999999999, exp: 99999999999 })).rows, [])
  }
  assert.deepEqual(await state(db), pending)
  assert.equal((await audit(db)).length, 1)
})

test('finish requires active trusted owner, target and matching nonnull operation; failures preserve denial', async t => {
  const db = await setup(t)
  await assert.rejects(finish(db), /password reset denied/)
  await begin(db)
  const pending = await state(db)
  for (const actor of [users.staff.auth, users.admin.auth, users.inactive.auth, users.unmapped.auth, null]) {
    await assert.rejects(finish(db, actor), /password reset denied/)
  }
  for (const target of [users.owner.admin, users.owner2.admin, users.admin.admin, users.unmapped.admin, null]) {
    await assert.rejects(finish(db, users.owner.auth, target), /password reset denied/)
  }
  for (const op of [otherOperation, null]) await assert.rejects(finish(db, users.owner.auth, users.staff.admin, op), /password reset denied/)
  assert.deepEqual(await state(db), pending)
  assert.deepEqual((await profile(db)).rows, [])
  assert.equal((await audit(db)).length, 1)
})

test('finish rechecks target role and active mapping after begin', async t => {
  const db = await setup(t)
  await begin(db)
  for (const update of ['active = false', "active = true, role = 'owner'"]) {
    await db.exec(`UPDATE pos_security.user_access SET ${update} WHERE auth_user_id = '${users.staff.auth}'`)
    await assert.rejects(finish(db), /password reset denied/)
    assert.equal((await state(db)).reset_operation, operation)
  }
})

test('finish cuts off old and during-reset sessions despite refreshed JWT; strictly newer session works', async t => {
  const db = await setup(t)
  await begin(db)
  const duringSession = uuid(3, 20)
  await db.query('INSERT INTO auth.sessions VALUES ($1, $2, clock_timestamp())', [duringSession, users.staff.auth])
  assert.deepEqual((await finish(db)).rows, [{ finished: true }])
  assert.equal((await state(db)).reset_operation, null)
  for (const session_id of [users.staff.session, duringSession]) {
    assert.deepEqual((await profile(db, users.staff, { session_id, iat: 9999999999, exp: 99999999999 })).rows, [])
  }
  await db.query(`UPDATE auth.sessions SET created_at = (SELECT sessions_valid_after FROM pos_security.user_access WHERE auth_user_id = $1)
    WHERE id = $2`, [users.staff.auth, duringSession])
  assert.deepEqual((await profile(db, users.staff, { session_id: duringSession })).rows, [], 'equality must deny')
  const freshSession = uuid(3, 21)
  await db.query('INSERT INTO auth.sessions VALUES ($1, $2, clock_timestamp())', [freshSession, users.staff.auth])
  assert.equal((await profile(db, users.staff, { session_id: freshSession })).rows[0].id, users.staff.admin)
  assert.deepEqual((await audit(db)).map(row => row.event), ['begun', 'finished'])
  const complete = await state(db)
  await assert.rejects(finish(db), /password reset denied/)
  assert.deepEqual(await state(db), complete)
})

test('cutoffs use wall clock after transaction start, including the finish cutoff', async t => {
  const db = await setup(t)
  await db.transaction(async tx => {
    await tx.exec('SET LOCAL ROLE service_role')
    await tx.query('SELECT pg_sleep(0.01)')
    await tx.query(beginSql, [users.owner.auth, users.staff.admin, operation])
    await tx.exec('RESET ROLE')
    assert.equal((await tx.query(`SELECT sessions_valid_after > transaction_timestamp() AS fresh
      FROM pos_security.user_access WHERE auth_user_id = $1`, [users.staff.auth])).rows[0].fresh, true)
    await tx.query('SELECT pg_sleep(0.01)')
    await tx.exec('SET LOCAL ROLE service_role')
    await tx.query(finishSql, [users.owner.auth, users.staff.admin, operation])
    await tx.exec('RESET ROLE')
    assert.equal((await tx.query(`SELECT sessions_valid_after > transaction_timestamp() AS fresh
      FROM pos_security.user_access WHERE auth_user_id = $1`, [users.staff.auth])).rows[0].fresh, true)
  })
})

test('private audit is RLS-enabled and denies all direct client access despite default grants', async t => {
  const db = await setup(t)
  await begin(db)
  assert.equal((await db.query("SELECT relrowsecurity FROM pg_class WHERE oid = 'pos_security.password_reset_audit'::regclass")).rows[0].relrowsecurity, true)
  // Give schema visibility in this fixture so table ACLs, not just schema ACLs, are exercised.
  await db.exec('GRANT USAGE ON SCHEMA pos_security TO anon, authenticated, unrelated, service_role')
  for (const role of ['anon', 'authenticated', 'unrelated', 'service_role']) {
    for (const query of [
      'SELECT * FROM pos_security.password_reset_audit',
      "UPDATE pos_security.password_reset_audit SET event = 'finished'",
      'DELETE FROM pos_security.password_reset_audit',
      'TRUNCATE pos_security.password_reset_audit',
      'INSERT INTO pos_security.password_reset_audit DEFAULT VALUES',
      'SELECT * FROM pos_security.user_access',
      'UPDATE pos_security.user_access SET reset_operation = NULL',
    ]) await assert.rejects(asRole(db, role, query), /permission denied/)
  }
  assert.equal((await audit(db)).length, 1)
})

test('audit write failure rolls back begin and finish state changes', async t => {
  const db = await setup(t)
  await db.exec(`CREATE FUNCTION pos_security.reject_audit() RETURNS trigger LANGUAGE plpgsql AS
    $$ BEGIN RAISE EXCEPTION 'synthetic audit failure'; END $$;
    CREATE TRIGGER reject_audit BEFORE INSERT ON pos_security.password_reset_audit
      FOR EACH ROW EXECUTE FUNCTION pos_security.reject_audit();`)
  await assert.rejects(begin(db), /synthetic audit failure/)
  assert.deepEqual(await state(db), { reset_operation: null, cutoff: '-infinity' })
  await db.exec('ALTER TABLE pos_security.password_reset_audit DISABLE TRIGGER reject_audit')
  await begin(db)
  const pending = await state(db)
  await db.exec('ALTER TABLE pos_security.password_reset_audit ENABLE TRIGGER reject_audit')
  await assert.rejects(finish(db), /synthetic audit failure/)
  assert.deepEqual(await state(db), pending)
  assert.deepEqual((await profile(db)).rows, [])
})

test('status reconciles not_started, committed begin and committed finish without changing state', async t => {
  const db = await setup(t)
  assert.deepEqual((await resetStatus(db)).rows, [{ state: 'not_started', auth_user_id: null }])
  // Discard the RPC result to model a response lost after the transaction committed.
  await begin(db)
  const pending = await state(db)
  const begunAudit = await audit(db)
  for (let i = 0; i < 2; i++) {
    assert.deepEqual((await resetStatus(db)).rows, [{ state: 'pending', auth_user_id: users.staff.auth }])
  }
  assert.deepEqual(await state(db), pending)
  assert.deepEqual(await audit(db), begunAudit)
  assert.deepEqual((await profile(db)).rows, [])
  await finish(db)
  const complete = await state(db)
  const completeAudit = await audit(db)
  assert.deepEqual((await resetStatus(db)).rows, [{ state: 'finished', auth_user_id: users.staff.auth }])
  assert.deepEqual(await state(db), complete)
  assert.deepEqual(await audit(db), completeAudit)
})

test('status reports historical completion even when a subsequent reset is pending or mapping is gone', async t => {
  const db = await setup(t)
  await begin(db)
  await finish(db)
  await begin(db, users.owner2.auth, users.staff.admin, otherOperation)
  assert.deepEqual((await resetStatus(db)).rows, [{ state: 'finished', auth_user_id: users.staff.auth }])
  assert.deepEqual((await resetStatus(db, users.owner2.auth, users.staff.admin, otherOperation)).rows,
    [{ state: 'pending', auth_user_id: users.staff.auth }])
  assert.deepEqual((await profile(db)).rows, [])
  await db.query('DELETE FROM pos_security.user_access WHERE auth_user_id = $1', [users.staff.auth])
  assert.deepEqual((await resetStatus(db)).rows, [{ state: 'finished', auth_user_id: users.staff.auth }])
  assert.deepEqual((await resetStatus(db, users.owner2.auth, users.staff.admin, otherOperation)).rows,
    [{ state: 'unknown', auth_user_id: null }])
})

test('status is service-only despite permissive grants and an authenticated owner JWT', async t => {
  const db = await setup(t)
  await begin(db)
  for (const role of ['anon', 'authenticated', 'unrelated']) {
    await assert.rejects(asRole(db, role, statusSql, [users.owner.auth, users.staff.admin, operation],
      { sub: users.owner.auth, session_id: users.owner.session }), { code: '42501' })
  }
  assert.deepEqual((await resetStatus(db)).rows, [{ state: 'pending', auth_user_id: users.staff.auth }])
})

test('status denies invalid, inactive, demoted and reset-pending actors with 42501', async t => {
  const db = await setup(t)
  await begin(db)
  for (const actor of [null, users.staff.auth, users.admin.auth, users.inactive.auth, users.unmapped.auth, uuid(1, 99)]) {
    await assert.rejects(resetStatus(db, actor), { code: '42501' })
  }
  for (const update of ['active = false', "active = true, role = 'staff'",
    `role = 'owner', reset_operation = '${otherOperation}'`]) {
    await db.exec(`UPDATE pos_security.user_access SET ${update} WHERE auth_user_id = '${users.owner.auth}'`)
    await assert.rejects(resetStatus(db), { code: '42501' })
  }
})

test('status does not reveal another owners operation or a mismatched target', async t => {
  const db = await setup(t)
  await begin(db)
  for (const completed of [false, true]) {
    if (completed) await finish(db)
    assert.deepEqual((await resetStatus(db, users.owner2.auth)).rows, [{ state: 'unknown', auth_user_id: null }])
    for (const target of [users.admin.admin, users.unmapped.admin, uuid(2, 99), users.staff.auth]) {
      assert.deepEqual((await resetStatus(db, users.owner.auth, target)).rows, [{ state: 'unknown', auth_user_id: null }])
    }
  }
})

test('status for unused or null operation identifiers never returns an account identity', async t => {
  const db = await setup(t)
  await begin(db)
  for (const target of [users.staff.admin, users.admin.admin, users.unmapped.admin, uuid(2, 99)]) {
    assert.deepEqual((await resetStatus(db, users.owner.auth, target, otherOperation)).rows,
      [{ state: 'not_started', auth_user_id: null }])
    assert.deepEqual((await resetStatus(db, users.owner.auth, target, null)).rows,
      [{ state: 'unknown', auth_user_id: null }])
  }
  assert.deepEqual((await resetStatus(db, users.owner.auth, null)).rows, [{ state: 'unknown', auth_user_id: null }])
})

test('status requires begun audit and matching mapping Auth identity for pending', async t => {
  const db = await setup(t)
  await db.query('UPDATE pos_security.user_access SET reset_operation = $1 WHERE auth_user_id = $2', [operation, users.staff.auth])
  assert.deepEqual((await resetStatus(db)).rows, [{ state: 'unknown', auth_user_id: null }])
  await db.query('UPDATE pos_security.user_access SET reset_operation = NULL WHERE auth_user_id = $1', [users.staff.auth])
  await begin(db)
  await db.query('UPDATE pos_security.user_access SET reset_operation = $1 WHERE auth_user_id = $2', [otherOperation, users.staff.auth])
  assert.deepEqual((await resetStatus(db)).rows, [{ state: 'unknown', auth_user_id: null }])
  await db.query('UPDATE pos_security.user_access SET reset_operation = $1, auth_user_id = $2 WHERE admin_id = $3',
    [operation, users.unmapped.auth, users.staff.admin])
  assert.deepEqual((await resetStatus(db)).rows, [{ state: 'unknown', auth_user_id: null }])
})

test('status requires finished audit to match the initiating actor, target and Auth identity', async t => {
  const db = await setup(t)
  await begin(db)
  await finish(db, users.owner2.auth)
  assert.deepEqual((await resetStatus(db)).rows, [{ state: 'unknown', auth_user_id: null }])
  assert.deepEqual((await resetStatus(db, users.owner2.auth)).rows, [{ state: 'unknown', auth_user_id: null }])
  await db.query("UPDATE pos_security.password_reset_audit SET actor_auth_user_id = $1 WHERE event = 'finished'", [users.owner.auth])
  assert.deepEqual((await resetStatus(db)).rows, [{ state: 'finished', auth_user_id: users.staff.auth }])
  for (const update of [`target_admin_id = '${users.admin.admin}'`,
    `target_admin_id = '${users.staff.admin}', target_auth_user_id = '${users.admin.auth}'`]) {
    await db.exec(`UPDATE pos_security.password_reset_audit SET ${update} WHERE event = 'finished'`)
    assert.deepEqual((await resetStatus(db)).rows, [{ state: 'unknown', auth_user_id: null }])
  }
  await db.exec("DELETE FROM pos_security.password_reset_audit WHERE event = 'begun'")
  assert.deepEqual((await resetStatus(db)).rows, [{ state: 'unknown', auth_user_id: null }])
})

test('004 upgrades existing 003 pending operations without replaying recovery schema', async t => {
  const db = await setup(t, { applyStatus: false })
  assert.equal((await db.query("SELECT to_regprocedure('public.pos_staff_password_reset_status(uuid,uuid,uuid)') AS rpc")).rows[0].rpc, null)
  await begin(db)
  const pending = await state(db)
  const events = await audit(db)
  await db.exec(await readFile(statusCandidate, 'utf8'))
  assert.deepEqual(await state(db), pending)
  assert.deepEqual(await audit(db), events)
  assert.deepEqual((await resetStatus(db)).rows, [{ state: 'pending', auth_user_id: users.staff.auth }])
  assert.deepEqual((await profile(db)).rows, [])
  await finish(db)
  assert.deepEqual((await resetStatus(db)).rows, [{ state: 'finished', auth_user_id: users.staff.auth }])
})

test('directory uses private roles and provisioned usernames with display-only legacy fallback', async t => {
  const db = await setup(t)
  await db.query('UPDATE pos_security.user_access SET login_username = $1 WHERE auth_user_id = $2', ['kasir-trusted', users.staff.auth])
  await db.query("UPDATE public.admins SET username = 'legacy-edited', name = 'Kasir Uji' WHERE id = $1", [users.staff.admin])
  await db.query('UPDATE pos_security.user_access SET login_username = NULL WHERE auth_user_id = $1', [users.admin.auth])
  await db.query('UPDATE public.admins SET name = NULL WHERE id = $1', [users.admin.admin])
  assert.deepEqual((await directory(db)).rows, [
    { id: users.staff.admin, username: 'kasir-trusted', name: 'Kasir Uji', role: 'staff', reset_pending: false },
    { id: users.admin.admin, username: 'admin', name: 'admin', role: 'admin', reset_pending: false },
  ])
  // The fixture's trusted owner is legacy staff; both eligible targets are legacy owners.
  assert.equal((await directory(db, users.owner2)).rows.length, 2)
})

test('directory includes pending staff without exposing credentials, Auth IDs or operation IDs', async t => {
  const db = await setup(t)
  await begin(db)
  const pending = await state(db)
  const events = await audit(db)
  const { rows } = await directory(db)
  assert.deepEqual(rows, [
    { id: users.staff.admin, username: 'staff', name: 'staff', role: 'staff', reset_pending: true },
    { id: users.admin.admin, username: 'admin', name: 'admin', role: 'admin', reset_pending: false },
  ])
  for (const secret of [operation, 'dummy-never-audit', ...Object.values(users).map(user => user.auth)]) {
    assert.ok(!JSON.stringify(rows).includes(secret))
  }
  assert.deepEqual(await state(db), pending)
  assert.deepEqual(await audit(db), events)
  await finish(db)
  assert.equal((await directory(db)).rows[0].reset_pending, false)
})

test('directory denies non-owner identities even when their legacy role says owner', async t => {
  const db = await setup(t)
  for (const user of [users.staff, users.admin, users.inactive, users.unmapped]) {
    await assert.rejects(directory(db, user), { code: '42501' })
  }
  await assert.rejects(directory(db, users.owner, { sub: undefined }), { code: '42501' })
})

test('directory rejects inactive, reset-pending and demoted owners', async t => {
  const db = await setup(t)
  for (const update of ['active = false', `active = true, reset_operation = '${operation}'`,
    "reset_operation = NULL, role = 'staff'"]) {
    await db.exec(`UPDATE pos_security.user_access SET ${update} WHERE auth_user_id = '${users.owner.auth}'`)
    await assert.rejects(directory(db), { code: '42501' })
  }
})

test('directory requires a matching current session beyond the owner cutoff despite refreshed JWT', async t => {
  const db = await setup(t)
  for (const session_id of [undefined, null, '', 'malformed', uuid(3, 99), users.staff.session]) {
    await assert.rejects(directory(db, users.owner, { session_id }), { code: '42501' })
  }
  await db.query('UPDATE pos_security.user_access SET sessions_valid_after = clock_timestamp() WHERE auth_user_id = $1', [users.owner.auth])
  await assert.rejects(directory(db, users.owner, { iat: 9999999999, exp: 99999999999 }), { code: '42501' })
  await db.query(`UPDATE auth.sessions SET created_at = (SELECT sessions_valid_after FROM pos_security.user_access WHERE auth_user_id = $1)
    WHERE id = $2`, [users.owner.auth, users.owner.session])
  await assert.rejects(directory(db), { code: '42501' })
  const freshSession = uuid(3, 30)
  await db.query('INSERT INTO auth.sessions VALUES ($1, $2, clock_timestamp())', [freshSession, users.owner.auth])
  assert.equal((await directory(db, users.owner, { session_id: freshSession })).rows.length, 2)
  await db.query('DELETE FROM auth.sessions WHERE id = $1', [freshSession])
  await assert.rejects(directory(db, users.owner, { session_id: freshSession }), { code: '42501' })
})

test('directory grants only authenticated execution and never private table access', async t => {
  const db = await setup(t)
  const claims = { sub: users.owner.auth, session_id: users.owner.session }
  for (const role of ['anon', 'unrelated', 'service_role']) {
    await assert.rejects(asRole(db, role, directorySql, [], claims), { code: '42501' })
  }
  assert.equal((await directory(db)).rows.length, 2)
  await db.exec('GRANT USAGE ON SCHEMA pos_security TO authenticated')
  for (const query of ['SELECT * FROM pos_security.user_access', 'SELECT * FROM pos_security.password_reset_audit',
    "UPDATE pos_security.user_access SET role = 'owner'"]) {
    await assert.rejects(asRole(db, 'authenticated', query, [], claims), { code: '42501' })
  }
})

test('directory excludes inactive, unlinked and private owner targets and permits an empty result', async t => {
  const db = await setup(t)
  await db.query('UPDATE pos_security.user_access SET active = false WHERE auth_user_id = $1', [users.staff.auth])
  assert.deepEqual((await directory(db)).rows, [
    { id: users.admin.admin, username: 'admin', name: 'admin', role: 'admin', reset_pending: false },
  ])
  await db.query("UPDATE pos_security.user_access SET role = 'owner' WHERE auth_user_id = $1", [users.admin.auth])
  assert.deepEqual((await directory(db)).rows, [])
})
