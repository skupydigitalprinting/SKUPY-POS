import test from 'node:test'
import assert from 'node:assert/strict'
import { createAuthSessionController } from './authSessionController.js'
import { createPosAuth } from './posAuth.js'
import { createSessionTransport } from './sessionTransport.js'

const staff = { id: 'profile-1', authUserId: 'auth-1', username: 'kasir', name: 'Kasir', role: 'staff' }
const verified = user => ({ ok: true, user: { ...user } })
const denied = { ok: false, error: 'Access denied' }

function deferred() {
  let resolve
  const promise = new Promise(yes => { resolve = yes })
  return { promise, resolve }
}

const nextTurn = () => new Promise(resolve => setTimeout(resolve, 0))

function setup(overrides = {}) {
  const calls = []
  const auth = {
    restore: async () => verified(staff),
    signInUsername: async (username, password) => {
      calls.push(['login', username, password])
      return verified(staff)
    },
    signOut: async () => { calls.push(['logout']); return { ok: true } },
    ...overrides,
  }
  const controller = createAuthSessionController({
    auth,
    onInvalidate: () => calls.push(['invalidate']),
    onActivate: () => calls.push(['activate']),
    clearCredentials: () => calls.push(['clear']),
    choosePersistence: remember => calls.push(['persist', remember]),
  })
  return { controller, auth, calls }
}

test('startup remains checking with stable snapshots until server verification completes', async () => {
  const gate = deferred()
  const { controller, calls } = setup({ restore: () => gate.promise })
  const initial = controller.getSnapshot()
  assert.deepEqual(initial, { phase: 'checking', user: null, error: null, epoch: 0 })
  assert.equal(controller.getSnapshot(), initial)
  let notifications = 0
  const unsubscribe = controller.subscribe(() => { notifications++ })
  const pending = controller.restore()
  assert.equal(controller.getSnapshot(), initial)
  assert.equal(calls.some(call => call[0] === 'activate'), false)
  gate.resolve(verified(staff))
  assert.equal((await pending).ok, true)
  assert.deepEqual(controller.getSnapshot(), { phase: 'ready', user: staff, error: null, epoch: 1 })
  assert.ok(notifications > 0)
  unsubscribe()
  const before = notifications
  await controller.signOut()
  assert.equal(notifications, before)
  assert.equal(initial.phase, 'checking')
})

test('repeated verified restores preserve epoch and never invalidate the mounted session', async () => {
  const { controller, calls } = setup()
  await controller.restore()
  const before = calls.slice()
  await controller.restore()
  await controller.restore()
  assert.equal(controller.getSnapshot().epoch, 1)
  assert.equal(controller.getSnapshot().phase, 'ready')
  assert.deepEqual(calls, before)
})

test('every verified principal change invalidates before activation', async () => {
  for (const change of [{ role: 'admin' }, { id: 'profile-2' }, { authUserId: 'auth-2' }]) {
    const { controller, auth, calls } = setup()
    await controller.restore()
    calls.length = 0
    const phases = []
    controller.subscribe(() => phases.push(controller.getSnapshot().phase))
    auth.restore = async () => verified({ ...staff, ...change })
    await controller.restore()
    assert.deepEqual(calls, [['invalidate'], ['activate']])
    assert.deepEqual(phases, ['checking', 'ready'])
    assert.equal(controller.getSnapshot().epoch, 2)
  }
})

test('a new verified session ID for the same user invalidates before activation and advances epoch', async () => {
  const { controller, auth, calls } = setup({
    restore: async () => verified({ ...staff, authSessionId: 'session-1' }),
  })
  await controller.restore()
  assert.equal(controller.getSnapshot().epoch, 1)
  calls.length = 0
  const phases = []
  controller.subscribe(() => phases.push(controller.getSnapshot().phase))
  auth.restore = async () => verified({ ...staff, authSessionId: 'session-2' })
  assert.equal((await controller.restore()).ok, true)
  assert.deepEqual(calls, [['invalidate'], ['activate']])
  assert.deepEqual(phases, ['checking', 'ready'])
  assert.equal(controller.getSnapshot().epoch, 2)
  assert.equal(controller.getSnapshot().user.authSessionId, 'session-2')
})

