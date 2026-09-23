import test from 'node:test'
import assert from 'node:assert/strict'
import { createLocalDocker } from './localDocker.js'
import { readFile } from 'node:fs/promises'
import { createHash, randomUUID, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { createClient } from '@supabase/supabase-js'
import { createUsernameLoginHandler } from '../../server/usernameLogin.js'
import { createSupabaseLoginDependencies } from '../../server/supabaseUsername.js'
import { createPosAuth } from '../../src/lib/posAuth.js'
import { createPasswordRecoveryHandler } from '../../server/passwordRecovery.js'
import { createSupabaseRecoveryDependencies } from '../../server/supabaseRecovery.js'

test('local-only real Auth + REST username login, denial, logout and rate limits', {
  skip: process.env.SKUPY_RUN_LOCAL_AUTH_TESTS !== '1', timeout: 90000,
}, async t => {
  const progress = label => t.diagnostic(label)
  // Hard stop before any write unless both CLI endpoint and Docker label are local.
  const dir = '/private/tmp/skupy-auth-local'
  const bin = process.env.SUPABASE_BIN || 'supabase'
  const docker = createLocalDocker()
  const containerId = docker.inspect('supabase_db_skupy-auth-local')
  docker.inspect('supabase_kong_skupy-auth-local')
  const status = docker.status(bin, dir)
  progress('Local CLI status checked')
  const url = new URL(status.API_URL)
  assert.equal(url.protocol, 'http:')
  assert.equal(url.hostname, '127.0.0.1')
  assert.equal(url.port, '54321')
  const sql = input => docker.exec(containerId, ['psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At'], {
    input, encoding: 'utf8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'],
  }).trim()
  const candidate1 = await readFile(new URL('../../supabase/security-stage2/001_identity_bridge.sql', import.meta.url), 'utf8')
  const candidate2 = await readFile(new URL('../../supabase/security-stage2/002_username_login.sql', import.meta.url), 'utf8')
  const candidate3 = await readFile(new URL('../../supabase/security-stage2/003_password_recovery.sql', import.meta.url), 'utf8')
  const candidate4 = await readFile(new URL('../../supabase/security-stage2/004_password_reset_status.sql', import.meta.url), 'utf8')
  const candidate5 = await readFile(new URL('../../supabase/security-stage2/005_staff_directory.sql', import.meta.url), 'utf8')
  const priorChecksum = createHash('sha256').update(candidate1 + candidate2).digest('hex')
  const recoveryChecksum = createHash('sha256').update(candidate1 + candidate2 + candidate3).digest('hex')
  const statusChecksum = createHash('sha256').update(candidate1 + candidate2 + candidate3 + candidate4).digest('hex')
  const checksum = createHash('sha256').update(candidate1 + candidate2 + candidate3 + candidate4 + candidate5).digest('hex')
  const manifestExists = sql("SELECT to_regclass('pos_security.lab_manifest') IS NOT NULL") === 't'
  if (manifestExists) {
    // Only upgrade this exact previously verified synthetic lab, never a real schema.
    if (sql('SELECT checksum FROM pos_security.lab_manifest') === priorChecksum) {
      sql(`${candidate3}\n${candidate4}\n${candidate5}\nUPDATE pos_security.lab_manifest SET checksum = '${checksum}'; NOTIFY pgrst, 'reload schema';`)
    } else if (sql('SELECT checksum FROM pos_security.lab_manifest') === recoveryChecksum) {
      sql(`${candidate4}\n${candidate5}\nUPDATE pos_security.lab_manifest SET checksum = '${checksum}'; NOTIFY pgrst, 'reload schema';`)
    } else if (sql('SELECT checksum FROM pos_security.lab_manifest') === statusChecksum) {
      sql(`${candidate5}\nUPDATE pos_security.lab_manifest SET checksum = '${checksum}'; NOTIFY pgrst, 'reload schema';`)
    }
    assert.equal(sql('SELECT checksum FROM pos_security.lab_manifest'), checksum, 'Lab schema changed; rebuild isolated lab before rerunning')
  } else {
    assert.equal(sql("SELECT count(*) FROM information_schema.tables WHERE table_schema='public'"), '0', 'Refusing to modify a database with pre-existing public tables')
    sql(`CREATE TABLE public.admins (id uuid PRIMARY KEY, username text NOT NULL, name text, role text, password text);
      ${candidate1}
      ${candidate2}
      ${candidate3}
      ${candidate4}
      ${candidate5}
      CREATE TABLE pos_security.lab_manifest(checksum text NOT NULL);
      REVOKE ALL ON pos_security.lab_manifest FROM PUBLIC, anon, authenticated;
      INSERT INTO pos_security.lab_manifest VALUES ('${checksum}');
      NOTIFY pgrst, 'reload schema';`)
  }
  assert.ok(status.ANON_KEY && status.SERVICE_ROLE_KEY, 'Local CLI must provide test keys')
  progress('Loopback isolation and candidate schema checked')
  const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }
  const admin = createClient(url.origin, status.SERVICE_ROLE_KEY, options)
  const client = createClient(url.origin, status.ANON_KEY, options)
  const password = randomBytes(24).toString('base64url')
  const username = `test-${randomUUID()}`
  const adminId = randomUUID()
  const { data, error } = await admin.auth.admin.createUser({ email: `${username}@example.test`, password, email_confirm: true })
  assert.equal(error, null, 'Local synthetic Auth account creation failed')
  const userId = data.user.id
  progress('Synthetic staff created')
  let ownerUserId
  const ownerAdminId = randomUUID()
  const ownerClient = createClient(url.origin, status.ANON_KEY, options)
  let server
  try {
    sql(`INSERT INTO public.admins(id,username,name,role,password) VALUES ('${adminId}', '${username}', 'Local Test', 'owner', 'unused-dummy');
      INSERT INTO pos_security.user_access (auth_user_id, admin_id, role, active, login_username)
      VALUES ('${userId}', '${adminId}', 'staff', true, '${username}');`)
    const deps = createSupabaseLoginDependencies({ url: url.origin, anonKey: status.ANON_KEY, serviceKey: status.SERVICE_ROLE_KEY })
    let handler
    let resetHandler
    server = createServer(async (req, res) => {
      res.status = code => { res.statusCode = code; return res }
      res.json = body => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)) }
      try {
        let body = ''
        for await (const part of req) { body += part; if (body.length > 8192) { res.status(413).json({}); return } }
        req.body = JSON.parse(body || '{}')
        await (req.url === '/api/auth/reset-staff-password' ? resetHandler : handler)(req, res)
      } catch { res.status(500).json({ error: 'Local test request failed' }) }
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const origin = `http://127.0.0.1:${server.address().port}`
    handler = createUsernameLoginHandler({ enabled: true, allowedOrigin: origin, hmacSecret: randomBytes(32).toString('hex'), getClientIp: req => req.socket.remoteAddress, ...deps })
    const recoveryDeps = createSupabaseRecoveryDependencies({ url: url.origin, anonKey: status.ANON_KEY, serviceKey: status.SERVICE_ROLE_KEY })
    let loseBeginResponse = false, loseFinishResponse = false
    let delayBegin = false, delayFinish = false, completeDelayed, finishDelayedBegin
    resetHandler = createPasswordRecoveryHandler({ enabled: true, allowedOrigin: origin, hmacSecret: randomBytes(32).toString('hex'),
      getClientIp: req => req.socket.remoteAddress,
      ...recoveryDeps,
      beginReset: async (...args) => {
        if (delayBegin) {
          delayBegin = false
          completeDelayed = () => recoveryDeps.beginReset(...args)
          finishDelayedBegin = () => recoveryDeps.finishReset(...args)
          throw new Error('Synthetic transport failure before delayed remote begin')
        }
        const result = await recoveryDeps.beginReset(...args)
        if (loseBeginResponse) { loseBeginResponse = false; throw new Error('Synthetic lost response after commit') }
        return result
      },
      finishReset: async (...args) => {
        if (delayFinish) {
          delayFinish = false
          completeDelayed = () => recoveryDeps.finishReset(...args)
          throw new Error('Synthetic transport failure before delayed remote finish')
        }
        const result = await recoveryDeps.finishReset(...args)
        if (loseFinishResponse) { loseFinishResponse = false; throw new Error('Synthetic lost response after commit') }
        return result
      },
    })
    const fetchImpl = (path, opts) => fetch(new URL(path, origin), { ...opts, headers: { ...opts.headers, Origin: origin } })
    const auth = createPosAuth(client, { fetchImpl, bindSession: true })
    const loggedIn = await auth.signInUsername(username, password)
    assert.equal(loggedIn.ok, true, 'Live username login should succeed')
    progress('Real username login passed')
    assert.equal(loggedIn.user.id, adminId)
    assert.equal(loggedIn.user.role, 'staff')
    assert.equal((await auth.restore()).ok, true)
    assert.equal((await auth.signOut()).ok, true)
    assert.equal((await auth.restore()).ok, false)
    assert.equal((await auth.signInUsername(username, 'wrong-password')).ok, false)
    assert.equal((await auth.signInUsername(username, password)).ok, true)
    const ownerPassword = randomBytes(24).toString('base64url')
    const ownerEmail = `owner-${randomUUID()}@example.test`
    const ownerCreated = await admin.auth.admin.createUser({ email: ownerEmail, password: ownerPassword, email_confirm: true })
    assert.equal(ownerCreated.error, null)
    ownerUserId = ownerCreated.data.user.id
    sql(`INSERT INTO public.admins(id,username,name,role,password) VALUES ('${ownerAdminId}', 'owner-${ownerAdminId}', 'Synthetic Owner', 'staff', 'unused');
      INSERT INTO pos_security.user_access (auth_user_id, admin_id, role, active, login_username)
      VALUES ('${ownerUserId}', '${ownerAdminId}', 'owner', true, 'owner-${ownerAdminId}');`)
    const ownerLogin = await ownerClient.auth.signInWithPassword({ email: ownerEmail, password: ownerPassword })
    assert.equal(ownerLogin.error, null)
    const ownerToken = ownerLogin.data.session.access_token
    progress('Synthetic owner authenticated')
    const directory = await ownerClient.rpc('pos_resettable_staff')
    assert.equal(directory.error, null)
    assert.deepEqual(directory.data, [{ id: adminId, username, name: 'Local Test', role: 'staff', reset_pending: false }], 'Directory must use trusted roles despite inverted legacy roles')
    assert.ok((await client.rpc('pos_resettable_staff')).error, 'Staff cannot read the owner reset directory')
    const staffToken = (await client.auth.getSession()).data.session.access_token
    const newPassword = randomBytes(24).toString('base64url')
    const reset = (token, proof) => fetchImpl('/api/auth/reset-staff-password', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ targetAdminId: adminId, ownerPassword: proof, newPassword }),
    })
    assert.equal((await reset(staffToken, password)).status, 403, 'Staff cannot reset another account')
    assert.equal((await reset(ownerToken, 'wrong-owner-password')).status, 403)
    assert.equal((await reset(ownerToken, ownerPassword)).status, 200)
    progress('Owner reset endpoint passed')
    const staleProfile = await client.rpc('pos_current_profile')
    assert.ok(staleProfile.error || staleProfile.data.length === 0, 'Old staff session cannot access profile after reset')
    assert.equal((await auth.signInUsername(username, password)).ok, false, 'Old password rejected')
    assert.equal((await auth.signInUsername(username, newPassword)).ok, true, 'New password creates an allowed fresh session')
    loseBeginResponse = true
    loseFinishResponse = true
    assert.equal((await reset(ownerToken, ownerPassword)).status, 200, 'Lost committed begin and finish responses reconcile through real SQL audit')
    assert.equal((await auth.signInUsername(username, newPassword)).ok, true)
    progress('Lost committed RPC responses reconciled')
    delayBegin = true
    const delayedBeginResponse = await reset(ownerToken, ownerPassword)
    assert.equal(delayedBeginResponse.status, 503)
    assert.equal((await delayedBeginResponse.json()).uncertain, true, 'Not-started snapshot cannot prove a delayed begin will not commit')
    assert.equal(await completeDelayed(), userId)
    assert.equal((await ownerClient.rpc('pos_resettable_staff')).data?.[0]?.reset_pending, true)
    assert.equal(await finishDelayedBegin(), true, 'Explicitly finish only this synthetic lab operation')
    delayFinish = true
    const delayedFinishResponse = await reset(ownerToken, ownerPassword)
    assert.equal(delayedFinishResponse.status, 503)
    const delayedBody = await delayedFinishResponse.json()
    assert.equal(delayedBody.uncertain, true)
    assert.equal(delayedBody.locked, undefined)
    assert.equal(await completeDelayed(), true)
    assert.equal((await ownerClient.rpc('pos_resettable_staff')).data?.[0]?.reset_pending, false)
    assert.equal((await auth.signInUsername(username, newPassword)).ok, true)
    progress('Delayed remote begin and finish remain uncertain until completion')
    const operations = Array.from({ length: 8 }, () => randomUUID())
    const locks = await Promise.all(operations.map(operation => admin.rpc('pos_begin_staff_password_reset', {
      p_actor: ownerUserId, p_target_admin: adminId, p_operation: operation,
    })))
    assert.equal(locks.filter(r => !r.error && r.data?.length === 1).length, 1, 'Exactly one concurrent reset can acquire the target')
    assert.ok((await client.rpc('pos_current_profile')).data?.length === 0, 'Pending reset locks existing sessions')
    assert.equal((await ownerClient.rpc('pos_resettable_staff')).data?.[0]?.reset_pending, true)
    const winner = operations[locks.findIndex(r => !r.error && r.data?.length === 1)]
    assert.equal((await admin.rpc('pos_finish_staff_password_reset', { p_actor: ownerUserId, p_target_admin: adminId, p_operation: winner })).data, true)
    progress('Concurrent reset locks passed')
    sql(`UPDATE pos_security.user_access SET active = false WHERE auth_user_id = '${userId}'`)
    assert.equal((await auth.restore()).ok, false)
    assert.equal((await auth.signInUsername(username, password)).ok, false)
    const anonymous = createClient(url.origin, status.ANON_KEY, options)
    assert.ok((await anonymous.rpc('pos_resolve_login', { p_username: username })).error)
    assert.ok((await anonymous.rpc('pos_current_profile')).error)
    assert.ok((await anonymous.rpc('pos_resettable_staff')).error)
    const unknown = `missing-${randomUUID()}`
    for (let i = 0; i < 11; i++) {
      const result = await fetchImpl('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: unknown, password: 'wrong' }) })
      assert.equal(result.status, i < 10 ? 401 : 429)
      assert.equal(result.headers.get('cache-control'), 'no-store')
    }
    const concurrentKeys = ['global', `ip:${randomBytes(32).toString('hex')}`, `user:${randomBytes(32).toString('hex')}`]
    const attempts = await Promise.all(Array.from({ length: 20 }, () => admin.rpc('pos_consume_login_attempt', { p_keys: concurrentKeys })))
    assert.ok(attempts.every(r => !r.error), 'Concurrent limiter requests must not error or deadlock')
    assert.equal(attempts.filter(r => r.data === true).length, 10, 'Concurrent requests must not exceed username limit')
  } finally {
    progress('Cleaning synthetic accounts')
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
    await client.auth.signOut({ scope: 'local' })
    await ownerClient.auth.signOut({ scope: 'local' })
    // Deletes only the synthetic account and rows created by this run.
    const removed = await admin.auth.admin.deleteUser(userId)
    assert.equal(removed.error, null, 'Synthetic local Auth cleanup failed')
    sql(`DELETE FROM public.admins WHERE id = '${adminId}'`)
    if (ownerUserId) {
      assert.equal((await admin.auth.admin.deleteUser(ownerUserId)).error, null)
      sql(`DELETE FROM public.admins WHERE id = '${ownerAdminId}'`)
    }
  }
})
