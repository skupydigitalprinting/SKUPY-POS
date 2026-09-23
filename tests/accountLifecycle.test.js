import test from 'node:test'
import assert from 'node:assert/strict'
import { createAccountLifecycleHandler, createSelfPasswordHandler } from '../server/accountLifecycle.js'
import { createUsernameLoginHandler } from '../server/usernameLogin.js'
import { createPasswordRecoveryHandler } from '../server/passwordRecovery.js'

const uuid = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const actor = { authUserId: uuid(1), authSessionId: uuid(2) }
const account = { id: uuid(3), username: 'cashier', name: 'Cashier', role: 'staff', active: true, pending: false, version: 1 }
const operationId = uuid(4)
const finished = { state: 'finished', operationId, account }
const origin = 'https://preview.example.test'
function setup(overrides = {}, self = false) {
  const calls = []
  const record = (name, result) => async (...args) => { calls.push([name, ...args]); return result }
  const handler = (self ? createSelfPasswordHandler : createAccountLifecycleHandler)({
    enabled: true, allowedOrigin: origin, hmacSecret: 'x'.repeat(64), getClientIp: () => '192.0.2.10',
    consumeAttempt: record('limit', true), verifyOwner: record('owner', actor), verifySelf: record('self', actor),
    reauthenticate: record('proof', true), reauthenticateSelf: record('selfProof', true),
    listAccounts: record('list', [account]), reserveAccount: record('reserve', { state: 'reserved', id: account.id, operationId }),
    claimAccount: record('claim', true), createAuthAccount: record('createAuth', uuid(5)),
    finishAccount: record('finish', finished), updateAccount: record('update', finished),
    accountStatus: record('status', { state: 'auth_started', operationId }),
    beginSelfPassword: record('beginSelf', { state: 'auth_started', dispatch: true, operationId }),
    updatePassword: record('password', true),
    finishSelfPassword: record('finishSelf', { state: 'finished', operationId, reauthenticationRequired: true }),
    selfPasswordStatus: record('selfStatus', { state: 'auth_started', operationId }),
    ...overrides,
  })
  const req = { method: 'POST', headers: { origin, authorization: 'Bearer synthetic-token', 'content-type': 'application/json', 'idempotency-key': operationId },
    body: self ? { currentPassword: 'old-password', newPassword: 'new-strong-password' }
      : { action: 'create', username: 'cashier', name: 'Cashier', role: 'staff', initialPassword: 'new-strong-password', ownerPassword: 'owner-password' } }
  const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v },
    status(n) { this.statusCode = n; return this }, json(body) { this.body = body; return this } }
  return { req, res, calls, run: () => handler(req, res) }
}

test('account creation verifies owner/password, reserves and claims before one Auth write', async () => {
  const f = setup(); await f.run()
  assert.equal(f.res.statusCode, 201)
  assert.deepEqual(f.res.body, { ok: true, operationId, account })
  assert.deepEqual(f.calls.map(c => c[0]), ['limit', 'owner', 'limit', 'proof', 'reserve', 'claim', 'createAuth', 'finish'])
  assert.deepEqual(f.calls.find(c => c[0] === 'createAuth').slice(1), [operationId, 'new-strong-password'])
  const reserve = f.calls.find(c => c[0] === 'reserve')
  assert.deepEqual(reserve[1], actor)
  assert.equal(reserve[2], operationId)
  assert.deepEqual(reserve[3], { username: 'cashier', name: 'Cashier', role: 'staff' })
  assert.match(reserve[4], /^[a-f0-9]{64}$/)
  assert.equal(JSON.stringify(reserve).includes('password'), false)
  assert.equal(JSON.stringify(f.res.body).includes(uuid(5)), false)
})

