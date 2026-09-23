const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function uploadPrivateInvoice(client, blob, invoiceNo, randomUUID = () => crypto.randomUUID()) {
  if (!blob || blob.type !== 'image/png' || !blob.size || blob.size > 10485760) throw new Error('Invoice harus berupa PNG, maksimal 10 MB.')
  if (typeof invoiceNo !== 'string' || !invoiceNo.trim()) throw new Error('Nomor invoice belum tersedia.')
  const { data: transaction, error: lookupError } = await client.from('transactions').select('id').eq('invoice_no', invoiceNo).maybeSingle()
  if (lookupError) throw lookupError
  if (!UUID.test(transaction?.id || '')) throw new Error('Transaksi invoice tidak tersedia untuk akun ini.')
  const uploadId = randomUUID()
  if (!UUID.test(uploadId)) throw new Error('Identitas unggahan tidak valid.')
  const path = `${transaction.id}/${uploadId}.png`
  const bucket = client.storage.from('invoices')
  const { error: uploadError } = await bucket.upload(path, blob, { upsert: false, contentType: 'image/png', cacheControl: '0' })
  if (uploadError) throw uploadError
  const { data, error: signError } = await bucket.createSignedUrl(path, 1800)
  if (signError) throw signError
  if (!data?.signedUrl) throw new Error('Tautan invoice belum berhasil dibuat. Silakan coba lagi.')
  return data.signedUrl
}