test('token refresh with the same verified session ID preserves epoch and the mounted session', async () => {
  let restores = 0
  const { controller, calls } = setup({ restore: async () => {
    restores++
    return verified({ ...staff, authSessionId: 'session-1' })
  } })
  await controller.restore()
  calls.length = 0
  const phases = []
  controller.subscribe(() => phases.push(controller.getSnapshot().phase))
  controller.handleAuthEvent('TOKEN_REFRESHED')
  await nextTurn()
  assert.equal(restores, 2)
  assert.deepEqual(calls, [])
  assert.deepEqual(phases, ['ready'])
  assert.equal(controller.getSnapshot().epoch, 1)
  assert.equal(controller.getSnapshot().user.authSessionId, 'session-1')
})

test('a login clears the previous session before selecting persistence and verifying', async () => {
  const { controller, calls } = setup()
  await controller.restore()
  calls.length = 0
  const login = controller.signIn('kasir', 'password', true)
  assert.equal(controller.getSnapshot().phase, 'checking')
  assert.equal(controller.getSnapshot().user, null)
  assert.deepEqual(calls, [['invalidate']])
  assert.equal((await login).ok, true)
  assert.deepEqual(calls, [
    ['invalidate'], ['logout'], ['clear'], ['persist', true],
    ['login', 'kasir', 'password'], ['activate'],
  ])
  assert.equal(controller.getSnapshot().epoch, 2)
})

test('a late login cannot activate after immediate logout', async () => {
  const gate = deferred()
  const started = deferred()
  const { controller, calls } = setup({ signInUsername: () => { started.resolve(); return gate.promise } })
  const login = controller.signIn('kasir', 'password')
  await started.promise
  const logout = controller.signOut()
  assert.equal(controller.getSnapshot().phase, 'signedOut')
  assert.equal(controller.getSnapshot().user, null)
  gate.resolve(verified(staff))
  assert.equal((await login).ok, false)
  assert.equal((await logout).ok, true)
  assert.equal(calls.some(call => call[0] === 'activate'), false)
  assert.equal(controller.getSnapshot().phase, 'signedOut')
  assert.deepEqual(calls.at(-1), ['clear'])
})

test('newer login supersedes earlier login completion', async () => {
  const gate = deferred()
  const started = deferred()
  const { controller, auth, calls } = setup({ signInUsername: () => { started.resolve(); return gate.promise } })
  const oldLogin = controller.signIn('old', 'password')
  await started.promise
  auth.signInUsername = async () => verified({ ...staff, id: 'new-profile', authUserId: 'new-auth' })
  const newLogin = controller.signIn('new', 'password')
  gate.resolve(verified(staff))
  assert.equal((await oldLogin).ok, false)
  assert.equal((await newLogin).ok, true)
  assert.equal(controller.getSnapshot().user.id, 'new-profile')
  assert.equal(calls.filter(call => call[0] === 'activate').length, 1)
})

test('failed logout clears tokens and blocks restore/login until explicit cleanup retry succeeds', async () => {
  let tokens = 'stored-token'
  let verifyCalls = 0
  let loginCalls = 0
  let failing = true
  const controller = createAuthSessionController({
    auth: {
      restore: async () => { verifyCalls++; return verified(staff) },
      signInUsername: async () => { loginCalls++; return verified(staff) },
      signOut: async () => { if (failing) throw new Error('SDK failed'); return { ok: true } },
    },
    clearCredentials: () => { tokens = null },
  })
  await controller.restore()
  assert.equal((await controller.signOut()).ok, false)
  assert.equal(tokens, null)
  assert.equal(controller.getSnapshot().phase, 'blocked')
  assert.equal(controller.getSnapshot().user, null)
  assert.equal(typeof controller.getSnapshot().error, 'string')
  assert.equal((await controller.restore()).ok, false)
  assert.equal((await controller.signIn('kasir', 'password')).ok, false)
  assert.equal(verifyCalls, 1)
  assert.equal(loginCalls, 0)
  failing = false
  assert.equal((await controller.signOut()).ok, true)
  assert.equal(controller.getSnapshot().phase, 'signedOut')
  assert.equal((await controller.signIn('kasir', 'password')).ok, true)
})

test('failed restore removes an existing verified session and cleans credentials', async () => {
  const { controller, auth, calls } = setup()
  await controller.restore()
  calls.length = 0
  auth.restore = async () => denied
  assert.equal((await controller.restore()).ok, false)
  assert.deepEqual(controller.getSnapshot(), { phase: 'signedOut', user: null, error: 'Access denied', epoch: 1 })
  assert.deepEqual(calls, [['invalidate'], ['logout'], ['clear']])
})

