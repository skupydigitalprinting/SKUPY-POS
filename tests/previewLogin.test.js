import test from 'node:test'
import assert from 'node:assert/strict'
import { createPreviewLoginHandler, createSupabaseLoginDependencies } from '../server/supabaseUsername.js'

const res = () => ({ code: 0, setHeader() {}, status(code) { this.code = code; return this }, json(body) { this.body = body; return this } })
const previewEnv = {
  POS_USERNAME_LOGIN_ENABLED: 'true', VERCEL_ENV: 'preview',
  POS_AUTH_TEST_PROJECT_REF: 'abcdefghijklmnopqrst',
  SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co',
  SUPABASE_ANON_KEY: 'dummy', SUPABASE_SERVICE_ROLE_KEY: 'dummy',
  POS_LOGIN_HMAC_SECRET: 'x'.repeat(64), POS_APP_ORIGIN: 'https://preview.example.test',
}

test('valid preview activates request validation without contacting the backend', async () => {
  const response = res()
  await createPreviewLoginHandler(previewEnv)({ method: 'GET', headers: {} }, response)
  assert.equal(response.code, 405)
})

test('preview origin, project URL and HMAC must all be explicitly valid', async () => {
  for (const patch of [
    { POS_APP_ORIGIN: 'https://pos.skupy.id' }, { POS_APP_ORIGIN: 'http://preview.example.test' },
    { POS_APP_ORIGIN: 'https://preview.example.test/path' }, { POS_APP_ORIGIN: 'https://user:pass@preview.example.test' },
    { SUPABASE_URL: 'https://other.supabase.co' }, { POS_LOGIN_HMAC_SECRET: 'short' },
    { SUPABASE_SERVICE_ROLE_KEY: '' },
  ]) {
    const response = res()
    await createPreviewLoginHandler({ ...previewEnv, ...patch })({ method: 'GET', headers: {} }, response)
    assert.equal(response.code, 503)
  }
})
test('production and unconfigured deployments cannot enable username login', async () => {
  for (const env of [{}, { POS_USERNAME_LOGIN_ENABLED: 'true', VERCEL_ENV: 'production' }, { POS_USERNAME_LOGIN_ENABLED: 'true', VERCEL_ENV: 'preview' }]) {
    const response = res()
    await createPreviewLoginHandler(env)({ method: 'POST', headers: {} }, response)
    assert.equal(response.code, 503)
  }
})

test('production login enables only for the exact configured SKUPY origin and database', async () => {
  const valid = { ...previewEnv, VERCEL_ENV: 'production', POS_AUTH_TEST_PROJECT_REF: undefined,
    SUPABASE_URL: 'https://ejqfttivgovhqhzkrncx.supabase.co', POS_APP_ORIGIN: 'https://pos.skupy.id' }
  const response = res()
  await createPreviewLoginHandler(valid)({ method: 'GET', headers: {} }, response)
  assert.equal(response.code, 405)
  for (const patch of [
    { POS_APP_ORIGIN: 'https://preview.example.test' },
    { SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co' },
    { VERCEL_ENV: 'preview' },
    { POS_USERNAME_LOGIN_ENABLED: undefined },
    { SUPABASE_SERVICE_ROLE_KEY: '' },
  ]) {
    const rejected = res()
    await createPreviewLoginHandler({ ...valid, ...patch })({ method: 'GET', headers: {} }, rejected)
    assert.equal(rejected.code, 503)
  }
})

test('production Supabase target is rejected even in preview', async () => {
  const response = res()
  await createPreviewLoginHandler({
    POS_USERNAME_LOGIN_ENABLED: 'true', VERCEL_ENV: 'preview',
    POS_AUTH_TEST_PROJECT_REF: 'ejqfttivgovhqhzkrncx',
    SUPABASE_URL: 'https://ejqfttivgovhqhzkrncx.supabase.co',
    SUPABASE_ANON_KEY: 'dummy', SUPABASE_SERVICE_ROLE_KEY: 'dummy',
    POS_LOGIN_HMAC_SECRET: 'x'.repeat(64), POS_APP_ORIGIN: 'https://preview.example.test',
  })({ method: 'POST', headers: {} }, response)
  assert.equal(response.code, 503)
})

function sdkFixture({ authId = 'mapped-id', profile = true, passwordError = false } = {}) {
  const created = []
  const createClient = (_url, key, options) => {
    created.push({ key, options })
    if (key === 'service') return {
      rpc: async (name) => name === 'pos_consume_login_attempt' ? { data: true } : { data: [{ auth_user_id: 'mapped-id' }] },
      auth: { admin: { getUserById: async () => ({ data: { user: { email: 'internal@example.test' } } }) } },
    }
    return {
      auth: {
        signInWithPassword: async () => ({ error: passwordError ? { message: 'wrong' } : null, data: { session: { access_token: 'a', refresh_token: 'r' } } }),
        getUser: async () => ({ data: { user: { id: authId } } }),
        signOut: async () => ({ error: null }),
      },
      rpc: async () => ({ data: profile ? [{ auth_user_id: authId, id: 'legacy', role: 'staff' }] : [] }),
    }
  }
  const deps = createSupabaseLoginDependencies({ url: 'http://127.0.0.1:54321', anonKey: 'anon', serviceKey: 'service' }, createClient)
  return { deps, created }
}

test('each password verification uses its own unprivileged Auth client', async () => {
  const { deps, created } = sdkFixture()
  assert.equal(await deps.resolveAuthUserId('kasir'), 'mapped-id')
  assert.equal(await deps.getAuthEmail('mapped-id'), 'internal@example.test')
  assert.deepEqual(await deps.authenticate('internal@example.test', 'dummy', 'mapped-id'), { access_token: 'a', refresh_token: 'r' })
  await deps.authenticate('internal@example.test', 'dummy', 'mapped-id')
  assert.deepEqual(created.map(c => c.key), ['service', 'anon', 'anon'])
  assert.ok(created.every(c => c.options.auth.persistSession === false && c.options.auth.autoRefreshToken === false))
})

test('mismatched Auth identity, missing mapping and invalid passwords are denied', async () => {
  for (const options of [{ authId: 'another-user' }, { profile: false }, { passwordError: true }]) {
    const { deps } = sdkFixture(options)
    assert.equal(await deps.authenticate('internal@example.test', 'dummy', 'mapped-id'), null)
  }
})
