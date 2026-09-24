import { calculateInvoiceChange } from '../utils/invoiceChanges.js'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const rollback = new Set(['22023', '22P02', '23502', '23503', '23505', '23514', '42501', '40001', '25000'])
const uncertain = operationId => ({ ok: false, needsReconciliation: true, operationId,
  error: 'Hasil checkout belum pasti. Periksa status sebelum membuat invoice lagi.' })

export function normalizeCheckoutRequest(value) {
  if (!value || !uuid.test(value.bookId) || (value.customerId !== null && !uuid.test(value.customerId))
    || typeof value.customerName !== 'string' || !value.customerName.trim() || value.customerName.length > 256
    || typeof value.notes !== 'string' || value.notes.length > 4000 || !['cash', 'transfer', 'qris', 'hutang'].includes(value.method)
    || (value.dueDate !== null && (typeof value.dueDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.dueDate)
      || !Number.isFinite(Date.parse(value.dueDate)) || new Date(value.dueDate).toISOString().slice(0, 10) !== value.dueDate))) {
    throw new Error('Data checkout belum lengkap.')
  }
  const quote = calculateInvoiceChange({ items: value.items, discount: value.discount, tax: 0, paid: value.paid })
  if (value.items.length > 1000 || quote.overpaid || (quote.remaining > 0 && (!value.customerId || !value.dueDate))
    || (value.paid > 0 && value.method === 'hutang')) throw new Error('Periksa pelanggan, jatuh tempo, nominal dan metode DP.')
  const items = quote.items.map(item => {
    if (!uuid.test(item.productId) || item.name.length > 1000) throw new Error('Barang checkout tidak valid.')
    return { productId: item.productId, name: item.name, price: item.price, qty: item.qty, unit: item.unit }
  })
  return { bookId: value.bookId, customerId: value.customerId, customerName: value.customerName.trim(), items,
    discount: value.discount, paid: value.paid, method: value.method, dueDate: value.dueDate, notes: value.notes }
}