test('failed login cleans credentials again and never activates', async () => {
  const { controller, calls } = setup({ signInUsername: async () => denied })
  assert.equal((await controller.signIn('kasir', 'wrong')).ok, false)
  assert.equal(controller.getSnapshot().phase, 'signedOut')
  assert.equal(controller.getSnapshot().error, 'Access denied')
  assert.equal(calls.some(call => call[0] === 'activate'), false)
  assert.deepEqual(calls.slice(-2), [['logout'], ['clear']])
})

test('late restore cannot undo logout or a newer login', async () => {
  for (const replacement of ['signOut', 'signIn']) {
    const gate = deferred()
    const started = deferred()
    const { controller } = setup({ restore: () => { started.resolve(); return gate.promise } })
    const old = controller.restore()
    await started.promise
    const next = controller[replacement]('kasir', 'password')
    gate.resolve(verified({ ...staff, role: 'owner' }))
    assert.equal((await old).ok, false)
    await next
    assert.notEqual(controller.getSnapshot().user?.role, 'owner')
  }
})

test('malformed or unverified adapter results cannot authorize a stored-looking profile', async () => {
  for (const result of [
    { ok: false, user: staff }, { user: staff }, { ok: true },
    verified({ ...staff, authUserId: '' }), verified({ ...staff, id: null }),
    verified({ ...staff, role: 'superuser' }),
  ]) {
    const { controller, calls } = setup({ restore: async () => result })
    assert.equal((await controller.restore()).ok, false)
    assert.equal(controller.getSnapshot().phase, 'signedOut')
    assert.equal(controller.getSnapshot().user, null)
    assert.equal(calls.some(call => call[0] === 'activate'), false)
    assert.deepEqual(calls.slice(-2), [['logout'], ['clear']])
  }
})

test('restore during a login joins verification instead of cancelling that login', async () => {
  const gate = deferred()
  const started = deferred()
  let restores = 0
  const { controller } = setup({
    signInUsername: () => { started.resolve(); return gate.promise },
    restore: async () => { restores++; return denied },
  })
  const login = controller.signIn('kasir', 'password')
  await started.promise
  const restore = controller.restore()
  gate.resolve(verified(staff))
  assert.equal((await login).ok, true)
  assert.equal((await restore).ok, true)
  assert.equal(restores, 0)
})

test('SDK revalidation is deferred outside the callback and event bursts coalesce', async () => {
  let locked = false
  let restores = 0
  const { controller } = setup({ restore: async () => {
    assert.equal(locked, false)
    restores++
    return verified(staff)
  } })
  await controller.restore()
  locked = true
  for (let index = 0; index < 30; index++) {
    for (const event of ['SIGNED_IN', 'TOKEN_REFRESHED', 'USER_UPDATED']) {
      assert.equal(controller.handleAuthEvent(event), undefined)
    }
  }
  await Promise.resolve()
  assert.equal(restores, 1)
  locked = false
  await nextTurn()
  assert.equal(restores, 2)
  assert.equal(controller.getSnapshot().epoch, 1)
})

test('events raised by an owned verification do not create a revalidation loop', async () => {
  let restores = 0
  const { controller } = setup({ restore: async () => {
    restores++
    controller.handleAuthEvent('SIGNED_IN')
    controller.handleAuthEvent('TOKEN_REFRESHED')
    controller.handleAuthEvent('USER_UPDATED')
    return verified(staff)
  } })
  await controller.restore()
  await nextTurn()
  await nextTurn()
  assert.equal(restores, 1)
  assert.equal(controller.getSnapshot().phase, 'ready')
})

