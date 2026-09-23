// Read routing identity only. Signature/session validity is checked by Auth + SQL.
export function sessionBinding(token) {
  try {
    if (typeof token !== 'string' || token.length > 16384) return null
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const claims = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')))
    const uuid = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i
    if (!uuid.test(claims.sub || '') || !uuid.test(claims.session_id || '')) return null
    return { authUserId: claims.sub, authSessionId: claims.session_id }
  } catch { return null }
}
