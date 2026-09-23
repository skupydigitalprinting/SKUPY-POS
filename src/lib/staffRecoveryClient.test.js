import test from 'node:test'
import assert from 'node:assert/strict'
import { createStaffRecoveryClient } from './staffRecoveryClient.js'

test('reset posts credentials only to same-origin authenticated endpoint and returns no tokens', async () => {
  let request
  const reset = createStaffRecoveryClient({ auth: { getSession: async () => ({ data: { session: { access_token: 'synthetic-token' } } }) },
    fetchImpl: async (...args) => { request = args; return { ok: true, json: async () => ({ ok: true }) } } })
  assert.deepEqual(await reset('target', 'owner-password', 'staff-password-new'), { ok: true })
  assert.equal(request[0], '/api/auth/reset-staff-password')
  assert.equal(request[1].headers.Authorization, 'Bearer synthetic-token')
  assert.equal(request[1].cache, 'no-store')
  assert.equal(request[1].redirect, 'error')
})

test('old component cannot send a reset under a newer session', async () => {
  let current = true, sent = false
  const reset = createStaffRecoveryClient({ isCurrent: () => current,
    auth: { getSession: async () => { current = false; return { data: { session: { access_token: 'new-account-token' } } } } },
    fetchImpl: async () => { sent = true } })
  assert.equal((await reset('target', 'owner-password', 'staff-password-new')).ok, false)
  assert.equal(sent, false)
})

test('locked, backend errors and malformed success never masquerade as confirmed reset', async () => {
  for (const [response, locked] of [[{ ok: false, status: 503, json: async () => ({ locked: true, error: 'secret' }) }, true],
    [{ ok: false, status: 403, json: async () => ({ error: 'secret' }) }, false],
    [{ ok: true, json: async () => ({}) }, false]]) {
    const reset = createStaffRecoveryClient({ auth: { getSession: async () => ({ data: { session: { access_token: 'token' } } }) }, fetchImpl: async () => response })
    const result = await reset('target', 'owner-password', 'staff-password-new')
    assert.equal(result.ok, false)
    assert.equal(!!result.locked, locked)
    assert.equal(JSON.stringify(result).includes('secret'), false)
  }
})

test('transport loss or an unreadable response after dispatch reports an uncertain reset', async () => {
  for (const fetchImpl of [
    async () => { throw new Error('timeout with unknown remote outcome') },
    async () => ({ ok: true, json: async () => { throw new Error('truncated body') } }),
    async () => ({ ok: true, json: async () => ({}) }),
    async () => ({ ok: false, status: 502, json: async () => ({}) }),
  ]) {
    const reset = createStaffRecoveryClient({ auth: { getSession: async () => ({ data: { session: { access_token: 'token' } } }) }, fetchImpl })
    const result = await reset('target', 'owner-password', 'staff-password-new')
    assert.equal(result.ok, false)
    assert.equal(result.uncertain, true)
    assert.equal(result.locked, undefined)
  }
})

test('failure before dispatch does not imply that a reset was attempted', async () => {
  let sent = false
  const reset = createStaffRecoveryClient({ auth: { getSession: async () => { throw new Error('storage unavailable') } },
    fetchImpl: async () => { sent = true } })
  const result = await reset('target', 'owner-password', 'staff-password-new')
  assert.equal(sent, false)
  assert.equal(result.ok, false)
  assert.equal(result.uncertain, undefined)
})
