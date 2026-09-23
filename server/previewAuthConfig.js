export function previewAuthConfig(env = {}) {
  if (env.POS_USERNAME_LOGIN_ENABLED !== 'true' || env.VERCEL_ENV !== 'preview') return null
  const ref = env.POS_AUTH_TEST_PROJECT_REF
  if (!/^[a-z]{20}$/.test(ref || '') || ref === 'ejqfttivgovhqhzkrncx' ||
      env.SUPABASE_URL !== `https://${ref}.supabase.co` || !env.SUPABASE_ANON_KEY ||
      !env.SUPABASE_SERVICE_ROLE_KEY || (env.POS_LOGIN_HMAC_SECRET || '').length < 32) return null
  try {
    const origin = new URL(env.POS_APP_ORIGIN)
    if (origin.protocol !== 'https:' || origin.origin !== env.POS_APP_ORIGIN || origin.hostname === 'pos.skupy.id') return null
    return {
      url: env.SUPABASE_URL, anonKey: env.SUPABASE_ANON_KEY,
      serviceKey: env.SUPABASE_SERVICE_ROLE_KEY, allowedOrigin: origin.origin,
      hmacSecret: env.POS_LOGIN_HMAC_SECRET,
    }
  } catch { return null }
}
