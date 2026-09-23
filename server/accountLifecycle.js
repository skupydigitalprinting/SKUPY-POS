import { createHmac } from 'node:crypto'
import { isIP } from 'node:net'
import { validNewPassword } from '../src/utils/passwordRules.js'

const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)
const object = value => value && typeof value === 'object' && !Array.isArray(value)
const keys = (value, allowed) => object(value) && Object.keys(value).every(key => allowed.includes(key))
const name = value => typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 100
const proof = value => typeof value === 'string' && value.length > 0 && value.length <= 1024
const roles = ['staff', 'admin']
const validAccount = a => object(a) && uuid(a.id) && typeof a.username === 'string' &&
  typeof a.name === 'string' && roles.includes(a.role) && typeof a.active === 'boolean' &&
  typeof a.pending === 'boolean' && Number.isInteger(a.version) && a.version >= 0
const safeAccount = a => ({ id: a.id, username: a.username, name: a.name, role: a.role,
  active: a.active, pending: a.pending, version: a.version,
  ...(uuid(a.operationId) ? { operationId: a.operationId } : {}) })

function parse(body, self) {
  if (self) return keys(body, ['currentPassword', 'newPassword']) && proof(body.currentPassword) &&
    validNewPassword(body.newPassword) && body.currentPassword !== body.newPassword ? body : null
  if (!object(body)) return null
  if (body.action === 'list') return keys(body, ['action']) ? body : null
  if (body.action === 'status') return keys(body, ['action', 'operationId']) && uuid(body.operationId) ? body : null
  if (body.action === 'create') {
    if (!keys(body, ['action', 'username', 'name', 'role', 'initialPassword', 'ownerPassword']) ||
        typeof body.username !== 'string' || !/^[a-z0-9][a-z0-9._-]{2,31}$/.test(body.username.trim().toLowerCase()) ||
        !name(body.name) || !roles.includes(body.role) || !proof(body.ownerPassword) ||
        !validNewPassword(body.initialPassword) || body.initialPassword === body.ownerPassword) return null
    return { ...body, username: body.username.trim().toLowerCase(), name: body.name.trim() }
  }
  if (body.action === 'update') {
    const p = body.patch
    if (!keys(body, ['action', 'targetAdminId', 'expectedVersion', 'patch', 'ownerPassword']) ||
        !uuid(body.targetAdminId) || !Number.isInteger(body.expectedVersion) || body.expectedVersion < 1 ||
        !proof(body.ownerPassword) || !keys(p, ['name', 'role', 'active']) || !Object.keys(p).length ||
        ('name' in p && !name(p.name)) || ('role' in p && !roles.includes(p.role)) ||
        ('active' in p && typeof p.active !== 'boolean')) return null
    const patch = {}
    for (const field of ['name', 'role', 'active']) if (field in p) patch[field] = field === 'name' ? p.name.trim() : p[field]
    return { ...body, patch }
  }
  return null
}

