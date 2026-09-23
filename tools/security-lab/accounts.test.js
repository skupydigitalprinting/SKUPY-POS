import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createAccountLifecycleHandler, createSelfPasswordHandler } from '../../server/accountLifecycle.js'
import { createUsernameLoginHandler } from '../../server/usernameLogin.js'
import { createPasswordRecoveryHandler } from '../../server/passwordRecovery.js'
const { PGlite } = await import(process.env.POS_PGLITE_MODULE || '@electric-sql/pglite')

const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const owner = { auth: id(1), session: id(11), admin: id(21) }
const staff = { auth: id(2), session: id(12), admin: id(22) }
const otherOwner = { auth: id(3), session: id(13), admin: id(23) }
const fp = 'a'.repeat(64)
const files = ['001_identity_bridge.sql', '002_username_login.sql', '003_password_recovery.sql',
  '004_password_reset_status.sql', '005_staff_directory.sql', '007_account_lifecycle.sql']
const sql = await Promise.all(files.map(file => readFile(new URL(`../../supabase/security-stage2/${file}`, import.meta.url), 'utf8')))

async function setup(t) {
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(`
    CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
    ALTER DEFAULT PRIVILEGES GRANT ALL ON TABLES TO PUBLIC, anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO PUBLIC, anon, authenticated;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid PRIMARY KEY, email text UNIQUE);
    CREATE TABLE auth.sessions(id uuid PRIMARY KEY, user_id uuid REFERENCES auth.users(id), created_at timestamptz);
    CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS
      $$ SELECT nullif(current_setting('request.jwt.claims', true), '')::jsonb $$;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT (auth.jwt()->>'sub')::uuid $$;
    -- Schema-only admins definition from the 2026-09-11 catalog; no production records.
    CREATE TABLE public.admins (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), username text NOT NULL UNIQUE, password text NOT NULL,
      name text DEFAULT '', role text DEFAULT 'staff', created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
    );
    CREATE TABLE public.synthetic_history(id uuid PRIMARY KEY, admin_id uuid REFERENCES public.admins(id));
  `)
  for (const candidate of sql) if (candidate) await db.exec(candidate)
  for (const [user, role, username] of [[owner, 'owner', 'owner'], [staff, 'staff', 'cashier'], [otherOwner, 'owner', 'owner2']]) {
    await db.query('INSERT INTO auth.users VALUES ($1,$2)', [user.auth, `${username}@example.test`])
    await db.query("INSERT INTO auth.sessions VALUES ($1,$2,clock_timestamp()-interval '1 day')", [user.session, user.auth])
    await db.query("INSERT INTO public.admins(id,username,password,name,role) VALUES ($1,$2,'legacy-fixture',$2,'owner')", [user.admin, username])
    await db.query('INSERT INTO pos_security.user_access(auth_user_id,admin_id,role,active,login_username) VALUES ($1,$2,$3,true,$4)',
      [user.auth, user.admin, role, username])
  }
  await db.query('INSERT INTO public.synthetic_history VALUES ($1,$2)', [id(50), staff.admin])
  return db
}

async function call(db, name, args, { role = 'service_role', user = owner } = {}) {
  return db.transaction(async tx => {
    await tx.exec(`SET LOCAL ROLE ${role}`)
    await tx.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: user.auth, session_id: user.session })])
    return (await tx.query(`SELECT public.${name}(${args.map((_, i) => `$${i + 1}`).join(',')}) AS value`, args)).rows[0].value
  })
}
const reserve = (db, op = id(100), user = owner, username = 'new-cashier', role = 'staff') =>
  call(db, 'pos_account_reserve', [user.auth, user.session, op, username, 'New Cashier', role, fp])
const claim = (db, op = id(100), user = owner) => call(db, 'pos_account_claim', [user.auth, user.session, op])
const finish = (db, auth = id(200), op = id(100), user = owner) => call(db, 'pos_account_finish_create', [user.auth, user.session, op, auth])
const update = (db, patch, { user = owner, target = staff.admin, version = 1, op = id(101), fingerprint = fp } = {}) =>
  call(db, 'pos_account_update', [user.auth, user.session, op, target, version, JSON.stringify(patch), fingerprint])
const selfBegin = (db, user = staff, op = id(102)) => call(db, 'pos_self_password_begin', [user.auth, user.session, op, fp])
const selfFinish = (db, user = staff, op = id(102)) => call(db, 'pos_self_password_finish', [user.auth, user.session, op])
const status = (db, op = id(100), user = owner) => call(db, 'pos_account_status', [user.auth, user.session, op])
const profile = (db, user = staff) => db.transaction(async tx => {
  await tx.exec('SET LOCAL ROLE authenticated')
  await tx.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: user.auth, session_id: user.session, iat: 9999999999 })])
  return (await tx.query('SELECT * FROM public.pos_current_profile()')).rows
})

