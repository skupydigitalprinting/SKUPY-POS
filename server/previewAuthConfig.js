export function previewAuthConfig(env = {}) {
  if (env.POS_USERNAME_LOGIN_ENABLED !== 'true') return null
  const production = env.VERCEL_ENV === 'production'
  if (!production && env.VERCEL_ENV !== 'preview') return null
  const ref = env.POS_AUTH_TEST_PROJECT_REF
  if ((production
    ? env.SUPABASE_URL !== 'https://ejqfttivgovhqhzkrncx.supabase.co' || env.POS_APP_ORIGIN !== 'https://pos.skupy.id'
    : !/^[a-z]{20}$/.test(ref || '') || ref === 'ejqfttivgovhqhzkrncx' ||
      env.SUPABASE_URL !== `https://${ref}.supabase.co`) || !env.SUPABASE_ANON_KEY ||
      !env.SUPABASE_SERVICE_ROLE_KEY || (env.POS_LOGIN_HMAC_SECRET || '').length < 32) return null
  try {
    const origin = new URL(env.POS_APP_ORIGIN)
    if (origin.protocol !== 'https:' || origin.origin !== env.POS_APP_ORIGIN ||
        (!production && origin.hostname === 'pos.skupy.id')) return null
    return {
      url: env.SUPABASE_URL, anonKey: env.SUPABASE_ANON_KEY,
      serviceKey: env.SUPABASE_SERVICE_ROLE_KEY, allowedOrigin: origin.origin,
      hmacSecret: env.POS_LOGIN_HMAC_SECRET,
    }
  } catch { return null }
}
