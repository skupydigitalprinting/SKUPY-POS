import test from 'node:test'
import assert from 'node:assert/strict'
import { createLocalDocker } from './localDocker.js'
import { readFile } from 'node:fs/promises'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { createAccountLifecycleHandler, createSelfPasswordHandler } from '../../server/accountLifecycle.js'
import { createSupabaseAccountDependencies } from '../../server/supabaseAccounts.js'

const isUuid = value => typeof value === 'string' && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)

function trackRunAccountWork(createOp, dependencies) {
  assert.ok(isUuid(createOp))
  const pending = new Set()
  let closing = false, authId = null, createAttempted = false
  const track = callback => {
    assert.equal(closing, false, 'No account work may start after cleanup begins')
    const promise = Promise.resolve().then(callback)
    pending.add(promise)
    promise.then(() => pending.delete(promise), () => pending.delete(promise))
    return promise
  }
  return {
    createOp,
    get authId() { return authId },
    get createAttempted() { return createAttempted },
    createAuthAccount: async (operation, password) => {
      assert.equal(operation, createOp)
      return track(async () => {
        createAttempted = true
        const result = await dependencies.createAuthAccount(operation, password)
        if (result) { assert.ok(isUuid(result)); authId = result }
        return result
      })
    },
    finishAccount: async (actor, operation, identity) => {
      assert.equal(operation, createOp)
      return track(() => dependencies.finishAccount(actor, operation, identity))
    },
    settle: async () => {
      closing = true
      await Promise.allSettled([...pending])
    },
  }
}

async function cleanupStaffRun({ work, sql, deleteUser, operationIds }) {
  assert.ok(isUuid(work.createOp) && operationIds.every(isUuid) && operationIds.includes(work.createOp))
  await work.settle()
  if (work.authId) assert.ok(isUuid(work.authId))
  const staffId = sql(`SELECT target_admin FROM pos_security.account_operations WHERE operation='${work.createOp}'`)
  if (staffId) assert.ok(isUuid(staffId))
  const mappedId = staffId ? sql(`SELECT auth_user_id FROM pos_security.user_access WHERE admin_id='${staffId}'`) : ''
  // Lab-only discovery/deletion, never account adoption. The alias belongs to this run's UUID.
  const lookup = `SELECT id FROM auth.users WHERE ${work.authId ? `id='${work.authId}' AND ` : ''}email='${work.createOp}@staff.skupy.invalid'`
  const authId = sql(lookup)
  if (authId) assert.ok(isUuid(authId), 'Synthetic alias must identify at most one Auth user')
  if (work.authId) assert.equal(authId, work.authId, 'Captured identity must still match this run\'s synthetic alias')
  if (mappedId) assert.equal(authId, mappedId, 'Never delete a different mapped identity')
  if (work.createAttempted && !authId) assert.fail('Auth outcome unresolved; retain the operation for explicit local reconciliation')
  if (authId) {
    assert.equal((await deleteUser(authId)).error, null)
    assert.equal(sql(lookup), '', 'Keep the operation until synthetic Auth deletion is confirmed')
  }
  sql(`DELETE FROM pos_security.account_operations WHERE operation IN (${operationIds.map(id => `'${id}'`).join(',')});${staffId ? ` DELETE FROM public.admins WHERE id='${staffId}';` : ''}`)
}

