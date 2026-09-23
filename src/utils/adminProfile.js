// Profile reads must never request credentials. Database authorization is separate.
export const ADMIN_PROFILE_COLUMNS = 'id,username,name,role'

export function adminProfileFromDB(row) {
  return {
    id: row.id,
    username: row.username,
    name: row.name || row.username,
    role: row.role || 'staff',
  }
}
