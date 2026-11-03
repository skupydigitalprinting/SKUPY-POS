// Build a fresh, deterministically ordered query for every page. The offset
// follows the returned rows so a lower server row cap cannot skip records.
export async function readCompleteRows(buildQuery) {
  const rows = []
  const ids = new Set()
  let expected = null
  try {
    for (;;) {
      const result = await buildQuery().order('id', { ascending: true }).range(rows.length, rows.length + 499)
      if (result.error) return { data: null, error: result.error, count: null }
      if (!Array.isArray(result.data) || !Number.isInteger(result.count) || result.count < 0) throw new Error('Data belum lengkap. Muat ulang data.')
      if (Number.isInteger(result.count)) {
        if (expected !== null && result.count !== expected) throw new Error('Data berubah saat dimuat. Muat ulang data.')
        expected = result.count
      }
      for (const row of result.data) {
        if (row.id != null) {
          if (ids.has(row.id)) throw new Error('Data berubah saat dimuat. Muat ulang data.')
          ids.add(row.id)
        }
        rows.push(row)
      }
      if (expected !== null && rows.length > expected) throw new Error('Data belum lengkap. Muat ulang data.')
      if (rows.length === expected) return { data: rows, error: null, count: rows.length }
      if (!result.data.length) throw new Error('Data belum lengkap. Muat ulang data.')
    }
  } catch (error) { return { data: null, error, count: null } }
}

export function readBookRows(client, table, bookId, columns = '*', dateColumn = 'created_at') {
  return readCompleteRows(() => {
    let query = client.from(table).select(columns, { count: 'exact' }).is('deleted_at', null)
      .order(dateColumn, { ascending: false })
    if (bookId) query = query.eq('book_id', bookId)
    return query
  })
}