test('external sign-out immediately disables data, defers SDK cleanup, and ignores its own sign-out events', async () => {
  for (const event of ['SIGNED_OUT', 'SIGN_OUT']) {
    let logouts = 0
    let locked = false
    let clears = 0
    const transport = createSessionTransport(() => new Promise(() => {}))
    const controller = createAuthSessionController({
      auth: {
        restore: async () => verified(staff),
        signOut: async () => {
          assert.equal(locked, false)
          logouts++
          controller.handleAuthEvent('SIGNED_OUT')
          return { ok: true }
        },
      },
      onInvalidate: transport.invalidate,
      onActivate: transport.activate,
      clearCredentials: () => { clears++ },
    })
    await controller.restore()
    const read = assert.rejects(transport.fetch('/rest/v1/orders'), { name: 'AbortError' })
    locked = true
    assert.equal(controller.handleAuthEvent(event), undefined)
    assert.equal(controller.getSnapshot().phase, 'signedOut')
    assert.equal(controller.getSnapshot().user, null)
    await read
    await assert.rejects(transport.fetch('/rest/v1/orders'), { name: 'AbortError' })
    assert.equal(logouts, 0)
    locked = false
    await nextTurn()
    await nextTurn()
    assert.equal(logouts, 1)
    assert.equal(clears, 1)
    assert.equal(controller.getSnapshot().phase, 'signedOut')
  }
})

test('SDK sign-out during a pending login prevents late activation', async () => {
  const gate = deferred()
  const started = deferred()
  const { controller, calls } = setup({ signInUsername: () => { started.resolve(); return gate.promise } })
  const login = controller.signIn('kasir', 'password')
  await started.promise
  controller.handleAuthEvent('SIGNED_OUT')
  assert.equal(controller.getSnapshot().phase, 'signedOut')
  gate.resolve(verified(staff))
  assert.equal((await login).ok, false)
  await nextTurn()
  assert.equal(controller.getSnapshot().phase, 'signedOut')
  assert.equal(calls.some(call => call[0] === 'activate'), false)
  assert.deepEqual(calls.at(-1), ['clear'])
})

test('queued revalidation cannot undo logout and blocked sessions ignore auth events', async () => {
  let restores = 0
  const { controller } = setup({
    restore: async () => { restores++; return verified(staff) },
    signOut: async () => ({ ok: false, error: 'Cleanup failed' }),
  })
  await controller.restore()
  controller.handleAuthEvent('TOKEN_REFRESHED')
  await controller.signOut()
  for (const event of ['SIGNED_IN', 'USER_UPDATED', 'SIGNED_OUT', 'INITIAL_SESSION', 'unknown']) {
    controller.handleAuthEvent(event)
  }
  await nextTurn()
  assert.equal(restores, 1)
  assert.equal(controller.getSnapshot().phase, 'blocked')
})

test('credential cleanup failure blocks login before persistence selection', async () => {
  let logins = 0
  let persistenceCalls = 0
  const controller = createAuthSessionController({
    auth: {
      signOut: async () => ({ ok: true }),
      signInUsername: async () => { logins++; return verified(staff) },
    },
    clearCredentials: () => { throw new Error('storage unavailable') },
    choosePersistence: () => { persistenceCalls++ },
  })
  assert.equal((await controller.signIn('kasir', 'password')).ok, false)
  assert.equal(controller.getSnapshot().phase, 'blocked')
  assert.equal(persistenceCalls, 0)
  assert.equal(logins, 0)
})

test('persistence errors clean up and thrown adapter errors are not exposed', async () => {
  let clears = 0
  const controller = createAuthSessionController({
    auth: { signOut: async () => ({ ok: true }) },
    clearCredentials: () => { clears++ },
    choosePersistence: () => { throw new Error('secret details') },
  })
  assert.equal((await controller.signIn('kasir', 'password')).ok, false)
  assert.equal(controller.getSnapshot().phase, 'signedOut')
  assert.equal(controller.getSnapshot().error.includes('secret'), false)
  assert.equal(clears, 2)
})

test('real serial adapter integration clears tokens installed by a late login after logout', { timeout: 1000 }, async () => {
  const loginResponse = deferred()
  const loginStarted = deferred()
  let tokens = null
  let activations = 0
  let logouts = 0
  const client = {
    auth: {
      signOut: async () => {
        logouts++
        tokens = null
        controller.handleAuthEvent('SIGNED_OUT')
        return { error: null }
      },
      setSession: async session => {
        tokens = session
        controller.handleAuthEvent('SIGNED_IN')
        return { error: null }
      },
      getUser: async () => ({ data: { user: tokens ? { id: staff.authUserId } : null } }),
    },
    rpc: async () => ({ data: [{ ...staff, auth_user_id: staff.authUserId }] }),
  }
  const auth = createPosAuth(client, { fetchImpl: () => { loginStarted.resolve(); return loginResponse.promise } })
  const controller = createAuthSessionController({
    auth, clearCredentials: () => { tokens = null }, onActivate: () => { activations++ },
  })
  const login = controller.signIn('kasir', 'password')
  await loginStarted.promise
  const logout = controller.signOut()
  loginResponse.resolve(new Response(JSON.stringify({ session: { access_token: 'a', refresh_token: 'r' } })))
  await login
  assert.equal((await logout).ok, true)
  await nextTurn()
  assert.equal(tokens, null)
  assert.equal(activations, 0)
  assert.equal(logouts, 2)
  assert.equal(controller.getSnapshot().phase, 'signedOut')
})

