import test from 'node:test'
import assert from 'node:assert/strict'
import { createPosAuth } from './posAuth.js'

const id = '10000000-0000-4000-8000-000000000001'
const sid = '20000000-0000-4000-8000-000000000001'
const other = '20000000-0000-4000-8000-000000000002'
const token = session => `header.${Buffer.from(JSON.stringify({ sub: id, session_id: session })).toString('base64url')}.signature`
test('bound Auth restore verifies the exact bearer and returns its session identity', async () => {
  let verifiedToken
  const auth = createPosAuth({ auth: {
    getSession: async () => ({ data: { session: { access_token: token(sid) } } }),
    getUser: async bearer => { verifiedToken = bearer; return { data: { user: { id } } } },
  }, rpc: async () => ({ data: [{ id: 'legacy-id', username: 'owner', name: 'Owner', role: 'owner', auth_user_id: id }] }) }, { bindSession: true })
  const result = await auth.restore()
  assert.equal(result.ok, true)
  assert.equal(result.user.authSessionId, sid)
  assert.equal(verifiedToken, token(sid))
})
test('account/session change during profile verification is denied', async () => {
  let reads = 0
  const auth = createPosAuth({ auth: {
    getSession: async () => ({ data: { session: { access_token: token(reads++ ? other : sid) } } }),
    getUser: async () => ({ data: { user: { id } } }),
  }, rpc: async () => ({ data: [{ id: 'legacy-id', username: 'owner', role: 'owner', auth_user_id: id }] }) }, { bindSession: true })
  assert.equal((await auth.restore()).ok, false)
})
