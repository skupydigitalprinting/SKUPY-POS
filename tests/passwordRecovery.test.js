import test from 'node:test'
import assert from 'node:assert/strict'
import { createPasswordRecoveryHandler } from '../server/passwordRecovery.js'

const origin = 'https://preview.example.test'
const target = '20000000-0000-4000-8000-000000000002'
function setup(overrides = {}) {
  const calls = []
  const handler = createPasswordRecoveryHandler({
    enabled: true, allowedOrigin: origin, hmacSecret: 'x'.repeat(64),
    getClientIp: () => '192.0.2.5',
    consumeAttempt: async keys => { calls.push(['limit', keys]); return true },
    verifyOwner: async token => { calls.push(['owner', token]); return { authUserId: 'owner-auth' } },
    reauthenticate: async (...args) => { calls.push(['reauth', ...args]); return true },
    beginReset: async (...args) => { calls.push(['begin', ...args]); return 'target-auth' },
    updatePassword: async (...args) => { calls.push(['password', ...args]); return true },
    finishReset: async (...args) => { calls.push(['finish', ...args]); return true },
    getResetStatus: async () => ({ state: 'pending', authUserId: 'target-auth' }),
    ...overrides,
  })
  const req = { method: 'POST', headers: { origin, 'content-type': 'application/json', authorization: 'Bearer synthetic-token' },
    body: { targetAdminId: target, ownerPassword: 'owner-test-password', newPassword: 'staff-test-password' } }
  const res = { headers: {}, statusCode: 200, body: null,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this },
    status(s) { this.statusCode = s; return this }, json(v) { this.body = v; return this } }
  return { req, res, calls, run: () => handler(req, res) }
}

test('reset requires owner and password verification before locking and updating staff', async () => {
  const f = setup(); await f.run()
  assert.equal(f.res.statusCode, 200)
  assert.deepEqual(f.res.body, { ok: true })
  assert.deepEqual(f.calls.map(x => x[0]), ['limit', 'owner', 'reauth', 'begin', 'password', 'finish'])
  assert.equal(f.calls[2][1], 'owner-auth')
  assert.equal(f.calls[2][2], f.req.body.ownerPassword)
  assert.equal(f.calls[3][2], target)
  assert.match(f.calls[3][3], /^[a-f0-9-]{36}$/)
  assert.deepEqual(f.calls[5].slice(1), f.calls[3].slice(1))
  assert.equal(f.res.headers['cache-control'], 'no-store')
  assert.equal(JSON.stringify(f.calls[0]).includes('synthetic-token'), false)
})

test('disabled, malformed, cross-origin and unauthenticated reset do no backend work', async () => {
  for (const [change, code] of [
    [f => { f.req.method = 'GET' }, 405],
    [f => { f.req.headers.origin = 'https://attacker.test' }, 403],
    [f => { f.req.headers['content-type'] = 'text/plain' }, 415],
    [f => { delete f.req.headers.authorization }, 401],
    [f => { f.req.body.targetAdminId = 'bad-id' }, 400],
    [f => { f.req.body.newPassword = 'short' }, 400],
    [f => { f.req.body.newPassword = 'x'.repeat(129) }, 400],
    [f => { f.req.body.newPassword = 'x'.repeat(73) }, 400],
    [f => { f.req.body.newPassword = '\u00e9'.repeat(37) }, 400],
    [f => { f.req.body.newPassword = f.req.body.ownerPassword }, 400],
  ]) {
    const f = setup(); change(f); await f.run()
    assert.equal(f.res.statusCode, code); assert.deepEqual(f.calls, [])
  }
  const f = setup({ enabled: false }); await f.run()
  assert.equal(f.res.statusCode, 503); assert.deepEqual(f.calls, [])
})

test('staff session, wrong owner password and unavailable target never change Auth password', async () => {
  for (const override of [
    { verifyOwner: async () => null }, { reauthenticate: async () => false },
    { beginReset: async () => null },
  ]) {
    const f = setup(override); await f.run()
    assert.ok([403, 409].includes(f.res.statusCode))
    assert.equal(f.calls.some(x => x[0] === 'password'), false)
  }
})

test('failed or ambiguous Auth update never unlocks target or claims success', async () => {
  for (const updatePassword of [async () => false, async () => { throw new Error('secret service credentials') }]) {
    const f = setup({ updatePassword }); await f.run()
    assert.equal(f.res.statusCode, 503)
    assert.equal(f.calls.some(x => x[0] === 'finish'), false)
    assert.equal(f.res.body.locked, true)
    assert.equal(JSON.stringify(f.res.body).includes('secret'), false)
  }
})

test('unconfirmed completion is uncertain, not a definite lock or success', async () => {
  const f = setup({ finishReset: async () => false }); await f.run()
  assert.equal(f.res.statusCode, 503); assert.equal(f.res.body.uncertain, true)
  assert.equal(f.res.body.locked, undefined)
})

test('rate limits and invalid server IP settings fail before privileged operations', async () => {
  const f = setup({ consumeAttempt: async () => false }); await f.run()
  assert.equal(f.res.statusCode, 429); assert.deepEqual(f.calls, [])
  const bad = setup({ getClientIp: () => 'spoofed' }); await bad.run()
  assert.equal(bad.res.statusCode, 503); assert.deepEqual(bad.calls, [])
})

test('lost begin response is reconciled before updating Auth', async () => {
  const f = setup({ beginReset: async () => { throw new Error('response lost after commit') },
    getResetStatus: async () => ({ state: 'pending', authUserId: 'target-auth' }) })
  await f.run()
  assert.equal(f.res.statusCode, 200)
  assert.equal(f.calls.some(x => x[0] === 'password'), true)
})

test('lost finish response only reports success when audit confirms completion', async () => {
  const f = setup({ finishReset: async () => { throw new Error('response lost after commit') },
    getResetStatus: async () => ({ state: 'finished', authUserId: 'target-auth' }) })
  await f.run()
  assert.equal(f.res.statusCode, 200)
  assert.deepEqual(f.res.body, { ok: true })
})

test('unavailable reconciliation reports unknown outcome, not a definite lock', async () => {
  const f = setup({ finishReset: async () => false, getResetStatus: async () => { throw new Error('offline') } })
  await f.run()
  assert.equal(f.res.statusCode, 503)
  assert.equal(f.res.body.uncertain, true)
  assert.equal(f.res.body.locked, undefined)
})

test('a delayed begin can still commit after a not-started status snapshot', async () => {
  let state = 'not_started', commit
  const f = setup({
    beginReset: async () => { commit = () => { state = 'pending' }; throw new Error('transport ended before remote execution') },
    getResetStatus: async () => ({ state }),
  })
  await f.run()
  commit()
  assert.equal(state, 'pending')
  assert.equal(f.res.statusCode, 503)
  assert.equal(f.res.body.uncertain, true)
  assert.equal(f.calls.some(x => x[0] === 'password'), false)
})

test('a delayed finish can still commit after a pending status snapshot', async () => {
  let state = 'pending', commit
  const f = setup({
    finishReset: async () => { commit = () => { state = 'finished' }; throw new Error('transport ended before remote execution') },
    getResetStatus: async () => ({ state, authUserId: 'target-auth' }),
  })
  await f.run()
  commit()
  assert.equal(state, 'finished')
  assert.equal(f.res.statusCode, 503)
  assert.equal(f.res.body.uncertain, true)
  assert.equal(f.res.body.locked, undefined)
})