test('create reserves one username and legacy ID, claims once, binds only its own synthetic Auth account', async t => {
  const db = await setup(t)
  const first = await reserve(db)
  assert.equal(first.state, 'reserved')
  assert.equal((await reserve(db)).id, first.id)
  assert.equal((await db.query('SELECT count(*)::int AS n FROM public.admins')).rows[0].n, 3)
  assert.equal(await claim(db), true)
  assert.equal(await claim(db), false)
  assert.equal((await status(db)).state, 'auth_started')
  await db.query('INSERT INTO auth.users VALUES ($1,$2)', [id(200), `${id(100)}@staff.skupy.invalid`])
  const result = await finish(db)
  assert.equal(result.state, 'finished')
  assert.equal(result.account.id, first.id)
  assert.equal(result.account.role, 'staff')
  assert.equal(result.account.version, 1)
  assert.deepEqual(await finish(db), result)
  const row = (await db.query('SELECT * FROM public.admins WHERE id=$1', [first.id])).rows[0]
  assert.match(row.password, /^!pos-auth-only:/)
  assert.ok(row.password.length > 72)
  assert.equal(JSON.stringify(result).includes(row.password), false)
  assert.equal(JSON.stringify(result).includes(id(200)), false)
})

test('creation never adopts an existing email/user, reuses an operation payload, or creates owners', async t => {
  const db = await setup(t)
  for (const role of ['owner', 'superuser', null]) await assert.rejects(reserve(db, id(103), owner, 'new-person', role))
  await reserve(db)
  await claim(db)
  await assert.rejects(finish(db, staff.auth))
  await assert.rejects(reserve(db, id(104)))
  await assert.rejects(reserve(db, id(100), owner, 'different-person'))
  await assert.rejects(reserve(db, id(100), otherOwner))
  assert.equal((await status(db)).state, 'auth_started')
  assert.equal((await db.query('SELECT count(*)::int AS n FROM pos_security.user_access')).rows[0].n, 3)
})

test('SQL owner checks require the actual live actor session and private role at transaction time', async t => {
  const db = await setup(t)
  for (const user of [staff, { ...owner, session: staff.session }, { ...owner, session: id(999) }]) {
    await assert.rejects(reserve(db, id(105), user), { code: '42501' })
    await assert.rejects(update(db, { name: 'Forged' }, { user }), { code: '42501' })
  }
  await db.query('UPDATE pos_security.user_access SET sessions_valid_after=clock_timestamp() WHERE auth_user_id=$1', [owner.auth])
  await assert.rejects(reserve(db), { code: '42501' })
  await assert.rejects(call(db, 'pos_managed_accounts', [owner.auth, owner.session]), { code: '42501' })
})

test('account edits preserve immutable IDs/history and reject owner targets, fields, and stale versions', async t => {
  const db = await setup(t)
  const result = await update(db, { name: 'Renamed', role: 'admin' })
  assert.equal(result.account.id, staff.admin)
  assert.equal(result.account.username, 'cashier')
  assert.equal(result.account.version, 2)
  assert.equal(result.account.role, 'admin')
  assert.deepEqual(await update(db, { name: 'Renamed', role: 'admin' }), result)
  assert.equal((await profile(db)).length, 0)
  assert.equal((await db.query('SELECT admin_id FROM public.synthetic_history')).rows[0].admin_id, staff.admin)
  await assert.rejects(update(db, { name: 'Stale' }, { op: id(106) }))
  for (const patch of [{ username: 'rename' }, { role: 'owner' }, { password: 'secret' }, { auth_user_id: id(200) }, {}]) {
    await assert.rejects(update(db, patch, { version: 2, op: id(107) }))
  }
  for (const target of [owner.admin, otherOwner.admin]) await assert.rejects(update(db, { active: false }, { target, op: id(108) }))
})

test('deactivate/reactivate never revives old or disabled-period sessions; display-only edits do not revoke', async t => {
  const db = await setup(t)
  await update(db, { name: 'Display Only' })
  assert.equal((await profile(db)).length, 1)
  await update(db, { active: false }, { version: 2, op: id(110) })
  assert.equal((await profile(db)).length, 0)
  const during = { ...staff, session: id(14) }
  await db.query('INSERT INTO auth.sessions VALUES ($1,$2,clock_timestamp())', [during.session, staff.auth])
  await update(db, { active: true }, { version: 3, op: id(111) })
  assert.equal((await profile(db)).length, 0)
  assert.equal((await profile(db, during)).length, 0)
  const fresh = { ...staff, session: id(15) }
  await db.query('INSERT INTO auth.sessions VALUES ($1,$2,clock_timestamp())', [fresh.session, staff.auth])
  assert.equal((await profile(db, fresh)).length, 1)
})

