export function resolveAuthMode(env, origin) {
  if (!env.VITE_POS_AUTH_MODE || env.VITE_POS_AUTH_MODE === 'legacy') return 'legacy'
  try {
    const location = new URL(origin)
    if (env.VITE_POS_AUTH_MODE === 'local' && env.DEV === true &&
        location.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(location.hostname) &&
        env.VITE_SUPABASE_URL === 'http://127.0.0.1:54321') return 'secure'
    if (env.VITE_POS_AUTH_MODE === 'production' && env.PROD === true &&
        location.origin === 'https://pos.skupy.id' &&
        env.VITE_SUPABASE_URL === 'https://ejqfttivgovhqhzkrncx.supabase.co' &&
        !!env.VITE_SUPABASE_ANON_KEY) return 'secure'
    const ref = env.VITE_POS_AUTH_TEST_PROJECT_REF
    if (env.VITE_POS_AUTH_MODE !== 'preview' || location.protocol !== 'https:' ||
        location.hostname === 'pos.skupy.id' || !/^[a-z]{20}$/.test(ref || '') ||
        ref === 'ejqfttivgovhqhzkrncx' || env.VITE_SUPABASE_URL !== `https://${ref}.supabase.co`) return 'blocked'
    return 'secure'
  } catch { return 'blocked' }
}
