import { createPosAuth } from './posAuth'
import { createAuthSessionController } from './authSessionController'
import { supabase, authStorage, authMode, activateDataSession, invalidateDataSession } from './supabase'
import { AUTH_STORAGE_KEY, AUTH_REMEMBER_KEY } from './authStorage'

export const authSession = createAuthSessionController({
  auth: createPosAuth(supabase, { bindSession: true }),
  onInvalidate: invalidateDataSession,
  onActivate: user => {
    if (authMode !== 'secure') throw new Error('Konfigurasi login belum valid.')
    activateDataSession(user)
  },
  clearCredentials: authStorage.clear,
  choosePersistence: authStorage.choosePersistence,
})

export function startAuthRuntime() {
  const { data } = supabase.auth.onAuthStateChange(event => { authSession.handleAuthEvent(event) })
  const onFocus = () => { if (document.visibilityState === 'visible') void authSession.restore() }
  const onStorage = event => {
    if (event.key === null || [AUTH_STORAGE_KEY, AUTH_REMEMBER_KEY].includes(event.key)) {
      if (!event.newValue) void authSession.signOut()
      else void authSession.restore()
    }
  }
  document.addEventListener('visibilitychange', onFocus)
  window.addEventListener('storage', onStorage)
  const timer = setInterval(onFocus, 60000)
  void authSession.restore()
  return () => {
    clearInterval(timer)
    data.subscription.unsubscribe()
    document.removeEventListener('visibilitychange', onFocus)
    window.removeEventListener('storage', onStorage)
  }
}