test('activation callback failure cannot leave credentials or data access active', async () => {
  let tokens = 'token'
  const transport = createSessionTransport(() => new Response('data'))
  const controller = createAuthSessionController({
    auth: { restore: async () => verified(staff), signOut: async () => ({ ok: true }) },
    onActivate: () => { transport.activate(); throw new Error('bad configuration') },
    onInvalidate: transport.invalidate,
    clearCredentials: () => { tokens = null },
  })
  assert.equal((await controller.restore()).ok, false)
  assert.equal(controller.getSnapshot().phase, 'signedOut')
  assert.equal(controller.getSnapshot().epoch, 0)
  assert.equal(tokens, null)
  await assert.rejects(transport.fetch('/rest/v1/orders'), { name: 'AbortError' })
})

test('a throwing invalidation callback still unmounts and clears credentials, with retry required', async () => {
  let tokens = 'token'
  let broken = true
  const controller = createAuthSessionController({
    auth: { restore: async () => verified(staff), signOut: async () => ({ ok: true }) },
    onInvalidate: () => { if (broken) throw new Error('reset failed') },
    clearCredentials: () => { tokens = null },
  })
  await controller.restore()
  const logout = controller.signOut()
  assert.equal(controller.getSnapshot().user, null)
  assert.equal((await logout).ok, false)
  assert.equal(tokens, null)
  assert.equal(controller.getSnapshot().phase, 'blocked')
  broken = false
  assert.equal((await controller.signOut()).ok, true)
  assert.equal(controller.getSnapshot().phase, 'signedOut')
})

test('role changes cannot activate if the previous data session failed to invalidate', async () => {
  let user = staff
  let activations = 0
  const controller = createAuthSessionController({
    auth: { restore: async () => verified(user), signOut: async () => ({ ok: true }) },
    onActivate: () => { activations++ },
    onInvalidate: () => { throw new Error('reset failed') },
  })
  await controller.restore()
  user = { ...staff, role: 'admin' }
  assert.equal((await controller.restore()).ok, false)
  assert.equal(controller.getSnapshot().phase, 'blocked')
  assert.equal(controller.getSnapshot().user, null)
  assert.equal(activations, 1)
})

test('cross-tab SIGNED_OUT broadcasts stop once both tabs finish cleanup', async () => {
  const deliveries = []
  const logouts = [0, 0]
  const tabs = [0, 1].map(index => createAuthSessionController({
    auth: {
      restore: async () => verified(staff),
      signOut: async () => {
        logouts[index]++
        deliveries.push(1 - index)
        return { ok: true }
      },
    },
  }))
  await Promise.all(tabs.map(tab => tab.restore()))
  await tabs[0].signOut()

  // Deliver broadcasts only after the sender has released its SDK lock.
  for (let round = 0; round < 6 && deliveries.length; round++) {
    for (const index of deliveries.splice(0)) tabs[index].handleAuthEvent('SIGNED_OUT')
    await nextTurn()
  }
  assert.deepEqual(logouts, [1, 1])
  assert.deepEqual(deliveries, [])
  assert.ok(tabs.every(tab => tab.getSnapshot().phase === 'signedOut'))
})

test('redundant external sign-outs preserve the settled signed-out snapshot and error', async () => {
  const { controller, calls } = setup({ restore: async () => denied })
  await controller.restore()
  const snapshot = controller.getSnapshot()
  const before = calls.slice()
  for (const event of ['SIGNED_OUT', 'SIGN_OUT', 'SIGNED_OUT']) controller.handleAuthEvent(event)
  await nextTurn()
  assert.equal(controller.getSnapshot(), snapshot)
  assert.equal(controller.getSnapshot().error, 'Access denied')
  assert.deepEqual(calls, before)
})

