const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const kinds = ['edit', 'cancel', 'void_error', 'refund']
const rollbackCodes = new Set(['22007', '22008', '22023', '23514', '42501', '40001', '55000', '25000'])
const uncertain = operationId => ({ ok: false, needsReconciliation: true, operationId,
  error: 'Hasil belum dapat dipastikan. Periksa status sebelum mengirim perubahan lain.' })

function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  }
  throw new Error('Data perubahan invoice tidak valid.')
}

function validReceipt(data, intent) {
  if (!data || data.operationId !== intent.operationId || data.invoiceId !== intent.invoiceId
    || data.version !== intent.expectedVersion + 1 || typeof data.invoiceNo !== 'string' || !data.invoiceNo
    || !['active', 'cancelled', 'voided'].includes(data.state)
    || !['total', 'paid', 'remaining', 'refundDue'].every(key => Number.isSafeInteger(data[key]) && data[key] >= 0)) return false
  if (intent.kind === 'edit' && data.state !== 'active') return false
  if (intent.kind === 'cancel' && data.state !== 'cancelled') return false
  if (intent.kind === 'void_error' && data.state !== 'voided') return false
  if (data.state === 'voided') return data.paid === 0 && data.remaining === 0 && data.refundDue === 0
  if (data.state === 'cancelled') return data.remaining === 0 && data.refundDue === data.paid
  return data.remaining === Math.max(0, data.total - data.paid) && data.refundDue === Math.max(0, data.paid - data.total)
}

