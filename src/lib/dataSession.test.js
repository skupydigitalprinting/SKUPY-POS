import test from 'node:test'
import assert from 'node:assert/strict'
import { createDataSession } from './dataSession.js'
const firstUser = { authUserId: '10000000-0000-4000-8000-000000000001', authSessionId: '20000000-0000-4000-8000-000000000001' }
const nextUser = { authUserId: '10000000-0000-4000-8000-000000000002', authSessionId: '20000000-0000-4000-8000-000000000002' }
const tokenFor = user => `header.${Buffer.from(JSON.stringify({ sub: user.authUserId, session_id: user.authSessionId })).toString('base64url')}.signature`

test('old business client cannot issue follow-up requests under the next account', async () => {
  let token = tokenFor(firstUser)
  const calls = []
  const primary = { auth: { getSession: async () => ({ data: { session: { access_token: token } } }) },
    channel: name => ({ name }), removeChannel() {}, removeAllChannels() {} }
  const transport = { activate() {}, invalidate() {}, fetch: async (input, init) => { calls.push(init.headers.get('Authorization')); return new Response('{}') } }
  const session = createDataSession({ primary, transport, url: 'https://test.supabase.co', key: 'anon',
    factory: (url, key, options) => ({ from: () => options.global.fetch(url + '/rest/v1/test', {}), rpc() {}, storage: {} }) })
  session.activate(firstUser)
  const first = session.getClient()
  await first.from('test')
  session.invalidate()
  token = tokenFor(nextUser)
  session.activate(nextUser)
  await assert.rejects(first.from('test'), { name: 'AbortError' })
  await session.getClient().from('test')
  assert.deepEqual(calls, [`Bearer ${tokenFor(firstUser)}`, `Bearer ${tokenFor(nextUser)}`])
})

test('data client fails closed before login and when token is absent', async () => {
  let calls = 0
  const session = createDataSession({ primary: { auth: { getSession: async () => ({ data: { session: null } }) } },
    url: 'https://test.supabase.co', key: 'anon',
    transport: { activate() {}, invalidate() {}, fetch: async () => { calls++; return new Response('{}') } },
    factory: (url, key, options) => ({ from: () => options.global.fetch(url + '/rest/v1/test', {}), rpc() {}, storage: {} }) })
  await assert.rejects(session.getClient().from('test'), { name: 'AbortError' })
  session.activate(firstUser)
  await assert.rejects(session.getClient().from('test'), { name: 'AbortError' })
  assert.equal(calls, 0)
})

test('token switch before revalidation cannot authorize the old UI as the next account', async () => {
  let token = tokenFor(firstUser), requests = 0
  const session = createDataSession({ primary: { auth: { getSession: async () => ({ data: { session: { access_token: token } } }) } },
    url: 'https://test.supabase.co', key: 'anon',
    transport: { activate() {}, invalidate() {}, fetch: async () => { requests++; return new Response('{}') } },
    factory: (url, key, options) => ({ from: () => options.global.fetch(url + '/rest/v1/test', { method: 'POST' }), rpc() {}, storage: {} }) })
  session.activate(firstUser)
  const oldUi = session.getClient()
  await oldUi.from('test')
  token = tokenFor(nextUser)
  await assert.rejects(oldUi.from('test'), { name: 'AbortError' })
  token = tokenFor({ ...firstUser, authSessionId: nextUser.authSessionId })
  await assert.rejects(oldUi.from('test'), { name: 'AbortError' })
  assert.equal(requests, 1)
})