test('guards reject malformed or privileged fields before any backend work', async () => {
  for (const [change, status] of [
    [f => { f.req.method = 'GET' }, 405], [f => { f.req.headers.origin = 'https://evil.test' }, 403],
    [f => { delete f.req.headers.authorization }, 401], [f => { f.req.headers['content-type'] = 'text/plain' }, 415],
    [f => { delete f.req.headers['idempotency-key'] }, 400], [f => { f.req.body.role = 'owner' }, 400],
    [f => { f.req.body.authUserId = uuid(99) }, 400], [f => { f.req.body.initialPassword = 'short' }, 400],
    [f => { f.req.body.initialPassword = '\u00e9'.repeat(37) }, 400], [f => { f.req.body.name = ' ' }, 400],
  ]) {
    const f = setup(); change(f); await f.run()
    assert.equal(f.res.statusCode, status)
    assert.deepEqual(f.calls, [])
  }
  const disabled = setup({ enabled: false }); await disabled.run()
  assert.equal(disabled.res.statusCode, 503); assert.deepEqual(disabled.calls, [])
})

test('owner proof, current session, rate limit and password failures never dispatch Auth creation', async () => {
  for (const overrides of [{ verifyOwner: async () => null }, { verifyOwner: async () => ({ authUserId: uuid(1) }) },
    { reauthenticate: async () => false }, { consumeAttempt: async () => false }, { getClientIp: () => 'spoofed' }]) {
    const f = setup(overrides); await f.run()
    assert.ok([403, 429, 503].includes(f.res.statusCode))
    assert.equal(f.calls.some(c => c[0] === 'createAuth'), false)
  }
})

test('durable claim failure or replay never repeats an Auth create or adopts an existing account', async () => {
  for (const overrides of [
    { claimAccount: async () => false }, { claimAccount: async () => { throw new Error('lost claim') } },
    { reserveAccount: async () => ({ state: 'auth_started', operationId }) },
    { reserveAccount: async () => { throw new Error('lost reserve') } },
  ]) {
    const f = setup(overrides); await f.run()
    assert.equal(f.res.statusCode, 503); assert.equal(f.res.body.uncertain, true)
    assert.equal(f.calls.some(c => c[0] === 'createAuth'), false)
  }
  const f = setup({ reserveAccount: async () => finished }); await f.run()
  assert.equal(f.res.body.ok, true)
  assert.equal(f.calls.some(c => c[0] === 'createAuth'), false)
})

test('uncertain Auth creation remains pending and never finishes or deletes an identity', async () => {
  for (const createAuthAccount of [async () => null, async () => { throw new Error('private Auth failure') }]) {
    const f = setup({ createAuthAccount }); await f.run()
    assert.equal(f.res.statusCode, 503)
    assert.equal(f.res.body.uncertain, true)
    assert.equal(f.calls.some(c => c[0] === 'finish'), false)
    assert.equal(JSON.stringify(f.res.body).includes('private'), false)
  }
})

test('lost finish is successful only with matching historical completion; nonterminal status stays uncertain', async () => {
  for (const state of ['reserved', 'auth_started', 'unknown', 'finished']) {
    const f = setup({ finishAccount: async () => { throw new Error('lost finish') },
      accountStatus: async () => state === 'finished' ? finished : { state, operationId } })
    await f.run()
    assert.equal(f.res.body.ok, state === 'finished')
    if (state !== 'finished') assert.equal(f.res.body.uncertain, true)
  }
})

test('definite create reservation conflicts never turn another completed payload into success', async () => {
  for (const [change, code, status] of [
    [body => { body.name = 'Different Name' }, '42501', 403],
    [body => { body.initialPassword = 'different-strong-password' }, '42501', 403],
    [body => { body.username = 'different-user' }, '23505', 409],
    [body => { body.role = 'admin' }, '22023', 400],
  ]) {
    const f = setup({ reserveAccount: async () => { throw Object.assign(new Error('reservation conflict'), { code }) },
      accountStatus: async () => { f.calls.push(['status']); return finished } })
    change(f.req.body); await f.run()
    assert.equal(f.res.statusCode, status)
    assert.equal(f.res.body.ok, false)
    assert.equal(f.res.body.account, undefined)
    assert.equal(f.calls.some(c => ['status', 'claim', 'createAuth', 'finish'].includes(c[0])), false)
  }
})

