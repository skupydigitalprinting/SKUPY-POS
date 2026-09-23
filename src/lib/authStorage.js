export const AUTH_STORAGE_KEY = 'skupy_auth_v3'
export const AUTH_REMEMBER_KEY = 'skupy_auth_remember_v1'

export function createAuthStorage({ local, session }) {
  const keys = [AUTH_STORAGE_KEY, `${AUTH_STORAGE_KEY}-code-verifier`, `${AUTH_STORAGE_KEY}-user`,
    'skupy_session_v2', 'skupy_active_book']
  function clear() {
    let failed = false
    for (const storage of [local, session]) {
      for (const key of [...keys, AUTH_REMEMBER_KEY]) {
        try { storage.removeItem(key) } catch { failed = true }
      }
    }
    if (failed) throw new Error('Penyimpanan sesi tidak dapat dibersihkan.')
  }
  const selected = () => local.getItem(AUTH_REMEMBER_KEY) === 'true' ? local : session
  return {
    getItem: key => selected().getItem(key),
    setItem: (key, value) => selected().setItem(key, value),
    removeItem: key => {
      local.removeItem(key)
      session.removeItem(key)
    },
    clear,
    choosePersistence: remember => {
      clear()
      if (remember) local.setItem(AUTH_REMEMBER_KEY, 'true')
    },
  }
}
