const VERIFICATION_ERROR = 'Sesi tidak valid atau akun belum mendapat akses POS.'
const CLEANUP_ERROR = 'Keluar akun belum berhasil. Silakan coba lagi.'
const CANCELLED_ERROR = 'Operasi sesi sudah digantikan.'
const failure = (result, fallback) => ({ ok: false, error: typeof result?.error === 'string' && result.error ? result.error : fallback })

function samePrincipal(left, right) {
  return left && right && left.authUserId === right.authUserId && left.authSessionId === right.authSessionId &&
    left.id === right.id && left.role === right.role
}

function verifiedUser(result) {
  const user = result?.user
  return result?.ok === true && user &&
    [user.id, user.authUserId, user.username].every(value => typeof value === 'string' && value.trim()) &&
    ['owner', 'admin', 'staff'].includes(user.role)
}

// Authority comes exclusively from the verified createPosAuth adapter, never storage.
// Operations return adapter-style results; activation/invalidation hooks are synchronous.
export function createAuthSessionController({
  auth, onInvalidate = () => {}, onActivate = () => {},
  clearCredentials = () => {}, choosePersistence = () => {},
}) {
  let snapshot = Object.freeze({ phase: 'checking', user: null, error: null, epoch: 0 })
  let generation = 0
  let cleanupRequired = false
  let pending = Promise.resolve()
  let ownOperations = 0
  let signingOut = false
  let invalidationError = null
  let eventTimer = null
  const listeners = new Set()
  const cancelled = () => failure(null, CANCELLED_ERROR)
  const blocked = () => failure(snapshot, CLEANUP_ERROR)

  function publish(phase, user = null, error = null, epoch = snapshot.epoch) {
    if (snapshot.phase === phase && snapshot.user === user && snapshot.error === error && snapshot.epoch === epoch) return
    snapshot = Object.freeze({ phase, user, error, epoch })
    for (const listener of [...listeners]) listener()
  }

  function invalidate(phase, error = null) {
    try {
      onInvalidate()
      invalidationError = null
    } catch {
      invalidationError = failure(null, CLEANUP_ERROR)
    }
    publish(phase, null, error)
  }

  function enqueue(action) {
    ownOperations++
    const next = pending.then(action, action).finally(() => { ownOperations-- })
    pending = next.catch(() => {})
    return next
  }

  async function cleanup(external = false) {
    let result = { ok: true }
    signingOut = true
    try {
      if (!external) result = await auth.signOut()
    } catch {
      result = failure(null, CLEANUP_ERROR)
    } finally {
      try {
        await clearCredentials()
      } catch {
        result = failure(null, CLEANUP_ERROR)
      } finally {
        signingOut = false
      }
    }
    return invalidationError || (result?.ok === true ? { ok: true } : failure(result, CLEANUP_ERROR))
  }

  function block(result) {
    cleanupRequired = true
    advanceGeneration()
    const error = failure(result, CLEANUP_ERROR)
    invalidate('blocked', error.error)
    return error
  }

  async function finishVerification(result, current) {
    if (current !== generation) {
      // Adapter cleanup can emit SIGNED_OUT before returning its safe denial message.
      // Preserve only that failure; stale completions must never publish or activate.
      return result?.ok === false ? failure(result, VERIFICATION_ERROR) : cancelled()
    }
    if (verifiedUser(result)) {
      const user = Object.freeze({ ...result.user })
      const changed = !samePrincipal(snapshot.user, user)
      if (changed && snapshot.user) invalidate('checking')
      if (current !== generation) return cancelled()
      if (invalidationError) return finishVerification(invalidationError, current)
      const epoch = snapshot.epoch + (changed ? 1 : 0)
      try {
        if (changed) onActivate(user, epoch)
      } catch {
        return finishVerification(failure(null, VERIFICATION_ERROR), current)
      }
      if (current !== generation) return cancelled()
      publish('ready', user, null, epoch)
      return { ok: true, user }
    }

    const denied = failure(result, VERIFICATION_ERROR)
    cleanupRequired = true
    invalidate('signedOut', denied.error)
    const cleaned = await cleanup()
    if (!cleaned.ok) return block(cleaned)
    if (current !== generation) return cancelled()
    cleanupRequired = false
    return denied
  }

  function restore() {
    if (cleanupRequired) return Promise.resolve(blocked())
    if (ownOperations) return pending
    const current = advanceGeneration()
    return enqueue(async () => {
      if (current !== generation) return cancelled()
      if (cleanupRequired) return blocked()
      let result
      try { result = await auth.restore() } catch { result = failure(null, VERIFICATION_ERROR) }
      return finishVerification(result, current)
    })
  }

  function signIn(username, password, remember = false) {
    if (cleanupRequired) return Promise.resolve(blocked())
    const current = advanceGeneration()
    invalidate('checking')
    return enqueue(async () => {
      if (current !== generation) return cancelled()
      if (cleanupRequired) return blocked()
      const cleaned = await cleanup()
      if (!cleaned.ok) return block(cleaned)
      if (current !== generation) return cancelled()
      let result
      try {
        await choosePersistence(Boolean(remember))
        if (current !== generation) return cancelled()
        result = await auth.signInUsername(username, password)
      } catch {
        result = failure(null, VERIFICATION_ERROR)
      }
      return finishVerification(result, current)
    })
  }

  function advanceGeneration() {
    if (eventTimer !== null) clearTimeout(eventTimer)
    eventTimer = null
    return ++generation
  }

  function beginSignOut() {
    const current = advanceGeneration()
    cleanupRequired = true
    invalidate('signedOut')
    return current
  }

  function completeSignOut(current, external = false) {
    return enqueue(async () => {
      const cleaned = await cleanup(external)
      if (!cleaned.ok) return block(cleaned)
      if (current !== generation) return cancelled()
      cleanupRequired = false
      publish('signedOut')
      return cleaned
    })
  }

  function signOut() {
    return completeSignOut(beginSignOut())
  }

  // SDK callbacks must return synchronously; SDK calls run in a later task.
  function handleAuthEvent(event) {
    if (event === 'SIGNED_OUT' || event === 'SIGN_OUT') {
      if (signingOut || cleanupRequired) return
      if (snapshot.phase === 'signedOut' && !ownOperations) {
        // Do not rebroadcast logout between settled tabs, or revive queued sign-in events.
        advanceGeneration()
        return
      }
      const current = beginSignOut()
      eventTimer = setTimeout(() => {
        eventTimer = null
        if (current === generation) void completeSignOut(current, true)
      }, 0)
      return
    }
    if (!['SIGNED_IN', 'TOKEN_REFRESHED', 'USER_UPDATED'].includes(event) ||
        ownOperations || cleanupRequired || eventTimer !== null) return
    const current = generation
    eventTimer = setTimeout(() => {
      eventTimer = null
      if (current === generation && !ownOperations && !cleanupRequired) void restore()
    }, 0)
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(callback) {
      listeners.add(callback)
      return () => listeners.delete(callback)
    },
    restore, signIn, signOut, handleAuthEvent,
  }
}