test('external sign-out still cleans up from initial checking before restore starts', async () => {
  const { controller, calls } = setup()
  controller.handleAuthEvent('SIGNED_OUT')
  assert.equal(controller.getSnapshot().phase, 'signedOut')
  assert.deepEqual(calls, [['invalidate']])
  await nextTurn()
  assert.deepEqual(calls, [['invalidate'], ['logout'], ['clear']])
})

test('external sign-out cancels pending verification even from a signed-out snapshot', async () => {
  for (const initiallySignedOut of [false, true]) {
    const gate = deferred()
    const started = deferred()
    const { controller, calls } = setup({ restore: () => { started.resolve(); return gate.promise } })
    if (initiallySignedOut) await controller.signOut()
    const restore = controller.restore()
    await started.promise
    controller.handleAuthEvent('SIGNED_OUT')
    assert.equal(controller.getSnapshot().phase, 'signedOut')
    gate.resolve(verified(staff))
    assert.equal((await restore).ok, false)
    await nextTurn()
    assert.equal(controller.getSnapshot().phase, 'signedOut')
    assert.equal(calls.some(call => call[0] === 'activate'), false)
  }
})

test('a redundant sign-out cancels queued sign-in revalidation without rebroadcasting', async () => {
  const { controller, calls } = setup()
  await controller.signOut()
  const before = calls.slice()
  controller.handleAuthEvent('SIGNED_IN')
  controller.handleAuthEvent('SIGNED_OUT')
  await nextTurn()
  assert.deepEqual(calls, before)
  assert.equal(controller.getSnapshot().phase, 'signedOut')
})

test('real adapter 401 preserves credential denial despite its internal SDK sign-out event', async () => {
  let tokens = 'old-token'
  let clears = 0
  let activations = 0
  let logouts = 0
  let requests = 0
  let sessionsSet = 0
  const phases = []
  const client = {
    auth: {
      signOut: async () => {
        logouts++
        controller.handleAuthEvent('SIGNED_OUT')
        return { error: null }
      },
      setSession: async () => { sessionsSet++; return { error: null } },
    },
  }
  const auth = createPosAuth(client, { fetchImpl: async () => {
    requests++
    return new Response(JSON.stringify({ error: 'private server details' }), { status: 401 })
  } })
  const controller = createAuthSessionController({
    auth,
    onActivate: () => { activations++ },
    clearCredentials: () => { tokens = null; clears++ },
  })
  controller.subscribe(() => phases.push(controller.getSnapshot().phase))
  const result = await controller.signIn('missing-user', 'wrong-password')
  await nextTurn()
  assert.deepEqual(result, {
    ok: false, error: 'Login gagal. Periksa username dan password atau coba lagi.',
  })
  assert.equal(requests, 1)
  assert.equal(sessionsSet, 0)
  assert.equal(activations, 0)
  assert.equal(phases.includes('ready'), false)
  assert.equal(tokens, null)
  assert.equal(clears, 2)
  assert.equal(logouts, 3)
  assert.equal(controller.getSnapshot().phase, 'signedOut')
  assert.equal(controller.getSnapshot().user, null)
})

test('a superseded adapter denial returns only failure without changing the newer login snapshot', async () => {
  const oldResult = deferred()
  const oldStarted = deferred()
  const newResult = deferred()
  const newStarted = deferred()
  const { controller } = setup({ signInUsername: username => {
    if (username === 'old') { oldStarted.resolve(); return oldResult.promise }
    newStarted.resolve()
    return newResult.promise
  } })
  const oldLogin = controller.signIn('old', 'password')
  await oldStarted.promise
  const newLogin = controller.signIn('new', 'password')
  const snapshot = controller.getSnapshot()
  oldResult.resolve({ ok: false, user: staff, error: 'Previous login denied' })
  const result = await oldLogin
  await newStarted.promise
  assert.equal(controller.getSnapshot(), snapshot)
  newResult.resolve(verified({ ...staff, id: 'new-profile', authUserId: 'new-auth' }))
  assert.equal((await newLogin).ok, true)
  assert.deepEqual(result, { ok: false, error: 'Previous login denied' })
  assert.equal(controller.getSnapshot().user.id, 'new-profile')
  assert.equal(controller.getSnapshot().error, null)
})
