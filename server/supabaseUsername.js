import { createClient } from '@supabase/supabase-js'
import { createUsernameLoginHandler } from './usernameLogin.js'
import { previewAuthConfig } from './previewAuthConfig.js'

const authOptions = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }

export function createSupabaseLoginDependencies({ url, anonKey, serviceKey }, factory = createClient) {
  const admin = factory(url, serviceKey, authOptions)
  return {
    consumeAttempt: async keys => {
      const { data, error } = await admin.rpc('pos_consume_login_attempt', { p_keys: keys })
      if (error) throw new Error('Rate limiter unavailable')
      return data === true
    },
    resolveAuthUserId: async username => {
      const { data, error } = await admin.rpc('pos_resolve_login', { p_username: username })
      if (error) throw new Error('Identity lookup unavailable')
      return Array.isArray(data) && data.length === 1 ? data[0].auth_user_id : null
    },
    getAuthEmail: async id => {
      const { data, error } = await admin.auth.admin.getUserById(id)
      if (error?.status === 404 || error?.code === 'user_not_found') return null
      if (error) throw new Error('Auth directory unavailable')
      return data?.user?.email || null
    },
    authenticate: async (email, password, expectedId) => {
      // Never sign in on the service-role client, or reuse a user's client.
      const userClient = factory(url, anonKey, authOptions)
      const reject = async () => { try { await userClient.auth.signOut({ scope: 'local' }) } catch {} return null }
      try {
        const { data, error } = await userClient.auth.signInWithPassword({ email, password })
        if (error || !data?.session) return await reject()
        const identity = await userClient.auth.getUser()
        if (identity.error || identity.data?.user?.id !== expectedId) return await reject()
        const profile = await userClient.rpc('pos_current_profile')
        if (profile.error || !Array.isArray(profile.data) || profile.data.length !== 1 ||
            profile.data[0].auth_user_id !== expectedId || !profile.data[0].id ||
            !['owner', 'admin', 'staff'].includes(profile.data[0].role)) return await reject()
        return { access_token: data.session.access_token, refresh_token: data.session.refresh_token }
      } catch {
        await reject()
        throw new Error('Auth verification unavailable')
      }
    },
  }
}

export function createPreviewLoginHandler(env = {}) {
  const disabled = () => createUsernameLoginHandler({ enabled: false })
  // Deliberately preview-only until recovery and coordinated RLS cutover pass.
  const config = previewAuthConfig(env)
  if (!config) return disabled()
  try {
    return createUsernameLoginHandler({
      enabled: true, allowedOrigin: config.allowedOrigin, hmacSecret: config.hmacSecret,
      // Trusted only on Vercel; do not substitute arbitrary client headers.
      getClientIp: req => req.headers['x-vercel-forwarded-for'],
      ...createSupabaseLoginDependencies(config),
    })
  } catch { return disabled() }
}
