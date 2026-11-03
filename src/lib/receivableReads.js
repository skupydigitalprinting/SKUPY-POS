// Read complete lightweight collections without treating a page as a total.
async function readPages(query) {
  const rows = []
  const ids = new Set()
  let expectedCount = null
  try {
    for (;;) {
      const result = await query().range(rows.length, rows.length + 499)
      if (result.error) return { data: null, error: result.error }
      if (!Array.isArray(result.data)) throw new Error('Data piutang belum lengkap. Muat ulang data.')
      if (Number.isInteger(result.count)) {
        if (expectedCount !== null && result.count !== expectedCount) throw new Error('Data berubah saat dimuat. Muat ulang data.')
        expectedCount = result.count
      }
      for (const row of result.data) {
        if (ids.has(row.id)) throw new Error('Data berubah saat dimuat. Muat ulang data.')
        ids.add(row.id)
        rows.push(row)
      }
      if (expectedCount !== null && rows.length > expectedCount) throw new Error('Data berubah saat dimuat. Muat ulang data.')
      if (expectedCount !== null ? rows.length === expectedCount : result.data.length < 500) return { data: rows, error: null }
      if (result.data.length === 0) throw new Error('Data piutang belum lengkap. Muat ulang data.')
    }
  } catch (error) { return { data: null, error } }
}

export function readReceivables(client, bookId) {
  return readPages(() => {
    let query = client.from('debts').select('*', { count: 'exact' }).is('deleted_at', null)
      .order('created_at', { ascending: false }).order('id', { ascending: false })
    if (bookId) query = query.eq('book_id', bookId)
    return query
  })
}

export async function readReceivablePayments(client, debtIds) {
  const ids = [...new Set(debtIds.filter(Boolean))]
  const payments = []
  for (let start = 0; start < ids.length; start += 100) {
    const result = await readPages(() => client.from('debt_payments').select('*', { count: 'exact' })
      .in('debt_id', ids.slice(start, start + 100)).is('deleted_at', null)
      .order('paid_at', { ascending: false }).order('id', { ascending: false }))
    if (result.error) return { ok: false, error: result.error.message, data: [] }
    payments.push(...result.data)
  }
  return { ok: true, data: payments }
}
