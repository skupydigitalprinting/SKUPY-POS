import test from 'node:test'
import assert from 'node:assert/strict'
import { createSupabaseAccountDependencies, createPreviewAccountsHandler, createPreviewSelfPasswordHandler } from '../server/supabaseAccounts.js'

const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const token = (sub = id(1), sid = id(2)) => `header.${Buffer.from(JSON.stringify({ sub, session_id: sid })).toString('base64url')}.signature`
function setup({ role = 'owner', verifiedId = id(1), cleanupError = false, profileError = false } = {}) {
  const calls = []
  const factory = (url, key, options) => {
    calls.push(['client', key, options])
    return {
      rpc: async (name, args) => {
        calls.push(['rpc', key, name, args])
        return name === 'pos_current_profile'
          ? { data: [{ id: id(3), auth_user_id: verifiedId, role }], error: profileError ? {} : null }
          : { data: true, error: null }
      },
      auth: {
        getUser: async () => ({ data: { user: { id: verifiedId } }, error: null }),
        signInWithPassword: async args => { calls.push(['signIn', key, args]); return { data: { session: {} }, error: null } },
        signOut: async args => { calls.push(['signOut', key, args]); return { error: cleanupError ? {} : null } },
        admin: {
          getUserById: async userId => ({ data: { user: { id: userId, email: 'internal@staff.skupy.invalid' } }, error: null }),
          createUser: async args => { calls.push(['create', key, args]); return { data: { user: { id: id(5), email: args.email } }, error: null } },
          updateUserById: async (userId, args) => { calls.push(['update', key, userId, args]); return { data: { user: { id: userId } }, error: null } },
        },
      },
    }
  }
  return { calls, dependencies: createSupabaseAccountDependencies({ url: 'https://test.supabase.co', anonKey: 'anon', serviceKey: 'service' }, factory) }
}

test('owner proof reuses verified Auth/profile and adds matching routing session only', async () => {
  const { dependencies: d, calls } = setup()
  assert.deepEqual(await d.verifyOwner(token()), { authUserId: id(1), authSessionId: id(2) })
  assert.equal(await d.verifyOwner(token(id(8))), null)
  assert.equal(await d.verifyOwner('bad'), null)
  assert.equal(await setup({ role: 'staff' }).dependencies.verifyOwner(token()), null)
  assert.equal(await setup({ profileError: true }).dependencies.verifyOwner(token()), null)
  assert.ok(calls.some(c => c[0] === 'client' && c[1] === 'anon' && c[2].global?.headers.Authorization === `Bearer ${token()}`))
})

test('staff self proof permits mapped staff, cleans fresh session, and fails on cleanup errors', async () => {
  const { dependencies: d, calls } = setup({ role: 'staff' })
  assert.deepEqual(await d.verifySelf(token()), { authUserId: id(1), authSessionId: id(2) })
  assert.equal(await d.reauthenticateSelf(id(1), 'current-password'), true)
  assert.equal(await d.reauthenticate(id(1), 'current-password'), false)
  assert.equal(calls.filter(c => c[0] === 'signOut').length, 2)
  assert.ok(calls.filter(c => c[0] === 'signIn').every(c => c[1] === 'anon'))
  assert.equal(await setup({ cleanupError: true }).dependencies.reauthenticateSelf(id(1), 'pw'), false)
  assert.equal(await setup({ verifiedId: id(9) }).dependencies.reauthenticateSelf(id(1), 'pw'), false)
})

test('creation uses operation synthetic identifier once; no real email confirmation or adoption API', async () => {
  const { dependencies: d, calls } = setup()
  assert.equal(await d.createAuthAccount(id(4), 'new-password'), id(5))
  assert.deepEqual(calls.find(c => c[0] === 'create'), ['create', 'service', {
    email: `${id(4)}@staff.skupy.invalid`, password: 'new-password', email_confirm: true,
  }])
  assert.equal(await d.createAuthAccount('real@example.test', 'pw'), null)
  assert.equal(calls.filter(c => c[0] === 'create').length, 1)
})

test('all lifecycle RPCs carry exact actor session, only safe account fields enter SQL', async () => {
  const { dependencies: d, calls } = setup()
  const actor = { authUserId: id(1), authSessionId: id(2) }
  await d.listAccounts(actor)
  await d.reserveAccount(actor, id(4), { username: 'staff', name: 'Staff', role: 'staff' }, 'f'.repeat(64))
  await d.claimAccount(actor, id(4))
  await d.finishAccount(actor, id(4), id(5))
  await d.updateAccount(actor, id(4), id(3), 2, { active: false }, 'f'.repeat(64))
  await d.accountStatus(actor, id(4))
  await d.beginSelfPassword(actor, id(4), 'f'.repeat(64))
  await d.finishSelfPassword(actor, id(4))
  await d.selfPasswordStatus(actor, id(4))
  const rpc = calls.filter(c => c[0] === 'rpc')
  assert.equal(rpc.length, 9)
  for (const c of rpc) {
    assert.equal(c[1], 'service'); assert.equal(c[3].p_actor, id(1)); assert.equal(c[3].p_session, id(2))
    assert.equal(JSON.stringify(c[3]).includes('password'), false)
  }
  assert.deepEqual(rpc.find(c => c[2] === 'pos_self_password_finish')[3], { p_actor: id(1), p_session: id(2), p_operation: id(4) })
})

test('both preview entry points fail closed without explicit isolated preview configuration', async () => {
  for (const factory of [createPreviewAccountsHandler, createPreviewSelfPasswordHandler]) {
    const res = { setHeader() {}, status(n) { this.code = n; return this }, json(body) { this.body = body } }
    await factory({ VERCEL_ENV: 'production', POS_USERNAME_LOGIN_ENABLED: 'true' })({}, res)
    assert.equal(res.code, 503); assert.equal(res.body.ok, false)
  }
})
