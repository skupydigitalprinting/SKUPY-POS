import test from 'node:test'
import assert from 'node:assert/strict'
import { createPosAuth } from './posAuth.js'

function setup({ response, sessionError = null, mapped = true } = {}) {
  const calls = []
  const tokens = { access_token: 'dummy-access', refresh_token: 'dummy-refresh' }
  const client = {
    auth: {
      setSession: async data => { calls.push(['setSession', data]); return { error: sessionError } },
      getUser: async () => { calls.push(['getUser']); return { data: { user: { id: 'auth-id' } } } },
      signOut: async () => { calls.push(['signOut']); return { error: null } },
    },
    rpc: async () => ({ data: mapped ? [{ id: 'admin-id', auth_user_id: 'auth-id', username: 'kasir', name: 'Kasir', role: 'staff' }] : [] }),
  }
  const fetchImpl = async (url, options) => { calls.push(['fetch', url, options]); return response || { ok: true, json: async () => ({ session: tokens }) } }
  return { service: createPosAuth(client, { fetchImpl }), client, calls, tokens }
}

test('username signs in through same-origin server then verifies the resulting session', async () => {
  const { service, calls, tokens } = setup()
  const result = await service.signInUsername(' Kasir ', 'dummy-password')
  assert.equal(result.ok, true); assert.equal(result.user.id, 'admin-id')
  assert.equal(calls[0][1], '/api/auth/login')
  assert.equal(calls[0][2].method, 'POST')
  assert.deepEqual(JSON.parse(calls[0][2].body), { username: 'kasir', password: 'dummy-password' })
  assert.deepEqual(calls[1], ['setSession', tokens]); assert.deepEqual(calls[2], ['getUser'])
  assert.equal(JSON.stringify(result).includes('dummy-access'), false)
})

test('server denial never sets session or echoes private messages', async () => {
  const { service, calls } = setup({ response: { ok: false, status: 401, json: async () => ({ error: 'private-details' }) } })
  const result = await service.signInUsername('kasir', 'wrong')
  assert.equal(result.ok, false); assert.equal(result.error.includes('private-details'), false)
  assert.equal(calls.some(c => c[0] === 'setSession'), false)
})

test('malformed session, SDK errors and disabled mapping are denied', async () => {
  for (const options of [
    { response: { ok: true, json: async () => ({ session: { access_token: 'only-one-token' } }) } },
    { sessionError: { message: 'invalid' } }, { mapped: false },
  ]) {
    const { service, calls } = setup(options)
    assert.equal((await service.signInUsername('kasir', 'password')).ok, false)
    assert.equal(calls.some(c => c[0] === 'signOut'), true)
  }
})

test('empty credentials do not contact endpoint', async () => {
  const { service, calls } = setup()
  assert.equal((await service.signInUsername('', '')).ok, false)
  assert.deepEqual(calls, [])
})

test('queued logout cannot be undone by an earlier pending username login', async () => {
  const { client, calls } = setup()
  let release
  const response = new Promise(resolve => { release = resolve })
  const service = createPosAuth(client, { fetchImpl: () => response })
  const login = service.signInUsername('kasir', 'password')
  const logout = service.signOut()
  release({ ok: true, json: async () => ({ session: { access_token: 'a', refresh_token: 'r' } }) })
  await login; await logout
  assert.equal(calls.at(-1)[0], 'signOut')
})
