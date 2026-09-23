import test from 'node:test'
import assert from 'node:assert/strict'
import { createSupabaseRecoveryDependencies, createPreviewRecoveryHandler } from '../server/supabaseRecovery.js'

function fixture({ role = 'owner', identity = 'owner-id', profileId = 'owner-id', logoutError = null } = {}) {
  const calls = []
  const factory = (url, key, options) => {
    const record = { key, options }; calls.push(record)
    return {
      auth: {
        admin: {
          getUserById: async () => ({ data: { user: { email: 'alias@example.test' } } }),
          updateUserById: async (id, fields) => { record.updated = { id, fields }; return { data: { user: { id } } } },
        },
        getUser: async token => { record.token = token; return { data: { user: { id: identity } } } },
        signInWithPassword: async input => { record.login = input; return { data: { session: { access_token: 'ephemeral' } } } },
        signOut: async options => { record.logout = options; return { error: logoutError } },
      },
      rpc: async (name, args) => {
        record.rpc = { name, args }
        if (name === 'pos_current_profile') return { data: [{ id: 'legacy', auth_user_id: profileId, username: 'owner', role }] }
        if (name === 'pos_begin_staff_password_reset') return { data: [{ auth_user_id: 'target' }] }
        return { data: true }
      },
    }
  }
  return { calls, deps: createSupabaseRecoveryDependencies({ url: 'https://test.supabase.co', anonKey: 'anon', serviceKey: 'service' }, factory) }
}

test('owner proof uses bearer-specific unprivileged client, not client metadata or service profile', async () => {
  const f = fixture()
  assert.deepEqual(await f.deps.verifyOwner('bearer'), { authUserId: 'owner-id' })
  assert.equal(f.calls[1].key, 'anon')
  assert.equal(f.calls[1].token, 'bearer')
  assert.equal(f.calls[1].options.global.headers.Authorization, 'Bearer bearer')
  assert.equal(f.calls[0].rpc, undefined)
})

test('staff and mismatched identities cannot prove owner', async () => {
  for (const args of [{ role: 'staff' }, { profileId: 'other-id' }]) {
    assert.equal(await fixture(args).deps.verifyOwner('bearer'), null)
  }
})

test('owner password proof uses fresh client and revokes its temporary session', async () => {
  const f = fixture()
  assert.equal(await f.deps.reauthenticate('owner-id', 'synthetic-password'), true)
  assert.equal(f.calls[0].login, undefined)
  assert.equal(f.calls[1].key, 'anon')
  assert.deepEqual(f.calls[1].logout, { scope: 'local' })
  assert.equal(await fixture({ logoutError: { message: 'private' } }).deps.reauthenticate('owner-id', 'password'), false)
  assert.equal(await fixture({ profileId: 'other' }).deps.reauthenticate('owner-id', 'password'), false)
})

test('privileged reset passes exact approved identity and no password to SQL', async () => {
  const f = fixture()
  assert.equal(await f.deps.beginReset('owner-id', 'legacy-target', 'operation'), 'target')
  assert.deepEqual(f.calls[0].rpc.args, { p_actor: 'owner-id', p_target_admin: 'legacy-target', p_operation: 'operation' })
  assert.equal(await f.deps.updatePassword('target', 'new-synthetic-password'), true)
  assert.deepEqual(f.calls[0].updated, { id: 'target', fields: { password: 'new-synthetic-password' } })
  assert.equal(await f.deps.finishReset('owner-id', 'legacy-target', 'operation'), true)
  assert.equal(JSON.stringify(f.calls[0].rpc).includes('password"'), false)
})

test('recovery cannot activate in production or against the production project', async () => {
  const valid = { POS_USERNAME_LOGIN_ENABLED: 'true', VERCEL_ENV: 'preview', POS_AUTH_TEST_PROJECT_REF: 'abcdefghijklmnopqrst',
    SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'service',
    POS_LOGIN_HMAC_SECRET: 'x'.repeat(64), POS_APP_ORIGIN: 'https://preview.example.test' }
  for (const [env, status] of [[valid, 405], [{ ...valid, VERCEL_ENV: 'production' }, 503], [{}, 503],
    [{ ...valid, POS_AUTH_TEST_PROJECT_REF: 'ejqfttivgovhqhzkrncx', SUPABASE_URL: 'https://ejqfttivgovhqhzkrncx.supabase.co' }, 503]]) {
    let code
    const res = { setHeader() {}, status(value) { code = value; return this }, json() {} }
    await createPreviewRecoveryHandler(env)({ method: 'GET', headers: {} }, res)
    assert.equal(code, status)
  }
})
