import { createClient } from '@supabase/supabase-js'
import { createSupabaseRecoveryDependencies } from './supabaseRecovery.js'
import { createAccountLifecycleHandler, createSelfPasswordHandler } from './accountLifecycle.js'
import { previewAuthConfig } from './previewAuthConfig.js'
import { sessionBinding } from '../src/lib/sessionBinding.js'

const auth = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)

export function createSupabaseAccountDependencies(config, factory = createClient) {
  const { url, anonKey, serviceKey } = config
  const recovery = createSupabaseRecoveryDependencies(config, factory)
  const admin = factory(url, serviceKey, { auth })
  const rpc = async (name, actor, args = {}) => {
    const { data, error } = await admin.rpc(name, {
      p_actor: actor.authUserId, p_session: actor.authSessionId, ...args,
    })
    if (error) throw Object.assign(new Error('Account operation unavailable'), { code: error.code })
    return data
  }
  const profile = async (client, id) => {
    const { data, error } = await client.rpc('pos_current_profile')
    return !error && Array.isArray(data) && data.length === 1 && data[0].id &&
      data[0].auth_user_id === id && ['owner', 'admin', 'staff'].includes(data[0].role)
  }
  return {
    consumeAttempt: recovery.consumeAttempt,
    reauthenticate: recovery.reauthenticate,
    updatePassword: recovery.updatePassword,
    verifyOwner: async token => {
      const binding = sessionBinding(token)
      if (!binding) return null
      const owner = await recovery.verifyOwner(token)
      return owner?.authUserId === binding.authUserId ? binding : null
    },
    verifySelf: async token => {
      const binding = sessionBinding(token)
      if (!binding) return null
      const caller = factory(url, anonKey, { auth, global: { headers: { Authorization: `Bearer ${token}` } } })
      const { data, error } = await caller.auth.getUser(token)
      return !error && data?.user?.id === binding.authUserId && await profile(caller, data.user.id) ? binding : null
    },
    reauthenticateSelf: async (id, password) => {
      const { data, error } = await admin.auth.admin.getUserById(id)
      if (error || data?.user?.id !== id || !data.user.email) return false
      const proof = factory(url, anonKey, { auth })
      let verified = false
      try {
        const result = await proof.auth.signInWithPassword({ email: data.user.email, password })
        if (!result.error && result.data?.session) {
          const identity = await proof.auth.getUser()
          verified = !identity.error && identity.data?.user?.id === id && !!await profile(proof, id)
        }
      } finally {
        try {
          const result = await proof.auth.signOut({ scope: 'local' })
          if (result.error) verified = false
        } catch { verified = false }
      }
      return verified
    },
    listAccounts: actor => rpc('pos_managed_accounts', actor),
    reserveAccount: (actor, operationId, fields, fingerprint) => rpc('pos_account_reserve', actor, {
      p_operation: operationId, p_username: fields.username, p_name: fields.name, p_role: fields.role, p_fingerprint: fingerprint,
    }),
    claimAccount: (actor, operationId) => rpc('pos_account_claim', actor, { p_operation: operationId }),
    createAuthAccount: async (operationId, password) => {
      if (!uuid(operationId)) return null
      // This reserved, nonexistent-domain identifier is not a claim of real email ownership.
      const email = `${operationId.toLowerCase()}@staff.skupy.invalid`
      const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true })
      return !error && uuid(data?.user?.id) && data.user.email === email ? data.user.id : null
    },
    finishAccount: (actor, operationId, authId) => rpc('pos_account_finish_create', actor, { p_operation: operationId, p_auth_user: authId }),
    updateAccount: (actor, operationId, target, version, patch, fingerprint) => rpc('pos_account_update', actor, {
      p_operation: operationId, p_target: target, p_expected_version: version, p_patch: patch, p_fingerprint: fingerprint,
    }),
    accountStatus: (actor, operationId) => rpc('pos_account_status', actor, { p_operation: operationId }),
    beginSelfPassword: (actor, operationId, fingerprint) => rpc('pos_self_password_begin', actor, { p_operation: operationId, p_fingerprint: fingerprint }),
    finishSelfPassword: (actor, operationId) => rpc('pos_self_password_finish', actor, { p_operation: operationId }),
    selfPasswordStatus: (actor, operationId) => rpc('pos_self_password_status', actor, { p_operation: operationId }),
  }
}

function preview(handler, env) {
  const config = previewAuthConfig(env)
  if (!config) return handler({ enabled: false })
  return handler({ enabled: true, allowedOrigin: config.allowedOrigin, hmacSecret: config.hmacSecret,
    getClientIp: req => req.headers['x-vercel-forwarded-for'], ...createSupabaseAccountDependencies(config) })
}
export const createPreviewAccountsHandler = (env = {}) => preview(createAccountLifecycleHandler, env)
export const createPreviewSelfPasswordHandler = (env = {}) => preview(createSelfPasswordHandler, env)
