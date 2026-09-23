import test from 'node:test'
import assert from 'node:assert/strict'
import { captureAccountSession } from './accountSession.js'

test('account callbacks end only the session that mounted their forms', async () => {
  let snapshot = { phase: 'ready', epoch: 4 }
  let signouts = 0
  const controller = { getSnapshot: () => snapshot, signOut() { signouts++; snapshot = { phase: 'signedOut', epoch: 5 }; return Promise.resolve() } }
  const auth = { getSession: async () => ({ data: { session: null } }) }
  const bound = captureAccountSession(controller, auth)
  assert.equal(bound.isCurrent(), true)
  const pending = bound.onSessionEnd()
  assert.equal(signouts, 1)
  assert.equal(bound.isCurrent(), false)
  await pending
  snapshot = { phase: 'ready', epoch: 6 }
  await bound.onSessionEnd()
  assert.equal(signouts, 1)
  assert.equal(bound.isCurrent(), false)
  assert.deepEqual(await bound.getSession(), { data: { session: null } })
})