// The caller supplies a session-bound data client; local identity is never sent as authority.
export function createInvoiceChangeClient({ client, scope, actorId, isCurrent, storage = globalThis.localStorage,
  draftStorage = globalThis.sessionStorage, locks = globalThis.navigator?.locks, crypto = globalThis.crypto }) {
  const prefix = `skupy:invoice-operation:v1:${encodeURIComponent(scope)}:${encodeURIComponent(actorId)}:`
  const keyFor = id => `${prefix}${id}`
  const clear = key => { draftStorage?.removeItem(key); storage.removeItem(key) }
  const assertCurrent = () => {
    if (typeof scope !== 'string' || !scope || !actorId || !isCurrent()) throw new Error('Sesi berubah. Masuk kembali sebelum melanjutkan.')
  }
  const read = (key, invoiceId) => {
    const raw = storage.getItem(key)
    if (raw === null) return null
    const value = JSON.parse(raw)
    if (value?.actorId !== actorId || value.invoiceId !== invoiceId || !uuid.test(value.operationId)
      || !Number.isSafeInteger(value.expectedVersion) || value.expectedVersion < 0 || !kinds.includes(value.kind)
      || !/^[a-f0-9]{64}$/.test(value.fingerprint)) throw new Error('Catatan permintaan perlu diperiksa sebelum melanjutkan.')
    return value
  }
  const complete = (key, intent, data) => {
    assertCurrent()
    if (!validReceipt(data, intent)) return uncertain(intent.operationId)
    clear(key)
    if (storage.getItem(key) !== null) return uncertain(intent.operationId)
    return { ok: true, data }
  }
  const status = async (key, intent) => {
    assertCurrent()
    const response = await client.rpc('pos_invoice_change_status', { p_operation_id: intent.operationId })
    assertCurrent()
    if (response?.error) return uncertain(intent.operationId)
    if (response?.data?.state === 'complete') return complete(key, intent, response.data.result)
    if (response?.data?.state === 'unknown') return { ...uncertain(intent.operationId), unknown: true }
    return uncertain(intent.operationId)
  }
  const locked = async (invoiceId, run) => {
    let intent
    try {
      assertCurrent()
      if (!uuid.test(invoiceId) || !locks?.request || !storage || !crypto?.subtle || !crypto?.randomUUID) {
        throw new Error('Perubahan invoice belum tersedia pada sesi atau browser ini.')
      }
      const key = keyFor(invoiceId)
      return await locks.request(key, { mode: 'exclusive', ifAvailable: true }, async lock => {
        if (!lock) return { ok: false, busy: true, error: 'Invoice sedang diproses di tab lain.' }
        assertCurrent()
        intent = read(key, invoiceId)
        return await run(key, intent, value => { intent = value })
      })
    } catch (error) {
      return intent ? uncertain(intent.operationId) : { ok: false, error: error?.message || 'Permintaan tidak dapat diproses.' }
    }
  }
  const changeRequest = async (request, key, existing, track) => {
      const { invoiceId, expectedVersion, kind, payload } = request
      if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0 || expectedVersion === Number.MAX_SAFE_INTEGER
        || !kinds.includes(kind) || !payload || Array.isArray(payload) || typeof payload !== 'object') {
        throw new Error('Data perubahan invoice tidak valid.')
      }
      // Snapshot before awaiting: a caller cannot change the request after it is fingerprinted.
      const serialized = canonical({ invoiceId, expectedVersion, kind, payload })
      const snapshot = JSON.parse(serialized)
      const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serialized))
      const fingerprint = Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('')
      assertCurrent()
      if (existing && existing.fingerprint !== fingerprint) return uncertain(existing.operationId)
      if (existing) {
        const result = await status(key, existing)
        if (!result.unknown) return result
      }
      const intent = existing || { actorId, invoiceId, expectedVersion, kind, fingerprint, operationId: crypto.randomUUID() }
      if (!uuid.test(intent.operationId)) throw new Error('Identitas permintaan tidak valid.')
      // Exact replay survives reload in this tab; shared localStorage has no customer payload.
      if (draftStorage) {
        const draft = JSON.stringify({ operationId: intent.operationId, request: snapshot })
        draftStorage.setItem(key, draft)
        if (draftStorage.getItem(key) !== draft) throw new Error('Draft pemulihan belum dapat disimpan.')
      }
      storage.setItem(key, JSON.stringify(intent))
      track(intent)
      if (storage.getItem(key) !== JSON.stringify(intent)) return uncertain(intent.operationId)
      assertCurrent()
      const response = await client.rpc('pos_apply_invoice_change', { p_operation_id: intent.operationId,
        p_invoice_id: invoiceId, p_expected_version: expectedVersion, p_kind: kind, p_payload: snapshot.payload })
      assertCurrent()
      if (response?.error) {
        // This marker is emitted only after the server holds the operation lock,
        // has ruled out a committed replay, and rejects the stale version.
        const rejectedRevision = response.error.code === '40001' && response.error.hint === 'invoice_revision_conflict'
          && response.error.details === intent.operationId
        if ((!existing && rollbackCodes.has(response.error.code)) || rejectedRevision) {
          clear(key)
          if (storage.getItem(key) !== null) return uncertain(intent.operationId)
          return { ok: false, needsRefresh: response.error.code === '40001', error: response.error.code === '40001'
            ? 'Invoice sudah berubah. Muat ulang sebelum mengedit lagi.' : 'Perubahan ditolak dan tidak disimpan. Periksa data serta akses invoice.' }
        }
        return uncertain(intent.operationId)
      }
      return complete(key, intent, response?.data)
  }
  return {
    pending: () => {
      assertCurrent()
      const rows = []
      for (let index = 0; index < storage.length; index++) {
        const key = storage.key(index)
        if (key?.startsWith(prefix)) {
          const invoiceId = key.slice(prefix.length)
          const intent = read(key, invoiceId)
          if (intent) rows.push({ invoiceId, kind: intent.kind, operationId: intent.operationId })
        }
      }
      return rows
    },
    reconcile: invoiceId => locked(invoiceId, (key, intent) => intent
      ? status(key, intent) : { ok: false, pending: false, error: 'Tidak ada permintaan tertunda pada akun ini.' }),
    change: request => locked(request?.invoiceId, (key, existing, track) => changeRequest(request, key, existing, track)),
    resume: invoiceId => locked(invoiceId, async (key, existing, track) => {
      if (!existing) return { ok: false, pending: false, error: 'Tidak ada permintaan tertunda pada akun ini.' }
      const result = await status(key, existing)
      if (!result.unknown) return result
      const saved = JSON.parse(draftStorage?.getItem(key) || 'null')
      if (!saved || saved.operationId !== existing.operationId || saved.request?.invoiceId !== invoiceId) {
        return { ...result, unknown: false, error: 'Draft asli tidak tersedia di tab ini. Buka tab asal untuk mengulang; status tetap dapat diperiksa.' }
      }
      return changeRequest(saved.request, key, existing, track)
    }),
  }
}
