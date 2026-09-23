export function createStaffRecoveryClient({ auth, fetchImpl = globalThis.fetch, isCurrent = () => true }) {
  const denied = () => ({ ok: false, error: 'Reset belum berhasil. Periksa akun, password owner, dan koneksi.' })
  const uncertain = () => ({ ok: false, uncertain: true, error: 'Status reset belum dapat dipastikan. Hubungi pengelola sistem sebelum mencoba lagi.' })
  return async (targetAdminId, ownerPassword, newPassword) => {
    if (!isCurrent() || !targetAdminId || !ownerPassword || !validNewPassword(newPassword)) return denied()
    let dispatched = false
    try {
      const { data, error } = await auth.getSession()
      if (error || !data?.session?.access_token || !isCurrent()) return denied()
      const signal = AbortSignal.timeout(30000)
      dispatched = true
      const response = await fetchImpl('/api/auth/reset-staff-password', {
        method: 'POST', cache: 'no-store', redirect: 'error', credentials: 'same-origin',
        signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.session.access_token}` },
        body: JSON.stringify({ targetAdminId, ownerPassword, newPassword }),
      })
      const body = await response.json()
      if (!isCurrent()) return denied()
      if (response.ok && body.ok === true) return { ok: true }
      if (body.locked === true) return { ok: false, locked: true, error: 'Akun tujuan dikunci sementara karena reset belum terkonfirmasi. Hubungi pengelola sistem.' }
      if (body.uncertain === true) return uncertain()
      if (response.status === 429) return { ok: false, error: 'Terlalu banyak percobaan. Coba lagi nanti.' }
      if (response.ok || response.status >= 500) return uncertain()
      return denied()
    } catch { return dispatched ? uncertain() : denied() }
  }
}
import { validNewPassword } from '../utils/passwordRules.js'
