import { createClient } from '@supabase/supabase-js'
import { createPasswordRecoveryHandler } from './passwordRecovery.js'
import { previewAuthConfig } from './previewAuthConfig.js'

const auth = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }

export function createSupabaseRecoveryDependencies({ url, anonKey, serviceKey }, factory = createClient) {
  const admin = factory(url, serviceKey, { auth })
  const ownerProfile = async (client, expectedId) => {
    const { data, error } = await client.rpc('pos_current_profile')
    return !error && Array.isArray(data) && data.length === 1 && data[0].id &&
      data[0].auth_user_id === expectedId && data[0].role === 'owner'
  }
  return {
    consumeAttempt: async keys => {
      const { data, error } = await admin.rpc('pos_consume_login_attempt', { p_keys: keys })
      if (error) throw new Error('Rate limiter unavailable')
      return data === true
    },
    verifyOwner: async token => {
      const caller = factory(url, anonKey, { auth, global: { headers: { Authorization: `Bearer ${token}` } } })
      const { data, error } = await caller.auth.getUser(token)
      if (error || !data?.user?.id || !await ownerProfile(caller, data.user.id)) return null
      return { authUserId: data.user.id }
    },
    reauthenticate: async (id, password) => {
      const { data, error } = await admin.auth.admin.getUserById(id)
      if (error || !data?.user?.email) return false
      const proof = factory(url, anonKey, { auth })
      let verified = false
      try {
        const result = await proof.auth.signInWithPassword({ email: data.user.email, password })
        if (!result.error && result.data?.session) {
          const identity = await proof.auth.getUser()
          verified = !identity.error && identity.data?.user?.id === id && !!await ownerProfile(proof, id)
        }
      } finally {
        try {
          const result = await proof.auth.signOut({ scope: 'local' })
          if (result.error) verified = false
        } catch { verified = false }
      }
      return verified
    },
    beginReset: async (actor, targetAdmin, operation) => {
      const { data, error } = await admin.rpc('pos_begin_staff_password_reset', {
        p_actor: actor, p_target_admin: targetAdmin, p_operation: operation,
      })
      if (error?.code === '42501') return null
      if (error) throw new Error('Reset start outcome unavailable')
      if (!Array.isArray(data) || data.length !== 1) throw new Error('Reset start outcome unavailable')
      return data[0].auth_user_id || null
    },
    updatePassword: async (id, password) => {
      const { data, error } = await admin.auth.admin.updateUserById(id, { password })
      return !error && data?.user?.id === id
    },
    finishReset: async (actor, targetAdmin, operation) => {
      const { data, error } = await admin.rpc('pos_finish_staff_password_reset', {
        p_actor: actor, p_target_admin: targetAdmin, p_operation: operation,
      })
      if (error) throw new Error('Reset completion outcome unavailable')
      return data === true
    },
    getResetStatus: async (actor, targetAdmin, operation) => {
      const { data, error } = await admin.rpc('pos_staff_password_reset_status', {
        p_actor: actor, p_target_admin: targetAdmin, p_operation: operation,
      })
      if (error || !Array.isArray(data) || data.length !== 1 ||
          !['not_started', 'pending', 'finished', 'unknown'].includes(data[0].state)) throw new Error('Reset status unavailable')
      return { state: data[0].state, authUserId: data[0].auth_user_id }
    },
  }
}

export function createPreviewRecoveryHandler(env = {}) {
  const config = previewAuthConfig(env)
  if (!config) return createPasswordRecoveryHandler({ enabled: false })
  return createPasswordRecoveryHandler({
    enabled: true, allowedOrigin: config.allowedOrigin, hmacSecret: config.hmacSecret,
    getClientIp: req => req.headers['x-vercel-forwarded-for'],
    ...createSupabaseRecoveryDependencies(config),
  })
}
