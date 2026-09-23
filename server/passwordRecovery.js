import { createHmac, randomUUID } from 'node:crypto'
import { isIP } from 'node:net'
import { validNewPassword } from '../src/utils/passwordRules.js'

export function createPasswordRecoveryHandler(options = {}) {
  const unavailable = { error: 'Reset password belum tersedia. Silakan coba lagi.' }
  const denied = { error: 'Reset password tidak diizinkan. Periksa akun dan password owner.' }
  const locked = { locked: true, error: 'Reset belum terkonfirmasi. Akses akun tujuan dikunci sementara; hubungi pengelola sistem.' }
  const uncertain = { uncertain: true, error: 'Status reset belum dapat dipastikan. Hubungi pengelola sistem sebelum mencoba lagi.' }
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Pragma', 'no-cache')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    if (!options.enabled) return res.status(503).json(unavailable)
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST')
      return res.status(405).json({ error: 'Metode tidak didukung.' })
    }
    if (!options.allowedOrigin || req.headers.origin !== options.allowedOrigin) return res.status(403).json(denied)
    if (typeof req.headers['content-type'] !== 'string' ||
        req.headers['content-type'].split(';')[0].trim().toLowerCase() !== 'application/json') {
      return res.status(415).json({ error: 'Format permintaan tidak didukung.' })
    }
    const authorization = req.headers.authorization
    if (typeof authorization !== 'string' || !/^Bearer [^\s]{1,8192}$/.test(authorization)) return res.status(401).json(denied)
    const token = authorization.slice(7)
    const { targetAdminId, ownerPassword, newPassword } = req.body || {}
    if (typeof targetAdminId !== 'string' || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(targetAdminId) ||
        typeof ownerPassword !== 'string' || !ownerPassword || ownerPassword.length > 1024 ||
        !validNewPassword(newPassword) || newPassword === ownerPassword) return res.status(400).json({ error: 'Gunakan minimal 12 karakter, maksimal 72 byte, dan berbeda dari password owner.' })
    let begun = false
    try {
      const ip = options.getClientIp(req)
      if (typeof ip !== 'string' || !isIP(ip) || typeof options.hmacSecret !== 'string' || options.hmacSecret.length < 32) {
        return res.status(503).json(unavailable)
      }
      const hash = value => createHmac('sha256', options.hmacSecret).update(value).digest('hex')
      // Share the global/IP budget with login; never store the bearer token.
      if (await options.consumeAttempt(['global', `ip:${hash(`ip:${ip}`)}`, `user:${hash(`reset:${token}`)}`]) !== true) {
        res.setHeader('Retry-After', '900')
        return res.status(429).json({ error: 'Terlalu banyak percobaan. Coba lagi nanti.' })
      }
      const actor = await options.verifyOwner(token)
      if (!actor?.authUserId || await options.reauthenticate(actor.authUserId, ownerPassword) !== true) {
        return res.status(403).json(denied)
      }
      const operation = randomUUID()
      const readStatus = async () => {
        try { return await options.getResetStatus(actor.authUserId, targetAdminId, operation) }
        catch { return { state: 'unknown' } }
      }
      let targetAuthId
      try { targetAuthId = await options.beginReset(actor.authUserId, targetAdminId, operation) }
      catch {
        const status = await readStatus()
        if (status?.state === 'pending' && status.authUserId) targetAuthId = status.authUserId
        // A not-started snapshot cannot rule out a delayed begin still committing.
        else return res.status(503).json(uncertain)
      }
      if (!targetAuthId) return res.status(409).json({ error: 'Akun tujuan tidak tersedia untuk reset atau sedang diproses.' })
      begun = true
      if (await options.updatePassword(targetAuthId, newPassword) !== true) return res.status(503).json(locked)
      let finished = false
      try { finished = await options.finishReset(actor.authUserId, targetAdminId, operation) === true } catch { /* reconcile below */ }
      if (!finished) {
        const status = await readStatus()
        if (status?.state === 'finished' && status.authUserId === targetAuthId) finished = true
        // A pending snapshot cannot rule out an outstanding finish committing later.
        else return res.status(503).json(uncertain)
      }
      return res.status(200).json({ ok: true })
    } catch {
      // Once locked, ambiguous Auth errors must never reactivate the target.
      return res.status(503).json(begun ? locked : unavailable)
    }
  }
}
