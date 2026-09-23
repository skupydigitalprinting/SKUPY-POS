import test from 'node:test'
import assert from 'node:assert/strict'
import { createPosAuth } from './posAuth.js'

const row = { id: 'legacy-admin', auth_user_id: 'auth-user', username: 'kasir', name: 'Kasir Uji', role: 'staff' }

function fixture({ userError = null, signInError = null, rows = [row], rpcError = null } = {}) {
  const calls = []
  const client = {
    auth: {
      signInWithPassword: async (credentials) => { calls.push(['signIn', credentials]); return { error: signInError } },
      getUser: async () => { calls.push(['getUser']); return { data: { user: userError ? null : { id: 'auth-user', user_metadata: { role: 'owner' } } }, error: userError } },
      signOut: async (options) => { calls.push(['signOut', options]); return { error: null } },
    },
    rpc: async (...args) => { calls.push(['rpc', ...args]); return { data: rows, error: rpcError } },
    from: () => { throw new Error('Legacy password table access is forbidden') },
  }
  return { service: createPosAuth(client), calls }
}

test('login uses verified Auth identity and server mapping, never user metadata role', async () => {
  const { service, calls } = fixture()
  const result = await service.signIn('  kasir@example.test ', 'dummy-password')
  assert.deepEqual(result, { ok: true, user: { id: row.id, username: row.username, name: row.name, role: 'staff', authUserId: row.auth_user_id } })
  assert.deepEqual(calls.slice(0, 3), [['signIn', { email: 'kasir@example.test', password: 'dummy-password' }], ['getUser'], ['rpc', 'pos_current_profile']])
})

test('invalid login returns a generic message without backend details', async () => {
  const { service, calls } = fixture({ signInError: { message: 'private backend detail' } })
  const result = await service.signIn('kasir@example.test', 'wrong')
  assert.equal(result.ok, false)
  assert.equal(result.error.includes('private backend detail'), false)
  assert.equal(calls.some(([name]) => name === 'rpc'), false)
})

test('empty credentials do not contact Auth', async () => {
  const { service, calls } = fixture()
  assert.equal((await service.signIn('', '')).ok, false)
  assert.deepEqual(calls, [])
})

test('restore validates identity with server before profile access', async () => {
  const { service, calls } = fixture({ userError: { message: 'expired token' } })
  assert.equal((await service.restore()).ok, false)
  assert.equal(calls.some(([name]) => name === 'rpc'), false)
})

for (const rows of [[], [row, row], [{ ...row, role: 'superadmin' }], [{ ...row, auth_user_id: 'another-user' }], [{ ...row, id: null }]]) {
  test(`missing, ambiguous or invalid profile is denied: ${JSON.stringify(rows)}`, async () => {
    const { service, calls } = fixture({ rows })
    assert.equal((await service.signIn('kasir@example.test', 'dummy-password')).ok, false)
    assert.equal(calls.some(([name]) => name === 'signOut'), true)
  })
}

test('database failure fails closed without exposing server errors', async () => {
  const { service } = fixture({ rpcError: { message: 'private SQL details' } })
  const result = await service.restore()
  assert.equal(result.ok, false)
  assert.equal(result.error.includes('private SQL details'), false)
})

test('unexpected network failure returns failure, never a stale user', async () => {
  const service = createPosAuth({ auth: { getUser: async () => { throw new Error('offline') }, signOut: async () => ({ error: null }) } })
  assert.equal((await service.restore()).ok, false)
})

test('logout requests local session revocation and reports failure', async () => {
  const { service, calls } = fixture()
  assert.deepEqual(await service.signOut(), { ok: true })
  assert.deepEqual(calls, [['signOut', { scope: 'local' }]])
  const failed = createPosAuth({ auth: { signOut: async () => ({ error: new Error('offline') }) } })
  assert.equal((await failed.signOut()).ok, false)
})
