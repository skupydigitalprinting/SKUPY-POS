import { sessionBinding } from './sessionBinding.js'

export function createDataSession({ primary, transport, url, key, factory }) {
  let active = false
  let generation = 0
  let client = null
  let principal = null
  const abort = () => { throw new DOMException('Sesi data sudah berakhir.', 'AbortError') }
  function getClient() {
    if (client) return client
    const issued = generation
    const assertCurrent = () => { if (!active || issued !== generation) abort() }
    const db = factory(url, key, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: async (input, init = {}) => {
        assertCurrent()
        const { data, error } = await primary.auth.getSession()
        assertCurrent()
        if (error || !data?.session?.access_token) abort()
        const binding = sessionBinding(data.session.access_token)
        if (binding?.authUserId !== principal?.authUserId || binding?.authSessionId !== principal?.authSessionId) abort()
        const requestUrl = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
        if (requestUrl.origin !== new URL(url).origin) abort()
        const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined))
        headers.set('Authorization', `Bearer ${data.session.access_token}`)
        const response = await transport.fetch(input, { ...init, headers })
        assertCurrent()
        return response
      } },
    })
    client = {
      from: (...args) => db.from(...args),
      rpc: (...args) => db.rpc(...args),
      storage: db.storage,
      channel: (...args) => { assertCurrent(); return primary.channel(...args) },
      removeChannel: (...args) => primary.removeChannel(...args),
    }
    return client
  }
  return {
    getClient,
    activate: user => {
      if (!user?.authUserId || !user?.authSessionId) abort()
      principal = { authUserId: user.authUserId, authSessionId: user.authSessionId }
      active = true; generation++; client = null; transport.activate()
    },
    invalidate: () => { active = false; generation++; client = null; principal = null; transport.invalidate() },
  }
}