test('self password locks exact caller including owner and finish uses only that scoped operation', async t => {
  const db = await setup(t)
  for (const [user, op, freshId] of [[staff, id(120), id(16)], [owner, id(121), id(17)]]) {
    assert.equal((await selfBegin(db, user, op)).dispatch, true)
    assert.equal((await profile(db, user)).length, 0)
    await assert.rejects(selfBegin(db, user, id(122)))
    await assert.rejects(selfFinish(db, otherOwner, op))
    await assert.rejects(selfFinish(db, { ...user, session: id(99) }, op))
    await assert.rejects(update(db, { active: true }, { target: user.admin, op: id(123) }))
    await db.query('INSERT INTO auth.sessions VALUES ($1,$2,clock_timestamp())', [freshId, user.auth])
    assert.equal((await selfFinish(db, user, op)).state, 'finished')
    assert.equal((await profile(db, user)).length, 0)
    assert.equal((await profile(db, { ...user, session: freshId })).length, 0)
    assert.equal((await selfFinish(db, user, op)).state, 'finished')
  }
})

test('existing 003 reset locks cannot be overwritten or finished by account operations', async t => {
  const db = await setup(t)
  await call(db, 'pos_begin_staff_password_reset', [owner.auth, staff.admin, id(130)])
  await assert.rejects(update(db, { active: false }))
  await assert.rejects(selfBegin(db))
  await assert.rejects(selfFinish(db, staff, id(130)))
  assert.equal((await profile(db)).length, 0)
})

test('concurrent claims and versioned edits admit one writer', async t => {
  const db = await setup(t)
  await reserve(db)
  assert.equal((await Promise.all([claim(db), claim(db), claim(db)])).filter(Boolean).length, 1)
  const attempts = await Promise.allSettled([update(db, { name: 'First' }), update(db, { name: 'Second' }, { op: id(140) })])
  assert.equal(attempts.filter(r => r.status === 'fulfilled').length, 1)
})

test('RPCs and private operation ledger deny direct callers despite permissive defaults', async t => {
  const db = await setup(t)
  const functions = [
    ['pos_account_reserve', [owner.auth, owner.session, id(150), 'new-one', 'New', 'staff', fp]],
    ['pos_account_claim', [owner.auth, owner.session, id(150)]],
    ['pos_account_finish_create', [owner.auth, owner.session, id(150), id(200)]],
    ['pos_account_update', [owner.auth, owner.session, id(151), staff.admin, 1, '{}', fp]],
    ['pos_account_status', [owner.auth, owner.session, id(150)]],
    ['pos_managed_accounts', [owner.auth, owner.session]],
    ['pos_self_password_begin', [staff.auth, staff.session, id(152), fp]],
    ['pos_self_password_finish', [staff.auth, staff.session, id(152)]],
    ['pos_self_password_status', [staff.auth, staff.session, id(152)]],
  ]
  for (const role of ['anon', 'authenticated']) for (const [name, args] of functions) {
    await assert.rejects(call(db, name, args, { role }), { code: '42501' })
  }
  await db.exec('GRANT USAGE ON SCHEMA pos_security TO anon, authenticated, service_role')
  for (const role of ['anon', 'authenticated', 'service_role']) await assert.rejects(db.transaction(async tx => {
    await tx.exec(`SET LOCAL ROLE ${role}`)
    await tx.query('SELECT * FROM pos_security.account_operations')
  }), { code: '42501' })
})

test('status is actor-scoped, returns history, and audit failure rolls back edits', async t => {
  const db = await setup(t)
  await reserve(db)
  await assert.rejects(status(db, id(100), otherOwner), { code: '42501' })
  assert.equal((await status(db, id(999))).state, 'unknown')
  await db.exec(`CREATE FUNCTION pos_security.reject_account_audit() RETURNS trigger LANGUAGE plpgsql AS
    $$ BEGIN RAISE EXCEPTION 'synthetic audit failure'; END $$;
    CREATE TRIGGER reject_account_audit BEFORE INSERT ON pos_security.account_operations
      FOR EACH ROW EXECUTE FUNCTION pos_security.reject_account_audit();`)
  await assert.rejects(update(db, { name: 'Must roll back' }), /synthetic audit failure/)
  assert.equal((await profile(db))[0].name, 'cashier')
})