const fixtureId = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`
function cleanupFixture({ captured = true, deleteError = false } = {}) {
  const createOp = fixtureId(1), authId = fixtureId(2), staffId = fixtureId(3)
  let authExists = true, operationExists = true
  const queries = [], deletes = []
  const work = { createOp, authId: captured ? authId : null, createAttempted: true, settle: async () => {} }
  const sql = query => {
    queries.push(query)
    if (query.startsWith('SELECT target_admin')) return staffId
    if (query.startsWith('SELECT auth_user_id')) return ''
    if (query.startsWith('SELECT id FROM auth.users')) {
      assert.ok(query.includes(`email='${createOp}@staff.skupy.invalid'`))
      return authExists ? authId : ''
    }
    if (query.startsWith('DELETE FROM pos_security.account_operations')) {
      assert.ok(query.includes(`operation IN ('${createOp}')`))
      assert.ok(query.includes(`public.admins WHERE id='${staffId}'`))
      operationExists = false
      return ''
    }
    assert.fail(`Unexpected cleanup query: ${query}`)
  }
  const deleteUser = async id => {
    deletes.push(id)
    assert.equal(id, authId, 'Never delete an identity outside this run')
    if (deleteError) return { error: new Error('Synthetic delete failure') }
    authExists = false
    return { error: null }
  }
  return { work, sql, deleteUser, operationIds: [createOp], queries, deletes,
    authExists: () => authExists, operationExists: () => operationExists }
}

test('run cleanup removes an unmapped Auth orphan using captured ID or exact synthetic alias fallback', async () => {
  for (const captured of [true, false]) {
    const fixture = cleanupFixture({ captured })
    await cleanupStaffRun(fixture)
    assert.deepEqual(fixture.deletes, [fixtureId(2)])
    assert.equal(fixture.authExists(), false)
    assert.equal(fixture.operationExists(), false)
  }
})

test('failed orphan deletion preserves the operation instead of erasing cleanup evidence', async () => {
  const fixture = cleanupFixture({ deleteError: true })
  await assert.rejects(cleanupStaffRun(fixture))
  assert.equal(fixture.operationExists(), true)
  assert.equal(fixture.authExists(), true)
})

test('cleanup waits for a known Auth create and captures its actual ID before deleting', async () => {
  const fixture = cleanupFixture()
  let release, started
  const dispatched = new Promise(resolve => { started = resolve })
  const work = trackRunAccountWork(fixture.work.createOp, {
    createAuthAccount: async () => { started(); return new Promise(resolve => { release = resolve }) },
    finishAccount: async () => assert.fail('No finish may be dispatched after cleanup begins'),
  })
  const creation = work.createAuthAccount(work.createOp, 'synthetic-password')
  await dispatched
  const cleanup = cleanupStaffRun({ ...fixture, work })
  await Promise.resolve()
  assert.equal(fixture.queries.length, 0); assert.equal(fixture.deletes.length, 0)
  release(fixtureId(2))
  assert.equal(await creation, fixtureId(2))
  await cleanup
  assert.equal(work.authId, fixtureId(2))
  assert.deepEqual(fixture.deletes, [fixtureId(2)])
  assert.ok(fixture.queries.some(query => query.startsWith(`SELECT id FROM auth.users WHERE id='${fixtureId(2)}' AND email=`)))
  await assert.rejects(work.finishAccount({}, work.createOp, work.authId), /after cleanup begins/)
})

test('successful Auth create followed by delayed binding failure is settled before orphan cleanup', async () => {
  const fixture = cleanupFixture()
  let release, started
  const dispatched = new Promise(resolve => { started = resolve })
  const work = trackRunAccountWork(fixture.work.createOp, {
    createAuthAccount: async () => fixtureId(2),
    finishAccount: async () => { started(); await new Promise(resolve => { release = resolve }); throw new Error('Injected binding failure') },
  })
  await work.createAuthAccount(work.createOp, 'synthetic-password')
  const finishing = work.finishAccount({}, work.createOp, work.authId)
  const rejected = assert.rejects(finishing, /Injected binding failure/)
  await dispatched
  const cleanup = cleanupStaffRun({ ...fixture, work })
  await Promise.resolve()
  assert.equal(fixture.queries.length, 0); assert.equal(fixture.deletes.length, 0)
  release()
  await rejected; await cleanup
  assert.deepEqual(fixture.deletes, [fixtureId(2)])
  assert.equal(fixture.operationExists(), false)
})

test('unresolved or mismatched synthetic Auth identity never deletes a user or its operation', async () => {
  for (const unexpected of ['', fixtureId(99)]) {
    const fixture = cleanupFixture()
    const sql = query => query.startsWith('SELECT id FROM auth.users') ? unexpected : fixture.sql(query)
    await assert.rejects(cleanupStaffRun({ ...fixture, sql }))
    assert.deepEqual(fixture.deletes, [])
    assert.equal(fixture.operationExists(), true)
  }
  const fixture = cleanupFixture({ captured: false })
  await assert.rejects(cleanupStaffRun({ ...fixture,
    sql: query => query.startsWith('SELECT id FROM auth.users') ? '' : fixture.sql(query) }), /outcome unresolved/)
  assert.equal(fixture.operationExists(), true)
})

test('local real Auth/REST account creation, role cutoff, self-password and disabling', {
  skip: process.env.SKUPY_RUN_LOCAL_ACCOUNT_TESTS !== '1', timeout: 90000,
}, async t => {
  const cli = process.env.SUPABASE_BIN || 'supabase'
  const docker = createLocalDocker()
  const containerId = docker.inspect('supabase_db_skupy-auth-local')
  docker.inspect('supabase_kong_skupy-auth-local')
  const status = docker.status(cli, '/private/tmp/skupy-auth-local')
  assert.equal(status.API_URL, 'http://127.0.0.1:54321')
  const sql = input => docker.exec(containerId, ['psql','-U','postgres','-d','postgres','-At','-v','ON_ERROR_STOP=1'], { input, encoding: 'utf8', stdio: ['pipe','pipe','pipe'], timeout: 15000 }).trim()
  const candidates = await Promise.all(['001_identity_bridge.sql','002_username_login.sql','003_password_recovery.sql','004_password_reset_status.sql','005_staff_directory.sql'].map(file => readFile(new URL(`../../supabase/security-stage2/${file}`, import.meta.url),'utf8')))
  const digest = value => createHash('sha256').update(value).digest('hex')
  assert.equal(sql("SELECT string_agg(tablename,',' ORDER BY tablename) FROM pg_tables WHERE schemaname='public'"), 'admins')
  assert.equal(sql('SELECT checksum FROM pos_security.lab_manifest'), digest(candidates.join('')), 'Run and verify the original local Auth lab first')
  const candidate = await readFile(new URL('../../supabase/security-stage2/007_account_lifecycle.sql', import.meta.url),'utf8')
  const parity = 'ALTER TABLE public.admins ADD COLUMN updated_at timestamptz DEFAULT now();'
  const checksum = digest(parity + candidate)
  if (sql("SELECT to_regclass('pos_security.lab_accounts_manifest') IS NOT NULL") === 't') {
    assert.equal(sql('SELECT checksum FROM pos_security.lab_accounts_manifest'), checksum, 'Reviewed account candidate changed: rebuild an isolated lab, never replay it')
  } else {
    assert.equal(sql("SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='admins' AND column_name='updated_at'"), '0')
    assert.equal(sql("SELECT to_regclass('pos_security.account_operations') IS NULL"), 't')
    // One psql session; outer transaction is supplied by the candidate itself.
    const prepared = candidate.replace('BEGIN;', `BEGIN;\n${parity}`)
      .replace('COMMIT;', `CREATE TABLE pos_security.lab_accounts_manifest(checksum text NOT NULL); REVOKE ALL ON pos_security.lab_accounts_manifest FROM PUBLIC,anon,authenticated,service_role; INSERT INTO pos_security.lab_accounts_manifest VALUES('${checksum}'); COMMIT;`)
    sql(prepared)
  }
  sql("NOTIFY pgrst,'reload schema';")
  const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }
  const admin = createClient(status.API_URL,status.SERVICE_ROLE_KEY,options)
  const ownerClient = createClient(status.API_URL,status.ANON_KEY,options)
  const staffClient = createClient(status.API_URL,status.ANON_KEY,options)
  const ownerId = randomUUID(), createOp = randomUUID(), selfOp = randomUUID(), roleOp = randomUUID(), disableOp = randomUUID(), staleOp = randomUUID()
  const ownerName = `owner-${randomBytes(8).toString('hex')}`
  const staffName = `staff-${randomBytes(8).toString('hex')}`
  const ownerPassword = randomBytes(24).toString('base64url')
  const initialPassword = randomBytes(24).toString('base64url')
  const newPassword = randomBytes(24).toString('base64url')
  let ownerAuthId, staffId
  const origin = 'http://127.0.0.1:55555'
  const dependencies = { ...createSupabaseAccountDependencies({ url: status.API_URL, anonKey: status.ANON_KEY, serviceKey: status.SERVICE_ROLE_KEY }),
    enabled: true, allowedOrigin: origin, hmacSecret: randomBytes(32).toString('hex'), getClientIp: () => '127.0.0.1' }
  const accountWork = trackRunAccountWork(createOp, dependencies)
  const accountHandler = createAccountLifecycleHandler({ ...dependencies,
    createAuthAccount: accountWork.createAuthAccount, finishAccount: accountWork.finishAccount })
  const passwordHandler = createSelfPasswordHandler(dependencies)
  const invoke = async (handler, token, body, operation) => {
    const req = { method: 'POST', headers: { origin, authorization: `Bearer ${token}`, 'content-type':'application/json', ...(operation ? {'idempotency-key':operation} : {}) }, body }
    const res = { statusCode:200, setHeader(){}, status(value){this.statusCode=value;return this}, json(value){this.body=value;return this} }
    await handler(req,res)
    return res
  }
  try {
    const created = await admin.auth.admin.createUser({ email:`${ownerName}@example.test`, password:ownerPassword,email_confirm:true })
    assert.equal(created.error,null); ownerAuthId=created.data.user.id
    sql(`INSERT INTO public.admins(id,username,name,role,password) VALUES('${ownerId}','${ownerName}','Synthetic owner','staff','unused'); INSERT INTO pos_security.user_access(auth_user_id,admin_id,role,active,login_username) VALUES('${ownerAuthId}','${ownerId}','owner',true,'${ownerName}');`)
    const login = await ownerClient.auth.signInWithPassword({ email:`${ownerName}@example.test`,password:ownerPassword })
    assert.equal(login.error,null)
    const ownerToken = login.data.session.access_token
    // Poll only the expected schema availability before dispatching a mutation.
    for (let i=0;i<20;i++) {
      const list = await invoke(accountHandler,ownerToken,{action:'list'})
      if (list.statusCode===200) break
      if (i===19) assert.fail('Local REST account schema not available')
      await new Promise(resolve => setTimeout(resolve,100))
    }
    const createdStaff = await invoke(accountHandler,ownerToken,{action:'create',username:staffName,name:'Synthetic staff',role:'staff',initialPassword,ownerPassword},createOp)
    assert.equal(createdStaff.statusCode,201,'Local account creation must complete through real Auth and REST')
    staffId=createdStaff.body.account.id
    assert.equal(accountWork.authId,sql(`SELECT auth_user_id FROM pos_security.user_access WHERE admin_id='${staffId}'`))
    const email=`${createOp}@staff.skupy.invalid`
    assert.equal((await staffClient.auth.signInWithPassword({email,password:initialPassword})).error,null)
    assert.equal((await staffClient.rpc('pos_current_profile')).data?.[0]?.role,'staff')
    const firstToken=(await staffClient.auth.getSession()).data.session.access_token
    assert.equal((await invoke(accountHandler,firstToken,{action:'list'})).statusCode,403)
    const changed=await invoke(accountHandler,ownerToken,{action:'update',targetAdminId:staffId,expectedVersion:1,patch:{role:'admin'},ownerPassword},roleOp)
    assert.equal(changed.statusCode,200)
    assert.equal((await staffClient.rpc('pos_current_profile')).data?.length,0)
    assert.equal((await staffClient.auth.signInWithPassword({email,password:initialPassword})).error,null)
    assert.equal((await staffClient.rpc('pos_current_profile')).data?.[0]?.role,'admin')
    const token=(await staffClient.auth.getSession()).data.session.access_token
    const passwordResult=await invoke(passwordHandler,token,{currentPassword:initialPassword,newPassword},selfOp)
    assert.equal(passwordResult.statusCode,200,'Self-password must complete through real Auth and REST')
    assert.equal(passwordResult.body.reauthenticationRequired,true)
    assert.equal((await staffClient.rpc('pos_current_profile')).data?.length,0)
    assert.ok((await staffClient.auth.signInWithPassword({email,password:initialPassword})).error)
    assert.equal((await staffClient.auth.signInWithPassword({email,password:newPassword})).error,null)
    assert.equal((await staffClient.rpc('pos_current_profile')).data?.[0]?.role,'admin')
    const stale=await invoke(accountHandler,ownerToken,{action:'update',targetAdminId:staffId,expectedVersion:2,patch:{active:false},ownerPassword},staleOp)
    assert.equal(stale.statusCode,409,'A password change must invalidate stale account edits')
    const latest=await invoke(accountHandler,ownerToken,{action:'list'})
    const version=latest.body.accounts.find(a=>a.id===staffId).version
    assert.equal(version,3)
    const disabled=await invoke(accountHandler,ownerToken,{action:'update',targetAdminId:staffId,expectedVersion:version,patch:{active:false},ownerPassword},disableOp)
    assert.equal(disabled.statusCode,200)
    assert.equal((await staffClient.rpc('pos_current_profile')).data?.length,0)
    t.diagnostic('Real local Auth/REST lifecycle passed; no production accounts or email delivery involved.')
  } finally {
    await accountWork.settle()
    await Promise.allSettled([ownerClient.auth.signOut({scope:'local'}),staffClient.auth.signOut({scope:'local'})])
    try {
      await cleanupStaffRun({ work: accountWork, sql,
        deleteUser: id => admin.auth.admin.deleteUser(id), operationIds: [createOp,selfOp,roleOp,disableOp,staleOp] })
    } finally {
      if (ownerAuthId) assert.equal((await admin.auth.admin.deleteUser(ownerAuthId)).error,null)
      sql(`DELETE FROM public.admins WHERE id='${ownerId}';`)
    }
  }
})
