export const PRODUCT_PUBLIC_COLUMNS = 'id,name,category,price,stock,unit,description,created_at'

export async function attachProductCosts(client, rows, role) {
  if (role !== 'owner' || !rows.length) return rows
  const { data, error } = await client.rpc('pos_product_costs')
  if (error) throw error
  const costs = new Map((data || []).map(row => [row.id, row.modal]))
  if (rows.some(row => !costs.has(row.id))) throw new Error('Harga modal belum berhasil dimuat lengkap. Silakan muat ulang.')
  return rows.map(row => ({ ...row, modal: costs.get(row.id) }))
}

export async function saveSecureProduct(client, id, payload, role) {
  const values = { ...payload }
  if (role !== 'owner') delete values.modal
  const { data, error } = await client.rpc('pos_save_product', { p_id: id, p_values: values })
  if (error) throw error
  if (!data?.id) throw new Error('Produk belum berhasil disimpan.')
  return data
}