test('unacknowledged mutations cannot reconcile unrelated operation history by UUID alone', async () => {
  const create = setup({ reserveAccount: async () => { throw new Error('lost response') }, accountStatus: async () => finished })
  create.req.body.initialPassword = 'different-strong-password'
  await create.run()
  assert.equal(create.res.statusCode, 503); assert.equal(create.res.body.uncertain, true)
  assert.equal(create.res.body.account, undefined)
  const update = setup({ updateAccount: async () => { throw new Error('lost response') }, accountStatus: async () => finished })
  update.req.body = { action: 'update', targetAdminId: account.id, expectedVersion: 1, patch: { name: 'Different' }, ownerPassword: 'proof' }
  await update.run()
  assert.equal(update.res.statusCode, 503); assert.equal(update.res.body.uncertain, true)
  const self = setup({ beginSelfPassword: async () => { throw Object.assign(new Error('operation exists'), { code: '23505' }) },
    selfPasswordStatus: async () => ({ state: 'finished', operationId, reauthenticationRequired: true }) }, true)
  await self.run()
  assert.equal(self.res.statusCode, 409); assert.equal(self.res.body.ok, false)
})

test('acknowledged creation reconciliation rejects a finished account with a different reserved ID', async () => {
  const f = setup({ finishAccount: async () => { throw new Error('lost finish') },
    accountStatus: async () => ({ ...finished, account: { ...account, id: uuid(99) } }) })
  await f.run()
  assert.equal(f.res.statusCode, 503); assert.equal(f.res.body.uncertain, true)
})

test('login, reset, account and self-password handlers exhaust one shared IP budget', async () => {
  for (const source of ['login', 'reset', 'accounts']) {
    const counts = new Map()
    const consumeAttempt = async keys => {
      if (keys.some((key, i) => (counts.get(key) || 0) >= [1000, 60, 10][i])) return false
      for (const key of keys) counts.set(key, (counts.get(key) || 0) + 1)
      return true
    }
    const common = { enabled: true, allowedOrigin: origin, hmacSecret: 'x'.repeat(64), getClientIp: () => '192.0.2.10', consumeAttempt }
    const login = createUsernameLoginHandler({ ...common, wait: async () => {}, resolveAuthUserId: async () => null,
      getAuthEmail: async () => null, authenticate: async () => null })
    const reset = createPasswordRecoveryHandler({ ...common, verifyOwner: async () => null })
    const oldRequest = (kind, n) => {
      const f = setup()
      f.req.headers.authorization = `Bearer token-${n}`
      f.req.body = kind === 'login' ? { username: `user-${n}`, password: 'wrong' }
        : { targetAdminId: account.id, ownerPassword: 'proof', newPassword: 'new-strong-password' }
      return f
    }
    for (let i = 0; i < 60; i++) {
      if (source === 'accounts') {
        const f = setup({ consumeAttempt }); f.req.body = { action: 'list' }; f.req.headers.authorization = `Bearer token-${i}`
        await f.run(); assert.equal(f.res.statusCode, 200)
      } else {
        const f = oldRequest(source, i); await (source === 'login' ? login : reset)(f.req, f.res)
        assert.equal(f.res.statusCode, source === 'login' ? 401 : 403)
      }
    }
    for (const self of [false, true]) {
      const f = setup({ consumeAttempt }, self); await f.run()
      assert.equal(f.res.statusCode, 429, `${source} must exhaust ${self ? 'self password' : 'accounts'} IP budget`)
      assert.equal(f.calls.some(c => ['owner', 'self', 'proof', 'selfProof', 'createAuth', 'password'].includes(c[0])), false)
    }
    for (const kind of ['login', 'reset']) {
      const f = oldRequest(kind, 99); await (kind === 'login' ? login : reset)(f.req, f.res)
      assert.equal(f.res.statusCode, 429, `${source} must exhaust ${kind} IP budget`)
    }
  }
})

