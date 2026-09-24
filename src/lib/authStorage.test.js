import test from 'node:test'
import assert from 'node:assert/strict'
import { createAuthStorage, AUTH_STORAGE_KEY } from './authStorage.js'
import { resolveAuthMode } from './authMode.js'

const memory = () => {
  const entries = new Map()
  return { getItem: key => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value), removeItem: key => entries.delete(key) }
}
test('Auth storage defaults to this tab and remember-me moves only new sessions to local storage', () => {
  const local = memory(), session = memory()
  const store = createAuthStorage({ local, session })
  store.setItem(AUTH_STORAGE_KEY, 'session-one')
  assert.equal(local.getItem(AUTH_STORAGE_KEY), null)
  assert.equal(session.getItem(AUTH_STORAGE_KEY), 'session-one')
  store.choosePersistence(true)
  assert.equal(store.getItem(AUTH_STORAGE_KEY), null)
  store.setItem(AUTH_STORAGE_KEY, 'session-two')
  assert.equal(session.getItem(AUTH_STORAGE_KEY), null)
  assert.equal(local.getItem(AUTH_STORAGE_KEY), 'session-two')
  assert.equal(createAuthStorage({ local, session }).getItem(AUTH_STORAGE_KEY), 'session-two')
})
test('clear removes Auth keys and legacy identity from both stores without clearing unrelated preferences', () => {
  const local = memory(), session = memory()
  for (const s of [local, session]) {
    for (const key of [AUTH_STORAGE_KEY, `${AUTH_STORAGE_KEY}-code-verifier`, `${AUTH_STORAGE_KEY}-user`, 'skupy_session_v2', 'skupy_active_book']) s.setItem(key, 'old')
    s.setItem('unrelated', 'keep')
  }
  createAuthStorage({ local, session }).clear()
  for (const s of [local, session]) {
    assert.equal(s.getItem(AUTH_STORAGE_KEY), null)
    assert.equal(s.getItem('skupy_session_v2'), null)
    assert.equal(s.getItem(`${AUTH_STORAGE_KEY}-code-verifier`), null)
    assert.equal(s.getItem('unrelated'), 'keep')
  }
})
test('requested secure mode fails closed for production, invalid configuration and insecure preview', () => {
  const valid = { VITE_POS_AUTH_MODE: 'preview', VITE_POS_AUTH_TEST_PROJECT_REF: 'abcdefghijklmnopqrst', VITE_SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co' }
  assert.equal(resolveAuthMode({}, 'https://pos.skupy.id'), 'legacy')
  assert.equal(resolveAuthMode(valid, 'https://test.vercel.app'), 'secure')
  assert.equal(resolveAuthMode(valid, 'https://pos.skupy.id'), 'blocked')
  assert.equal(resolveAuthMode(valid, 'http://test.vercel.app'), 'blocked')
  assert.equal(resolveAuthMode({ ...valid, VITE_SUPABASE_URL: 'https://ejqfttivgovhqhzkrncx.supabase.co' }, 'https://test.vercel.app'), 'blocked')
  assert.equal(resolveAuthMode({ VITE_POS_AUTH_MODE: 'preview' }, 'https://test.vercel.app'), 'blocked')
  const local = { VITE_POS_AUTH_MODE: 'local', DEV: true, VITE_SUPABASE_URL: 'http://127.0.0.1:54321' }
  assert.equal(resolveAuthMode(local, 'http://127.0.0.1:5182'), 'secure')
  assert.equal(resolveAuthMode({ ...local, DEV: false }, 'http://127.0.0.1:5182'), 'blocked')
  assert.equal(resolveAuthMode(local, 'https://test.vercel.app'), 'blocked')
})

test('production secure mode requires its exact origin, database and production build', () => {
  const valid = { VITE_POS_AUTH_MODE: 'production', PROD: true,
    VITE_SUPABASE_URL: 'https://ejqfttivgovhqhzkrncx.supabase.co', VITE_SUPABASE_ANON_KEY: 'public-key' }
  assert.equal(resolveAuthMode(valid, 'https://pos.skupy.id'), 'secure')
  for (const [env, origin] of [
    [{ ...valid, PROD: false }, 'https://pos.skupy.id'],
    [{ ...valid, VITE_SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co' }, 'https://pos.skupy.id'],
    [{ ...valid, VITE_SUPABASE_ANON_KEY: '' }, 'https://pos.skupy.id'],
    [valid, 'https://preview.example.test'],
    [valid, 'http://pos.skupy.id'],
  ]) assert.equal(resolveAuthMode(env, origin), 'blocked')
})