function createHandler(d, self) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Vary', 'Origin')
    const send = (status, body) => res.status(status).json(body)
    const deny = (status, error = 'Permintaan akun tidak dapat diproses.') => send(status, { ok: false, error })
    if (!d.enabled || typeof d.hmacSecret !== 'string' || d.hmacSecret.length < 32 || !d.allowedOrigin) return deny(503)
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return deny(405) }
    if (req.headers?.origin !== d.allowedOrigin) return deny(403)
    const authorization = req.headers?.authorization
    if (typeof authorization !== 'string' || !/^Bearer \S{1,16384}$/.test(authorization)) return deny(401)
    if (typeof req.headers?.['content-type'] !== 'string' ||
        !/^application\/json(?:\s*;.*)?$/i.test(req.headers['content-type'])) return deny(415)
    let raw = req.body
    try {
      if (typeof raw === 'string') {
        if (Buffer.byteLength(raw) > 8192) return deny(413)
        raw = JSON.parse(raw)
      }
      if (Buffer.byteLength(JSON.stringify(raw) || '') > 8192) return deny(413)
    } catch { return deny(400) }
    const body = parse(raw, self)
    const mutation = self || ['create', 'update'].includes(body?.action)
    const operationId = mutation ? req.headers['idempotency-key'] : body?.operationId
    if (!body || (mutation && !uuid(operationId))) return deny(400)
    const token = authorization.slice(7)
    let actor
    let requestBound = false
    let reservedAdminId = null
    const digest = value => createHmac('sha256', d.hmacSecret).update(value).digest('hex')
    const uncertain = (locked = false) => send(503, { ok: false, operationId, uncertain: true,
      ...(self ? { reauthenticationRequired: true, ...(locked ? { locked: true } : {}) } : {}),
      error: 'Status operasi belum dapat dipastikan. Jangan kirim ulang operasi.' })
    const completed = result => result?.state === 'finished' && result.operationId === operationId &&
      (self ? result.reauthenticationRequired === true : validAccount(result.account) &&
        (body.action !== 'update' || result.account.id === body.targetAdminId) &&
        (!reservedAdminId || result.account.id === reservedAdminId))
    const success = result => send(!self && body.action === 'create' ? 201 : 200,
      { ok: true, operationId, ...(self ? { reauthenticationRequired: true } : { account: safeAccount(result.account) }) })
    const reconcile = async () => {
      // Status proves only UUID history. Require an acknowledged, payload-validated
      // reservation/begin before treating that history as this request's outcome.
      if (!requestBound) return uncertain()
      try {
        const result = await (self ? d.selfPasswordStatus : d.accountStatus)(actor, operationId)
        if (completed(result)) return success(result)
      } catch { /* An absent status cannot exclude a delayed commit. */ }
      return uncertain()
    }
    try {
      const ip = d.getClientIp(req)
      if (typeof ip !== 'string' || !isIP(ip)) return deny(503)
      const limit = key => d.consumeAttempt(['global', `ip:${digest(`ip:${ip}`)}`, `user:${digest(key)}`])
      if (!await limit(`account-token:${token}`)) return deny(429)
      actor = await (self ? d.verifySelf : d.verifyOwner)(token)
      if (!uuid(actor?.authUserId) || !uuid(actor?.authSessionId)) return deny(403)
      if (!mutation) {
        if (body.action === 'list') {
          const accounts = await d.listAccounts(actor)
          if (!Array.isArray(accounts) || !accounts.every(validAccount)) return deny(503)
          return send(200, { ok: true, accounts: accounts.map(safeAccount) })
        }
        const result = await d.accountStatus(actor, operationId)
        if (completed(result)) return success(result)
        if (!['reserved', 'auth_started', 'unknown'].includes(result?.state) ||
            (result.operationId && result.operationId !== operationId)) return deny(503)
        return send(200, { ok: true, operationId, state: result.state })
      }
      if (!await limit(`account-actor:${actor.authUserId}`)) return deny(429)
      if (!await (self ? d.reauthenticateSelf : d.reauthenticate)(actor.authUserId,
        self ? body.currentPassword : body.ownerPassword)) return deny(403, 'Verifikasi kata sandi gagal.')
    } catch { return deny(503) }

    try {
      if (self) {
        const fingerprint = digest(JSON.stringify(['self_password', actor.authUserId, body.newPassword]))
        const result = await d.beginSelfPassword(actor, operationId, fingerprint)
        if (completed(result)) return success(result)
        if (result?.dispatch !== true || result.operationId !== operationId || result.state !== 'auth_started') return uncertain()
        requestBound = true
        if (!await d.updatePassword(actor.authUserId, body.newPassword)) return uncertain(true)
        const finished = await d.finishSelfPassword(actor, operationId)
        return completed(finished) ? success(finished) : reconcile()
      }
      if (body.action === 'update') {
        const fingerprint = digest(JSON.stringify(['update', body.targetAdminId, body.expectedVersion, body.patch]))
        const result = await d.updateAccount(actor, operationId, body.targetAdminId, body.expectedVersion, body.patch, fingerprint)
        return completed(result) ? success(result) : reconcile()
      }
      const fields = { username: body.username, name: body.name, role: body.role }
      const fingerprint = digest(JSON.stringify(['create', fields, body.initialPassword]))
      const reservation = await d.reserveAccount(actor, operationId, fields, fingerprint)
      if (completed(reservation)) return success(reservation)
      if (reservation?.state !== 'reserved' || reservation.operationId !== operationId || !uuid(reservation.id)) return uncertain()
      requestBound = true
      reservedAdminId = reservation.id
      if (await d.claimAccount(actor, operationId) !== true) return uncertain()
      // Once claimed, no retry or email lookup may repeat/adopt an uncertain Auth write.
      const authId = await d.createAuthAccount(operationId, body.initialPassword)
      if (!uuid(authId)) return uncertain()
      const finished = await d.finishAccount(actor, operationId, authId)
      return completed(finished) ? success(finished) : reconcile()
    } catch (error) {
      // Definite SQL rejection before acknowledgement cannot authorize reconciliation
      // of an older operation with the same UUID and a different payload/password.
      if (!requestBound) {
        const status = { '40001': 409, '23505': 409, '42501': 403, '22023': 400 }[error?.code]
        if (status) return deny(status)
      }
      return reconcile()
    }
  }
}

export const createAccountLifecycleHandler = (dependencies = {}) => createHandler(dependencies, false)
export const createSelfPasswordHandler = (dependencies = {}) => createHandler(dependencies, true)