test('versioned updates pass only allowlisted fields and never touch Auth', async () => {
  const f = setup()
  f.req.body = { action: 'update', targetAdminId: account.id, expectedVersion: 1, patch: { name: 'Changed', role: 'admin', active: false }, ownerPassword: 'owner-password' }
  await f.run()
  assert.equal(f.res.statusCode, 200)
  const call = f.calls.find(c => c[0] === 'update')
  assert.deepEqual(call.slice(1, 6), [actor, operationId, account.id, 1, f.req.body.patch])
  assert.equal(f.calls.some(c => c[0] === 'createAuth'), false)
  const stale = setup({ updateAccount: async () => { throw Object.assign(new Error('detail'), { code: '40001' }) } })
  stale.req.body = f.req.body; await stale.run()
  assert.equal(stale.res.statusCode, 409)
})

test('owner directory and status require verified owner but not a password', async () => {
  for (const body of [{ action: 'list' }, { action: 'status', operationId }]) {
    const f = setup(); f.req.body = body; delete f.req.headers['idempotency-key']; await f.run()
    assert.equal(f.res.statusCode, 200)
    assert.equal(f.calls.some(c => c[0] === 'proof'), false)
    assert.equal(f.calls.some(c => c[0] === 'owner'), true)
  }
})

test('self password derives target only from verified caller and finishes after invalidating begin', async () => {
  const f = setup({}, true); await f.run()
  assert.equal(f.res.statusCode, 200)
  assert.equal(f.res.body.reauthenticationRequired, true)
  assert.deepEqual(f.calls.map(c => c[0]), ['limit', 'self', 'limit', 'selfProof', 'beginSelf', 'password', 'finishSelf'])
  assert.deepEqual(f.calls.find(c => c[0] === 'password').slice(1), [actor.authUserId, 'new-strong-password'])
  const forged = setup({}, true); forged.req.body.targetAdminId = account.id; await forged.run()
  assert.equal(forged.res.statusCode, 400); assert.deepEqual(forged.calls, [])
})

test('self password proof failure does not lock; uncertain begin never dispatches another password update', async () => {
  for (const [overrides, status] of [[{ reauthenticateSelf: async () => false }, 403],
    [{ beginSelfPassword: async () => { throw new Error('lost begin') } }, 503],
    [{ beginSelfPassword: async () => ({ dispatch: false }) }, 503]]) {
    const f = setup(overrides, true); await f.run()
    assert.equal(f.res.statusCode, status)
    assert.equal(f.calls.some(c => c[0] === 'password'), false)
  }
})

test('self password uncertain Auth result stays locked, lost finish is reconciled without old-session reauth', async () => {
  const locked = setup({ updatePassword: async () => false }, true); await locked.run()
  assert.equal(locked.res.body.locked, true)
  assert.equal(locked.calls.some(c => c[0] === 'finishSelf'), false)
  const reconciled = setup({ finishSelfPassword: async () => { throw new Error('lost finish') },
    selfPasswordStatus: async () => ({ state: 'finished', operationId, reauthenticationRequired: true }) }, true)
  await reconciled.run()
  assert.equal(reconciled.res.body.ok, true)
  assert.equal(reconciled.calls.filter(c => c[0] === 'selfProof').length, 1)
  const ambiguous = setup({ finishSelfPassword: async () => { throw new Error('lost finish') } }, true)
  await ambiguous.run()
  assert.equal(ambiguous.res.body.uncertain, true)
  assert.equal(ambiguous.res.body.reauthenticationRequired, true)
  assert.equal(ambiguous.res.body.locked, undefined)
})
