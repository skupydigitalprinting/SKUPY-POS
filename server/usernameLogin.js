import { createHmac, randomInt } from 'node:crypto'
import { isIP } from 'node:net'

export function createUsernameLoginHandler(options = {}) {
  const unavailable = { error: 'Login belum tersedia. Silakan coba lagi.' }
  const denied = { error: 'Username atau password salah, atau akun belum aktif.' }
  return async (req, res) => {
    const started = performance.now()
    const denyLogin = async () => {
      const wait = options.wait || (ms => new Promise(resolve => setTimeout(resolve, ms)))
      await wait(Math.max(0, 1500 + randomInt(100) - (performance.now() - started)))
      return res.status(401).json(denied)
    }
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Pragma', 'no-cache')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    if (!options.enabled) return res.status(503).json(unavailable)
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST')
      return res.status(405).json({ error: 'Metode tidak didukung.' })
    }
    if (!options.allowedOrigin || req.headers.origin !== options.allowedOrigin) {
      return res.status(403).json({ error: 'Permintaan tidak diizinkan.' })
    }
    if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      return res.status(415).json({ error: 'Format permintaan tidak didukung.' })
    }
    const { username, password } = req.body || {}
    const normalized = typeof username === 'string' ? username.trim().toLowerCase() : ''
    if (!/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(normalized) ||
        typeof password !== 'string' || password.length < 1 || password.length > 1024) {
      return res.status(400).json({ error: 'Username atau password tidak valid.' })
    }
    try {
      const ip = options.getClientIp(req)
      if (typeof ip !== 'string' || !isIP(ip) || typeof options.hmacSecret !== 'string' || options.hmacSecret.length < 32) {
        return res.status(503).json(unavailable)
      }
      const hash = value => createHmac('sha256', options.hmacSecret).update(value).digest('hex')
      const keys = ['global', `ip:${hash(`ip:${ip}`)}`, `user:${hash(`user:${normalized}`)}`]
      if (await options.consumeAttempt(keys) !== true) {
        res.setHeader('Retry-After', '900')
        return res.status(429).json({ error: 'Terlalu banyak percobaan login. Coba lagi nanti.' })
      }
      const authId = await options.resolveAuthUserId(normalized)
      const dummyId = '00000000-0000-4000-8000-000000000000'
      const email = await options.getAuthEmail(authId || dummyId)
      // Unknown accounts still traverse directory + Auth; never authorize dummy work.
      const session = await options.authenticate(email || 'unmapped-login@skupy.invalid', password, authId || dummyId)
      if (!authId || !email || typeof session?.access_token !== 'string' || !session.access_token ||
          typeof session?.refresh_token !== 'string' || !session.refresh_token) return await denyLogin()
      return res.status(200).json({ session: { access_token: session.access_token, refresh_token: session.refresh_token } })
    } catch {
      // Never log credential-bearing SDK responses or echo backend errors.
      return res.status(503).json(unavailable)
    }
  }
}
