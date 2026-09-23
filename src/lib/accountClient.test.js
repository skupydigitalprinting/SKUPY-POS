import test from 'node:test'
import assert from 'node:assert/strict'
import { createAccountClient, settlePasswordChange } from './accountClient.js'

const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const user = { id: id(3), role: 'owner', authUserId: id(1), authSessionId: id(2) }
const token = sid => `h.${Buffer.from(JSON.stringify({ sub: id(1), session_id: sid })).toString('base64url')}.s`
const account = { id: id(4), username: 'cashier', name: 'Cashier', role: 'staff', active: true, pending: false, version: 1 }
function setup(overrides = {}) {
  const calls = []
  const client = createAccountClient({ currentUser: user, isCurrent: () => true,
    getSession: async () => ({ data: { session: { access_token: token(id(2)) } }, error: null }),
    fetchImpl: async (...args) => { calls.push(args); return { ok: true, json: async () => ({ ok: true, accounts: [account], account, operationId: id(5), reauthenticationRequired: true }) } },
    ...overrides })
  return { client, calls }
}

test('bound account client sends bearer and explicit operation without identity authority', async () => {
  const { client, calls } = setup()
  assert.deepEqual((await client.list()).accounts, [account])
  await client.create({ username: 'cashier', name: 'Cashier', role: 'staff', initialPassword: 'new-password', ownerPassword: 'proof' }, id(5))
  await client.update(account.id, 1, { active: false }, 'proof', id(5))
  assert.equal(calls[0][0], '/api/accounts')
  assert.equal(calls[1][1].headers['Idempotency-Key'], id(5))
  assert.equal(calls[1][1].headers.Authorization, `Bearer ${token(id(2))}`)
  assert.equal(JSON.parse(calls[2][1].body).targetAdminId, account.id)
  assert.equal(calls[1][1].body.includes('authUserId'), false)
  assert.equal(calls[1][1].credentials, 'omit')
})

test('absent binding or guard, old SDK session and missing UUID never dispatch', async () => {
  for (const overrides of [{ currentUser: null }, { currentUser: { ...user, authSessionId: null } }, { isCurrent: undefined },
    { isCurrent: () => false }, { getSession: async () => ({ data: { session: { access_token: token(id(9)) } } }) }]) {
    const { client, calls } = setup(overrides)
    assert.equal((await client.list()).ok, false); assert.equal(calls.length, 0)
  }
  const { client, calls } = setup()
  assert.equal((await client.create({}, 'not-uuid')).ok, false); assert.equal(calls.length, 0)
})

test('response arriving after session switch cannot replace current account state', async () => {
  let sid = id(2)
  const { client } = setup({ getSession: async () => ({ data: { session: { access_token: token(sid) } } }),
    fetchImpl: async () => { sid = id(9); return { ok: true, json: async () => ({ ok: true, accounts: [account] }) } } })
  const result = await client.list()
  assert.equal(result.ok, false); assert.equal(result.stale, true); assert.equal(result.accounts, undefined)
})

test('ambiguous mutation responses retain operation ID and never retry', async () => {
  for (const fetchImpl of [async () => { throw new Error('network') }, async () => ({ ok: true, json: async () => ({ ok: true }) }),
    async () => ({ ok: true, json: async () => ({ ok: true, account, operationId: id(99) }) })]) {
    const { client } = setup({ fetchImpl })
    const result = await client.create({}, id(5))
    assert.equal(result.ok, false); assert.equal(result.uncertain, true); assert.equal(result.operationId, id(5))
  }
})

test('self change requires cleanup on success or ambiguity, never targets a browser supplied identity', async () => {
  const { client, calls } = setup()
  assert.equal((await client.changePassword('old', 'new-password', id(5))).reauthenticationRequired, true)
  assert.equal(calls[0][0], '/api/auth/change-password')
  assert.deepEqual(JSON.parse(calls[0][1].body), { currentPassword: 'old', newPassword: 'new-password' })
  const uncertain = await setup({ fetchImpl: async () => { throw new Error('lost') } }).client.changePassword('old', 'new', id(5))
  assert.equal(uncertain.uncertain, true); assert.equal(uncertain.reauthenticationRequired, true)
  assert.equal(uncertain.locked, undefined)
  const denied = await setup({ fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({ ok: false, error: 'proof failed' }) }) }).client.changePassword('old', 'new', id(5))
  assert.equal(denied.uncertain, undefined); assert.equal(denied.reauthenticationRequired, undefined)
})

