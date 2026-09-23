import { sessionBinding } from './sessionBinding.js'

const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)
const account = a => a && uuid(a.id) && typeof a.username === 'string' && typeof a.name === 'string' &&
  ['staff', 'admin'].includes(a.role) && typeof a.active === 'boolean' && typeof a.pending === 'boolean' &&
  Number.isInteger(a.version) && a.version >= 0
const cleanAccount = a => ({ id: a.id, username: a.username, name: a.name, role: a.role,
  active: a.active, pending: a.pending, version: a.version,
  ...(uuid(a.operationId) ? { operationId: a.operationId } : {}) })

export async function settlePasswordChange(pendingResult, { client, onSessionEnd, isMounted, onResult, onCleanupError }) {
  const result = await pendingResult
  if (isMounted()) onResult(result)
  // Dismissing the form does not cancel a server-side password change or its cleanup.
  if (result.reauthenticationRequired) {
    try { await client.endPasswordSession(result, onSessionEnd) }
    catch { if (isMounted()) onCleanupError() }
  }
  return result
}

export function createAccountClient({ currentUser, getSession, fetchImpl = globalThis.fetch, isCurrent = () => false } = {}) {
  // Capture values, not a mutable profile object. SDK token claims are routing checks only.
  const authUserId = currentUser?.authUserId
  const authSessionId = currentUser?.authSessionId
  const tokenForCurrent = async () => {
    if (!uuid(authUserId) || !uuid(authSessionId) || !isCurrent()) return null
    const result = await getSession()
    const token = result?.data?.session?.access_token
    const binding = sessionBinding(token)
    return !result?.error && isCurrent() && binding?.authUserId === authUserId &&
      binding.authSessionId === authSessionId ? token : null
  }
  async function request(body, operationId, self = false) {
    const mutation = self || ['create', 'update'].includes(body.action)
    let dispatched = false
    const failure = (extra = {}) => ({ ok: false, error: 'Permintaan akun tidak dapat diproses.',
      ...(operationId ? { operationId } : {}), ...extra })
    const uncertain = extra => failure({ uncertain: true,
      ...(self ? { reauthenticationRequired: true } : {}), ...extra })
    if ((mutation || body.action === 'status') && !uuid(operationId)) return failure()
    try {
      const token = await tokenForCurrent()
      if (!token) return failure({ stale: true })
      const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
      if (mutation) headers['Idempotency-Key'] = operationId
      dispatched = true
      const response = await fetchImpl(self ? '/api/auth/change-password' : '/api/accounts', {
        method: 'POST', headers, body: JSON.stringify(body), credentials: 'omit', cache: 'no-store',
      })
      const data = await response.json()
      if (!await tokenForCurrent()) return mutation ? uncertain({ stale: true }) : failure({ stale: true })
      if (!response.ok || data?.ok !== true) {
        if (mutation && (data?.uncertain || data?.locked || ![400, 401, 403, 409, 413, 415, 429].includes(response.status))) return uncertain()
        return failure({ ...(response.status === 409 ? { conflict: true } : {}) })
      }
      if (body.action === 'list') {
        return Array.isArray(data.accounts) && data.accounts.every(account)
          ? { ok: true, accounts: data.accounts.map(cleanAccount) } : failure()
      }
      if (data.operationId !== operationId) return mutation ? uncertain() : failure()
      if (self) return data.reauthenticationRequired === true ? { ok: true, operationId, reauthenticationRequired: true } : uncertain()
      if (account(data.account) && (body.action !== 'update' || data.account.id === body.targetAdminId)) {
        return { ok: true, operationId, account: cleanAccount(data.account) }
      }
      if (body.action === 'status' && ['reserved', 'auth_started', 'unknown'].includes(data.state)) return { ok: true, operationId, state: data.state }
      return mutation ? uncertain() : failure()
    } catch {
      return dispatched && mutation ? uncertain() : failure()
    }
  }
  return {
    list: () => request({ action: 'list' }),
    status: operationId => request({ action: 'status', operationId }, operationId),
    create: (fields, operationId) => request({ action: 'create', username: fields.username, name: fields.name,
      role: fields.role, initialPassword: fields.initialPassword, ownerPassword: fields.ownerPassword }, operationId),
    update: (targetAdminId, expectedVersion, patch, ownerPassword, operationId) => request({
      action: 'update', targetAdminId, expectedVersion, patch, ownerPassword,
    }, operationId),
    changePassword: (currentPassword, newPassword, operationId) => request({ currentPassword, newPassword }, operationId, true),
    endPasswordSession: async (result, onSessionEnd) => {
      if (!result?.reauthenticationRequired || typeof onSessionEnd !== 'function') return false
      let token
      try { token = await tokenForCurrent() } catch { return false }
      if (!token || !isCurrent()) return false
      // Invoke synchronously after the last context check. Main invalidates before awaiting sign-out.
      await onSessionEnd(result)
      return true
    },
  }
}
