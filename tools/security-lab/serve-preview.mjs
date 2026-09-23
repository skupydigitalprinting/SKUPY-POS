// Local-only security preview. Account actions target the isolated lab only.
import { createLocalDocker } from './localDocker.js'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import assert from 'node:assert/strict'
import { createServer as createViteServer } from 'vite'
import { createUsernameLoginHandler } from '../../server/usernameLogin.js'
import { createPasswordRecoveryHandler } from '../../server/passwordRecovery.js'
import { createSupabaseLoginDependencies } from '../../server/supabaseUsername.js'
import { createSupabaseRecoveryDependencies } from '../../server/supabaseRecovery.js'
import { createAccountLifecycleHandler, createSelfPasswordHandler } from '../../server/accountLifecycle.js'
import { createSupabaseAccountDependencies } from '../../server/supabaseAccounts.js'

const cli = process.env.SUPABASE_BIN || 'supabase'
const docker = createLocalDocker()
docker.inspect('supabase_db_skupy-auth-local')
docker.inspect('supabase_kong_skupy-auth-local')
const status = docker.status(cli, '/private/tmp/skupy-auth-local')
assert.equal(status.API_URL, 'http://127.0.0.1:54321')
assert.ok(status.ANON_KEY && status.SERVICE_ROLE_KEY)
const root = fileURLToPath(new URL('../..', import.meta.url))
const server = createServer()
const vite = await createViteServer({ root, cacheDir: '/private/tmp/skupy-auth-local/vite-cache',
  define: {
    'import.meta.env.VITE_POS_AUTH_MODE': JSON.stringify('local'),
    'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(status.API_URL),
    'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify(status.ANON_KEY),
  },
  server: { middlewareMode: true, hmr: { server }, host: '127.0.0.1' },
})
const config = { url: status.API_URL, anonKey: status.ANON_KEY, serviceKey: status.SERVICE_ROLE_KEY }
let handlers
server.on('request', async (req, res) => {
  if (!Object.hasOwn(handlers || {}, req.url)) return vite.middlewares(req, res)
  res.status = code => { res.statusCode = code; return res }
  res.json = body => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)) }
  try {
    let body = ''
    for await (const part of req) {
      body += part
      if (body.length > 16384) return res.status(413).json({ error: 'Permintaan terlalu besar.' })
    }
    req.body = JSON.parse(body || '{}')
    await handlers[req.url](req, res)
  } catch { if (!res.writableEnded) res.status(400).json({ error: 'Permintaan tidak valid.' }) }
})
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
const origin = `http://127.0.0.1:${server.address().port}`
const options = { enabled: true, allowedOrigin: origin, hmacSecret: randomBytes(32).toString('hex'), getClientIp: req => req.socket.remoteAddress }
const accountDependencies = { ...options, ...createSupabaseAccountDependencies(config) }
handlers = {
  '/api/auth/login': createUsernameLoginHandler({ ...options, ...createSupabaseLoginDependencies(config) }),
  '/api/auth/reset-staff-password': createPasswordRecoveryHandler({ ...options, ...createSupabaseRecoveryDependencies(config) }),
  '/api/accounts': createAccountLifecycleHandler(accountDependencies),
  '/api/auth/change-password': createSelfPasswordHandler(accountDependencies),
}
console.log(`Local login preview: ${origin}`)
let closing = false
async function close() {
  if (closing) return
  closing = true
  server.closeAllConnections()
  await vite.close()
  await new Promise(resolve => server.close(resolve))
}
process.on('SIGTERM', close)
process.on('SIGINT', close)