export function createCheckoutClient({ client, scope, actorId, isCurrent, storage = globalThis.localStorage,
  draftStorage = globalThis.sessionStorage, locks = globalThis.navigator?.locks, crypto = globalThis.crypto }) {
  const key = `skupy:checkout-operation:v1:${encodeURIComponent(scope)}:${encodeURIComponent(actorId)}`
  const current = () => { if (!scope || !actorId || !isCurrent?.()) throw new Error('Sesi berubah. Periksa checkout dengan akun semula.') }
  const hash = async request => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',
    new TextEncoder().encode(JSON.stringify(normalizeCheckoutRequest(request))))), byte => byte.toString(16).padStart(2, '0')).join('')
  const read = () => {
    const value = JSON.parse(storage.getItem(key) || 'null')
    if (value && (value.actorId !== actorId || !uuid.test(value.operationId) || !uuid.test(value.bookId)
      || !/^[a-f0-9]{64}$/.test(value.fingerprint))) throw new Error('Catatan checkout perlu diperiksa.')
    return value
  }
  const clear = () => { draftStorage.removeItem(key); storage.removeItem(key) }
  const complete = async (intent, envelope) => {
    current()
    if (envelope?.state === 'abandoned' && envelope.operationId === intent.operationId && envelope.bookId === intent.bookId) {
      clear()
      return storage.getItem(key) === null ? { ok: true, abandoned: true } : uncertain(intent.operationId)
    }
    const result = envelope?.result
    if (envelope?.state !== 'complete' || envelope.operationId !== intent.operationId || !uuid.test(result?.id)
      || typeof result?.invoice_no !== 'string' || !result.invoice_no || result.version !== 0
      || await hash(envelope.request) !== intent.fingerprint) return uncertain(intent.operationId)
    const request = normalizeCheckoutRequest(envelope.request)
    const quote = calculateInvoiceChange({ ...request, tax: 0 })
    if (result.book_id !== request.bookId || result.customer_id !== request.customerId
      || result.payment_method !== request.method || result.dp !== request.paid
      || result.status !== (quote.remaining === 0 ? 'lunas' : 'pending')
      || !['subtotal', 'discount', 'tax', 'total', 'paid', 'remaining'].every(k => result[k] === quote[k])
      || JSON.stringify(normalizeCheckoutRequest({ ...request, items: result.items }).items) !== JSON.stringify(request.items)) {
      return uncertain(intent.operationId)
    }
    current(); clear()
    if (storage.getItem(key) !== null) return uncertain(intent.operationId)
    return { ok: true, data: result }
  }
  const status = async intent => {
    current()
    const response = await client.rpc('pos_checkout_status', { p_operation_id: intent.operationId })
    current()
    if (response?.error) return uncertain(intent.operationId)
    if (['complete', 'abandoned'].includes(response?.data?.state)) return complete(intent, response.data)
    return { ...uncertain(intent.operationId), unknown: response?.data?.state === 'unknown' }
  }
  const locked = async run => {
    let intent
    try {
      current()
      if (!locks?.request || !storage || !draftStorage || !crypto?.subtle || !crypto?.randomUUID) throw new Error('Checkout belum tersedia pada browser ini.')
      return await locks.request(key, { mode: 'exclusive', ifAvailable: true }, async lock => {
        if (!lock) return { ok: false, busy: true, error: 'Checkout masih diproses di tab lain.' }
        current(); intent = read()
        return run(intent, value => { intent = value })
      })
    } catch (error) { return intent ? uncertain(intent.operationId) : { ok: false, error: error.message || 'Checkout belum dapat diproses.' } }
  }
  const dispatch = async (request, existing, track, checked = false) => {
    const fingerprint = await hash(request)
    current()
    if (existing && existing.fingerprint !== fingerprint) return uncertain(existing.operationId)
    if (existing && !checked) { const result = await status(existing); if (!result.unknown) return result }
    const intent = existing || { actorId, operationId: crypto.randomUUID(), bookId: request.bookId, fingerprint }
    const draft = JSON.stringify({ operationId: intent.operationId, request })
    draftStorage.setItem(key, draft)
    if (draftStorage.getItem(key) !== draft) throw new Error('Draft checkout belum tersimpan.')
    storage.setItem(key, JSON.stringify(intent)); track(intent)
    if (storage.getItem(key) !== JSON.stringify(intent)) return uncertain(intent.operationId)
    current()
    const response = await client.rpc('pos_checkout', { p_operation_id: intent.operationId, p_request: request })
    current()
    if (response?.error) {
      if (!existing && rollback.has(response.error.code)) {
        clear()
        if (storage.getItem(key) !== null) return uncertain(intent.operationId)
        return { ok: false, error: 'Checkout ditolak dan tidak disimpan. Periksa barang, pelanggan dan akses Book.' }
      }
      return uncertain(intent.operationId)
    }
    return complete(intent, response?.data)
  }
  return {
    pending() { current(); return read() },
    submit(value) {
      let request
      try { request = normalizeCheckoutRequest(value) } catch (error) { return Promise.resolve({ ok: false, error: error.message }) }
      return locked((intent, track) => dispatch(request, intent, track))
    },
    reconcile: () => locked(intent => intent ? status(intent) : { ok: false, error: 'Tidak ada checkout tertunda.' }),
    abandon: () => locked(async intent => {
      if (!intent) return { ok: false, error: 'Tidak ada checkout tertunda.' }
      current()
      const response = await client.rpc('pos_abandon_checkout', { p_operation_id: intent.operationId, p_book_id: intent.bookId })
      current()
      return response?.error ? uncertain(intent.operationId) : complete(intent, response?.data)
    }),
    resume: () => locked(async (intent, track) => {
      if (!intent) return { ok: false, error: 'Tidak ada checkout tertunda.' }
      const result = await status(intent)
      if (!result.unknown) return result
      const draft = JSON.parse(draftStorage.getItem(key) || 'null')
      if (draft?.operationId !== intent.operationId) return { ...result, error: 'Draft asli tidak tersedia. Batalkan checkout tertunda sebelum membuat nota baru.' }
      return dispatch(normalizeCheckoutRequest(draft.request), intent, track, true)
    }),
  }
}
