const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const rollback = new Set(['22023', '23514', '42501', '40001', '25000'])
const uncertain = operationId => ({ ok: false, needsReconciliation: true, operationId,
  error: 'Status pembayaran belum pasti. Periksa status sebelum mencatat pembayaran lagi.' })

function normalized(value) {
  if (!value || typeof value.invoiceNo !== 'string' || !value.invoiceNo.trim() || value.invoiceNo.trim().length > 256
    || !Number.isSafeInteger(value.amount) || value.amount <= 0 || !['cash', 'transfer', 'qris'].includes(value.method)
    || typeof value.notes !== 'string' || value.notes.length > 4000) throw new Error('Data pembayaran tidak valid.')
  return { invoiceNo: value.invoiceNo.trim(), amount: value.amount, method: value.method, notes: value.notes }
}

export function createPaymentClient({ client, scope, actorId, isCurrent, storage = globalThis.localStorage,
  draftStorage = globalThis.sessionStorage, locks = globalThis.navigator?.locks, crypto = globalThis.crypto }) {
  const prefix = `skupy:payment-operation:v1:${encodeURIComponent(scope)}:${encodeURIComponent(actorId)}:`
  const keyFor = invoiceNo => prefix + encodeURIComponent(invoiceNo)
  const current = () => {
    if (!scope || !actorId || !isCurrent?.()) throw new Error('Sesi berubah. Periksa dengan akun semula.')
  }
  const hash = async request => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',
    new TextEncoder().encode(JSON.stringify(normalized(request))))), byte => byte.toString(16).padStart(2, '0')).join('')
  const read = (key, invoiceNo) => {
    const raw = storage.getItem(key)
    if (raw === null) return null
    const value = JSON.parse(raw)
    if (value.actorId !== actorId || value.invoiceNo !== invoiceNo || !uuid.test(value.operationId)
      || !/^[a-f0-9]{64}$/.test(value.fingerprint)) throw new Error('Catatan pembayaran perlu diperiksa.')
    return value
  }
  const clear = key => { draftStorage.removeItem(key); storage.removeItem(key) }
  const complete = async (key, intent, envelope) => {
    current()
    const result = envelope?.result
    if (envelope?.state !== 'complete' || envelope.operationId !== intent.operationId
      || envelope.request?.invoiceNo !== intent.invoiceNo || result?.invoice_no !== intent.invoiceNo
      || result?.amount !== envelope.request?.amount || !['amount', 'paid', 'remaining'].every(k => Number.isSafeInteger(result?.[k]) && result[k] >= 0)
      || result.amount <= 0 || result.paid < result.amount || !Number.isSafeInteger(result.paid + result.remaining)
      || result.status !== (result.remaining === 0 ? 'lunas' : 'aktif')
      || await hash(envelope.request) !== intent.fingerprint) return uncertain(intent.operationId)
    current()
    clear(key)
    if (storage.getItem(key) !== null) return uncertain(intent.operationId)
    return { ok: true, data: result }
  }
  const status = async (key, intent) => {
    current()
    const response = await client.rpc('pos_payment_status', { p_operation_id: intent.operationId })
    current()
    if (response?.error) return uncertain(intent.operationId)
    if (response?.data?.state === 'complete') return complete(key, intent, response.data)
    return { ...uncertain(intent.operationId), unknown: response?.data?.state === 'unknown' }
  }
  const locked = async (invoiceNo, run) => {
    let intent
    try {
      current()
      if (typeof invoiceNo !== 'string' || !invoiceNo || invoiceNo.length > 256 || !locks?.request
        || !storage || !draftStorage || !crypto?.subtle || !crypto?.randomUUID) throw new Error('Pembayaran belum tersedia pada browser ini.')
      const key = keyFor(invoiceNo)
      return await locks.request(key, { mode: 'exclusive', ifAvailable: true }, async lock => {
        if (!lock) return { ok: false, busy: true, error: 'Pembayaran invoice sedang diproses di tab lain.' }
        current()
        intent = read(key, invoiceNo)
        return run(key, intent, value => { intent = value })
      })
    } catch (error) { return intent ? uncertain(intent.operationId) : { ok: false, error: error.message || 'Pembayaran belum dapat diproses.' } }
  }
  const dispatch = async (request, key, existing, track, alreadyChecked = false) => {
    const fingerprint = await hash(request)
    current()
    if (existing && existing.fingerprint !== fingerprint) return uncertain(existing.operationId)
    if (existing && !alreadyChecked) {
      const checked = await status(key, existing)
      if (!checked.unknown) return checked
    }
    const intent = existing || { actorId, invoiceNo: request.invoiceNo, fingerprint, operationId: crypto.randomUUID() }
    if (!uuid.test(intent.operationId)) throw new Error('Identitas pembayaran tidak valid.')
    const draft = JSON.stringify({ operationId: intent.operationId, request })
    draftStorage.setItem(key, draft)
    if (draftStorage.getItem(key) !== draft) throw new Error('Draft pembayaran belum tersimpan.')
    storage.setItem(key, JSON.stringify(intent))
    track(intent)
    if (storage.getItem(key) !== JSON.stringify(intent)) return uncertain(intent.operationId)
    current()
    const response = await client.rpc('pos_submit_payment', { p_operation_id: intent.operationId,
      p_invoice_no: request.invoiceNo, p_amount: request.amount, p_method: request.method, p_notes: request.notes })
    current()
    if (response?.error) {
      if (!existing && rollback.has(response.error.code)) {
        clear(key)
        if (storage.getItem(key) !== null) return uncertain(intent.operationId)
        return { ok: false, error: 'Pembayaran ditolak dan tidak disimpan. Periksa saldo dan akses invoice.' }
      }
      return uncertain(intent.operationId)
    }
    return complete(key, intent, response?.data)
  }
  return {
    pending() {
      current()
      const list = []
      for (let index = 0; index < storage.length; index++) {
        const key = storage.key(index)
        if (key?.startsWith(prefix)) {
          const invoiceNo = decodeURIComponent(key.slice(prefix.length)), intent = read(key, invoiceNo)
          if (intent) list.push({ invoiceNo, operationId: intent.operationId })
        }
      }
      return list
    },
    submit(value) {
      let request
      try { request = normalized(value) } catch (error) { return Promise.resolve({ ok: false, error: error.message }) }
      return locked(request.invoiceNo, (key, intent, track) => dispatch(request, key, intent, track))
    },
    reconcile: invoiceNo => locked(invoiceNo, (key, intent) => intent ? status(key, intent)
      : { ok: false, error: 'Tidak ada pembayaran tertunda.' }),
    resume: invoiceNo => locked(invoiceNo, async (key, intent, track) => {
      if (!intent) return { ok: false, error: 'Tidak ada pembayaran tertunda.' }
      const checked = await status(key, intent)
      if (!checked.unknown) return checked
      const draft = JSON.parse(draftStorage.getItem(key) || 'null')
      if (draft?.operationId !== intent.operationId || draft.request?.invoiceNo !== invoiceNo) {
        return { ...checked, unknown: false, error: 'Draft asli tidak tersedia. Periksa status atau buka tab asal.' }
      }
      return dispatch(normalized(draft.request), key, intent, track, true)
    }),
  }
}
