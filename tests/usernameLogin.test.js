import test from 'node:test'
import assert from 'node:assert/strict'
import { createUsernameLoginHandler } from '../server/usernameLogin.js'

const origin = 'https://skupy-auth-preview.example.test'
const session = { access_token: 'test-access-token', refresh_token: 'test-refresh-token' }
function setup(overrides = {}) {
  const calls = []
  const options = {
    enabled: true, allowedOrigin: origin, hmacSecret: 'x'.repeat(64),
    wait: async () => {},
    getClientIp: () => '192.0.2.1',
    consumeAttempt: async keys => { calls.push(['limit', keys]); return true },
    resolveAuthUserId: async username => { calls.push(['lookup', username]); return 'auth-test-id' },
    getAuthEmail: async id => { calls.push(['email', id]); return 'private-alias@example.test' },
    authenticate: async (email, password, id) => { calls.push(['auth', email, password, id]); return session },
    ...overrides,
  }
  const handler = createUsernameLoginHandler(options)
  const req = { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: { username: '  KaSiR ', password: 'synthetic-password' } }
  const res = { headers: {}, statusCode: 200, body: null, setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this }, status(s) { this.statusCode = s; return this }, json(body) { this.body = body; return this } }
  return { calls, options, req, res, run: () => handler(req, res) }
}

test('username login consumes shared limits before private lookup and returns tokens only', async () => {
  const f = setup(); await f.run()
  assert.equal(f.res.statusCode, 200)
  assert.deepEqual(f.res.body, { session })
  assert.deepEqual(f.calls.map(c => c[0]), ['limit', 'lookup', 'email', 'auth'])
  assert.equal(f.calls[1][1], 'kasir')
  assert.deepEqual(f.calls[3], ['auth', 'private-alias@example.test', 'synthetic-password', 'auth-test-id'])
  assert.equal(f.res.headers['cache-control'], 'no-store')
  const keys = f.calls[0][1]
  assert.equal(keys[0], 'global')
  assert.match(keys[1], /^ip:[a-f0-9]{64}$/)
  assert.match(keys[2], /^user:[a-f0-9]{64}$/)
  assert.equal(JSON.stringify(keys).includes('192.0.2.1'), false)
  assert.equal(JSON.stringify(keys).includes('kasir'), false)
})

test('disabled endpoint performs no backend calls', async () => {
  const f = setup({ enabled: false }); await f.run()
  assert.equal(f.res.statusCode, 503); assert.deepEqual(f.calls, [])
})

test('cross-origin requests are rejected before lookup', async () => {
  const f = setup(); f.req.headers.origin = 'https://attacker.example'; await f.run()
  assert.equal(f.res.statusCode, 403); assert.deepEqual(f.calls, [])
})

test('GET and non-JSON are rejected', async () => {
  for (const change of [f => { f.req.method = 'GET' }, f => { f.req.headers['content-type'] = 'text/plain' }]) {
    const f = setup(); change(f); await f.run()
    assert.ok([405, 415].includes(f.res.statusCode)); assert.deepEqual(f.calls, [])
  }
})

test('missing origin and invalid input fail without processing credentials', async () => {
  for (const body of [null, {}, { username: 'bad name', password: 'x' }, { username: 'a'.repeat(65), password: 'x' }, { username: 'kasir', password: 'x'.repeat(1025) }]) {
    const f = setup(); f.req.body = body; await f.run()
    assert.equal(f.res.statusCode, 400); assert.deepEqual(f.calls, [])
  }
  const f = setup(); delete f.req.headers.origin; await f.run()
  assert.equal(f.res.statusCode, 403)
})

test('rate limit exhaustion stops even unknown users before lookup', async () => {
  const f = setup({ consumeAttempt: async () => false }); await f.run()
  assert.equal(f.res.statusCode, 429); assert.deepEqual(f.calls, [])
  assert.equal(f.res.headers['retry-after'], '900')
})

test('unknown username and wrong password have the same public failure', async () => {
  const unknown = setup({ resolveAuthUserId: async () => null })
  const wrong = setup({ authenticate: async () => null })
  await unknown.run(); await wrong.run()
  assert.equal(unknown.res.statusCode, 401); assert.equal(wrong.res.statusCode, 401)
  assert.deepEqual(unknown.res.body, wrong.res.body)
  assert.equal(JSON.stringify(wrong.res.body).includes('private-alias'), false)
})

test('missing identity email follows dummy Auth verification without a password-table fallback', async () => {
  const f = setup({ getAuthEmail: async () => null }); await f.run()
  assert.equal(f.res.statusCode, 401)
  assert.equal(f.calls.some(c => c[0] === 'auth'), true)
})

test('unknown usernames still do directory and Auth work and failures have a time floor', async () => {
  const waits = []
  const f = setup({ resolveAuthUserId: async () => null, getAuthEmail: async () => null, wait: async ms => waits.push(ms) })
  await f.run()
  assert.equal(f.res.statusCode, 401)
  assert.equal(f.calls.some(c => c[0] === 'auth'), true)
  assert.ok(waits[0] > 1000)
})

test('backend failure fails closed and never returns error details', async () => {
  const f = setup({ consumeAttempt: async () => { throw new Error('private-service-key') } }); await f.run()
  assert.equal(f.res.statusCode, 503)
  assert.equal(JSON.stringify(f.res.body).includes('private-service-key'), false)
  assert.deepEqual(f.calls, [])
})

test('invalid client IP or missing HMAC configuration fail closed', async () => {
  for (const override of [{ getClientIp: () => '' }, { getClientIp: () => '192.0.2.1, fake' }, { hmacSecret: '' }]) {
    const f = setup(override); await f.run()
    assert.equal(f.res.statusCode, 503); assert.deepEqual(f.calls, [])
  }
})

test('only token fields leave the endpoint', async () => {
  const f = setup({ authenticate: async () => ({ ...session, user: { email: 'private-alias' }, extra: 'private' }) }); await f.run()
  assert.deepEqual(f.res.body, { session })
})