test('self cleanup rechecks captured SDK binding and context, never signs out a newer login', async () => {
  for (const switchKind of ['none', 'token', 'context']) {
    let sid = id(2); let current = true; let ended = 0
    const { client } = setup({ isCurrent: () => current,
      getSession: async () => ({ data: { session: { access_token: token(sid) } } }) })
    const result = await client.changePassword('old', 'new', id(5))
    if (switchKind === 'token') sid = id(9)
    if (switchKind === 'context') current = false
    await client.endPasswordSession(result, () => { ended++ })
    assert.equal(ended, switchKind === 'none' ? 1 : 0)
  }
})

test('status accepts matching terminal account or explicit nonterminal state, does not imply safe retry', async () => {
  const result = await setup({ fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true, operationId: id(5), state: 'unknown' }) }) }).client.status(id(5))
  assert.equal(result.state, 'unknown'); assert.equal(result.operationId, id(5))
})

test('dismissal while a password request is pending still cleans the captured session without UI updates', async () => {
  for (const outcome of ['success', 'uncertain']) {
    let release, started
    const dispatched = new Promise(resolve => { started = resolve })
    let mounted = true; let cleanups = 0; let uiUpdates = 0
    const { client } = setup({ fetchImpl: () => { started(); return new Promise(resolve => { release = resolve }) } })
    const pending = settlePasswordChange(client.changePassword('old', 'new-password', id(5)), {
      client, isMounted: () => mounted, onSessionEnd: () => { cleanups++ },
      onResult: () => { uiUpdates++ }, onCleanupError: () => { uiUpdates++ },
    })
    await dispatched
    mounted = false
    release({ ok: outcome === 'success', status: outcome === 'success' ? 200 : 503,
      json: async () => outcome === 'success'
        ? { ok: true, operationId: id(5), reauthenticationRequired: true }
        : { ok: false, operationId: id(5), uncertain: true, reauthenticationRequired: true } })
    const result = await pending
    assert.equal(result.reauthenticationRequired, true)
    assert.equal(cleanups, 1, `${outcome} must clean up even after dismissal`)
    assert.equal(uiUpdates, 0)
  }
})

test('dismissed password response never cleans a newer SDK session or context', async () => {
  for (const switchKind of ['token', 'context']) {
    let release, started
    const dispatched = new Promise(resolve => { started = resolve })
    let mounted = true; let sid = id(2); let current = true; let cleanups = 0; let uiUpdates = 0
    const { client } = setup({ isCurrent: () => current,
      getSession: async () => ({ data: { session: { access_token: token(sid) } } }),
      fetchImpl: () => { started(); return new Promise(resolve => { release = resolve }) } })
    const pending = settlePasswordChange(client.changePassword('old', 'new-password', id(5)), {
      client, isMounted: () => mounted, onSessionEnd: () => { cleanups++ },
      onResult: () => { uiUpdates++ }, onCleanupError: () => { uiUpdates++ },
    })
    await dispatched
    mounted = false
    if (switchKind === 'token') sid = id(9)
    else current = false
    release({ ok: true, json: async () => ({ ok: true, operationId: id(5), reauthenticationRequired: true }) })
    assert.equal((await pending).stale, true)
    assert.equal(cleanups, 0); assert.equal(uiUpdates, 0)
  }
})

test('cleanup errors are contained after dismissal and only update a still-mounted form', async () => {
  for (const mounted of [false, true]) {
    const { client } = setup()
    let cleanups = 0; let results = 0; let errors = 0
    await settlePasswordChange(client.changePassword('old', 'new-password', id(5)), {
      client, isMounted: () => mounted, onSessionEnd: () => { cleanups++; throw new Error('cleanup failed') },
      onResult: () => { results++ }, onCleanupError: () => { errors++ },
    })
    assert.equal(cleanups, 1)
    assert.equal(results, mounted ? 1 : 0); assert.equal(errors, mounted ? 1 : 0)
  }
})