test('cutoffs never move backwards and managed directory exposes neither owner nor Auth identity', async t => {
  const db = await setup(t)
  await db.query("UPDATE pos_security.user_access SET sessions_valid_after=clock_timestamp()+interval '1 hour' WHERE auth_user_id=$1", [staff.auth])
  const cutoff = async () => (await db.query('SELECT sessions_valid_after::text AS cutoff FROM pos_security.user_access WHERE auth_user_id=$1', [staff.auth])).rows[0].cutoff
  const before = await cutoff()
  await update(db, { active: false })
  assert.equal(await cutoff(), before)
  await update(db, { active: true }, { version: 2, op: id(160) })
  assert.equal(await cutoff(), before)
  await db.query("UPDATE auth.sessions SET created_at=clock_timestamp()+interval '2 hours' WHERE id=$1", [staff.session])
  await selfBegin(db)
  assert.equal(await cutoff(), before)
  await selfFinish(db)
  assert.equal(await cutoff(), before)
  await reserve(db)
  const list = await call(db, 'pos_managed_accounts', [owner.auth, owner.session])
  assert.equal(list.length, 2)
  assert.ok(list.every(a => a.role === 'staff'))
  assert.equal(JSON.stringify(list).includes(owner.auth), false)
  assert.equal(JSON.stringify(list).includes(staff.auth), false)
  assert.equal(JSON.stringify(list).includes('password'), false)
  assert.equal(list.find(a => a.version === 0).pending, true)
})

const response = () => ({ setHeader() {}, status(code) { this.statusCode = code; return this }, json(body) { this.body = body; return this } })
const httpOptions = { enabled: true, allowedOrigin: 'https://preview.example.test', hmacSecret: 'x'.repeat(64), getClientIp: () => '192.0.2.10' }
const request = body => ({ method: 'POST', headers: { origin: httpOptions.allowedOrigin, 'content-type': 'application/json',
  authorization: 'Bearer owner-token', 'idempotency-key': id(170) }, body })

test('real reservation conflicts on completed UUID reject HTTP replay with changed fields or password', async t => {
  const db = await setup(t)
  let authWrites = 0; let statusReads = 0
  const handler = createAccountLifecycleHandler({ ...httpOptions, consumeAttempt: async () => true,
    verifyOwner: async () => ({ authUserId: owner.auth, authSessionId: owner.session }), reauthenticate: async () => true,
    reserveAccount: (actor, op, fields, fingerprint) => call(db, 'pos_account_reserve', [actor.authUserId, actor.authSessionId, op, fields.username, fields.name, fields.role, fingerprint]),
    claimAccount: (actor, op) => call(db, 'pos_account_claim', [actor.authUserId, actor.authSessionId, op]),
    createAuthAccount: async op => { authWrites++; await db.query('INSERT INTO auth.users VALUES ($1,$2)', [id(200), `${op}@staff.skupy.invalid`]); return id(200) },
    finishAccount: (actor, op, authId) => call(db, 'pos_account_finish_create', [actor.authUserId, actor.authSessionId, op, authId]),
    accountStatus: (actor, op) => { statusReads++; return call(db, 'pos_account_status', [actor.authUserId, actor.authSessionId, op]) },
  })
  const body = { action: 'create', username: 'new-staff', name: 'New Staff', role: 'staff', initialPassword: 'new-strong-password', ownerPassword: 'owner-proof' }
  const first = response(); await handler(request(body), first)
  assert.equal(first.statusCode, 201)
  for (const patch of [{ name: 'Different' }, { role: 'admin' }, { username: 'other-staff' }, { initialPassword: 'another-strong-password' }]) {
    const res = response(); await handler(request({ ...body, ...patch }), res)
    assert.equal(res.statusCode, 403); assert.equal(res.body.ok, false); assert.equal(res.body.account, undefined)
  }
  const replay = response(); await handler(request(body), replay)
  assert.equal(replay.statusCode, 201); assert.deepEqual(replay.body.account, first.body.account)
  assert.equal(authWrites, 1); assert.equal(statusReads, 0)
})

test('real shared limiter exhausted by login denies account and self-password before any proof', async t => {
  const db = await setup(t)
  const consumeAttempt = keys => call(db, 'pos_consume_login_attempt', [keys])
  const login = createUsernameLoginHandler({ ...httpOptions, consumeAttempt, wait: async () => {},
    resolveAuthUserId: async () => null, getAuthEmail: async () => null, authenticate: async () => null })
  for (let i = 0; i < 60; i++) {
    const res = response(); await login(request({ username: `missing-${i}`, password: 'wrong' }), res)
    assert.equal(res.statusCode, 401)
  }
  let proofs = 0
  const deps = { ...httpOptions, consumeAttempt, verifyOwner: async () => { proofs++; return null }, verifySelf: async () => { proofs++; return null } }
  for (const [handler, body] of [
    [createAccountLifecycleHandler(deps), { action: 'list' }],
    [createSelfPasswordHandler(deps), { currentPassword: 'old', newPassword: 'new-strong-password' }],
    [createPasswordRecoveryHandler(deps), { targetAdminId: staff.admin, ownerPassword: 'proof', newPassword: 'new-strong-password' }],
  ]) {
    const res = response(); await handler(request(body), res)
    assert.equal(res.statusCode, 429)
  }
  assert.equal(proofs, 0)
})
