import { sessionBinding } from './sessionBinding.js'

// Production cutover remains gated; secure preview binds each verified session.
export function createPosAuth(client, { fetchImpl = globalThis.fetch, bindSession = false } = {}) {
  const denied = () => ({ ok: false, error: 'Sesi tidak valid atau akun belum mendapat akses POS.' })
  let pending = Promise.resolve()
  const serialize = action => {
    const next = pending.then(action, action)
    pending = next.catch(() => {})
    return next
  }

  async function signOut() {
    try {
      const { error } = await client.auth.signOut({ scope: 'local' })
      return error ? { ok: false, error: 'Keluar akun belum berhasil. Silakan coba lagi.' } : { ok: true }
    } catch {
      return { ok: false, error: 'Keluar akun belum berhasil. Silakan coba lagi.' }
    }
  }

  async function restore() {
    try {
      let binding, bearer
      if (bindSession) {
        const current = await client.auth.getSession()
        bearer = current.data?.session?.access_token
        binding = sessionBinding(bearer)
        if (current.error || !binding) return denied()
      }
      const { data, error } = await client.auth.getUser(bearer)
      if (error || !data?.user?.id) return denied()
      if (bindSession && binding.authUserId !== data.user.id) return denied()

      const { data: profiles, error: profileError } = await client.rpc('pos_current_profile')
      const profile = Array.isArray(profiles) && profiles.length === 1 ? profiles[0] : null
      if (profileError || !profile?.id || !profile.username ||
          profile.auth_user_id !== data.user.id ||
          !['owner', 'admin', 'staff'].includes(profile.role)) return denied()

      if (bindSession) {
        const current = await client.auth.getSession()
        const latest = sessionBinding(current.data?.session?.access_token)
        if (current.error || latest?.authUserId !== binding.authUserId || latest?.authSessionId !== binding.authSessionId) return denied()
      }

      return {
        ok: true,
        user: {
          id: profile.id, username: profile.username,
          name: profile.name || profile.username, role: profile.role,
          authUserId: data.user.id,
          ...(bindSession ? { authSessionId: binding.authSessionId } : {}),
        },
      }
    } catch {
      return denied()
    }
  }

  async function signIn(email, password) {
    if (typeof email !== 'string' || !email.trim() || typeof password !== 'string' || !password) {
      return { ok: false, error: 'Email dan password wajib diisi.' }
    }
    try {
      const { error } = await client.auth.signInWithPassword({ email: email.trim(), password })
      if (error) {
        await signOut()
        return { ok: false, error: 'Login gagal. Periksa email dan password atau coba lagi.' }
      }
      const result = await restore()
      if (!result.ok) await signOut()
      return result
    } catch {
      await signOut()
      return { ok: false, error: 'Login belum berhasil. Periksa koneksi dan coba lagi.' }
    }
  }

  async function signInUsername(username, password) {
    const normalized = typeof username === 'string' ? username.trim().toLowerCase() : ''
    if (!/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(normalized) ||
        typeof password !== 'string' || !password || password.length > 1024) {
      return { ok: false, error: 'Username dan password tidak valid.' }
    }
    try {
      const response = await fetchImpl('/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin', cache: 'no-store', redirect: 'error',
        signal: AbortSignal.timeout(25000),
        body: JSON.stringify({ username: normalized, password }),
      })
      if (!response.ok) {
        await signOut()
        return { ok: false, error: response.status === 429
          ? 'Terlalu banyak percobaan login. Coba lagi nanti.'
          : 'Login gagal. Periksa username dan password atau coba lagi.' }
      }
      const { session } = await response.json()
      if (typeof session?.access_token !== 'string' || !session.access_token ||
          typeof session?.refresh_token !== 'string' || !session.refresh_token) {
        await signOut()
        return denied()
      }
      const { error } = await client.auth.setSession({ access_token: session.access_token, refresh_token: session.refresh_token })
      const result = error ? denied() : await restore()
      if (!result.ok) await signOut()
      return result
    } catch {
      await signOut()
      return { ok: false, error: 'Login belum berhasil. Periksa koneksi dan coba lagi.' }
    }
  }

  // Keep delayed sign-in responses from restoring a session after queued logout.
  return {
    signIn: (...args) => serialize(() => signIn(...args)),
    signInUsername: (...args) => serialize(() => signInUsername(...args)),
    restore: () => serialize(restore),
    signOut: () => serialize(signOut),
  }
}
