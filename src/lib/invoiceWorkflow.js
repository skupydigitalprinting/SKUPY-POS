const unavailable = () => ({ ok: false, error: 'Edit/hapus invoice belum diaktifkan pada server dan sesi login ini. Tidak ada perubahan yang disimpan.' })

// Shared by Order and Dashboard. Never fall back to sequential legacy writes.
export function createInvoiceWorkflow({ enabled, isCurrent, operations, readInvoice, invalidate, refresh, onSettled = () => {} }) {
  const available = () => enabled && isCurrent()
  async function finish(result) {
    onSettled()
    if (!available()) return { ok: false, needsReconciliation: true, error: 'Sesi berubah. Periksa status dengan akun semula.' }
    if (result?.ok !== true) return result
    invalidate()
    try {
      await refresh()
      if (!available()) throw new Error('Sesi berubah')
      return result
    } catch {
      return { ok: false, committed: true, needsRefresh: true, data: result.data,
        error: 'Perubahan sudah tersimpan. Tampilan belum diperbarui; muat ulang data tanpa mengirim perubahan lagi.' }
    }
  }
  return {
    pending: () => available() ? operations?.pending?.() || [] : [],
    async load(id) {
      if (!available()) return unavailable()
      try {
        const data = await readInvoice(id)
        if (!available()) return unavailable()
        if (!data || data.id !== id || !Number.isSafeInteger(data.version) || data.version < 0 || data.deletedAt
          || ['dibatalkan', 'cancelled', 'canceled', 'batal'].includes(String(data.orderStatus || '').trim().toLowerCase())
          || ['dibatalkan', 'cancelled', 'canceled', 'batal'].includes(String(data.status || '').trim().toLowerCase())) {
          return { ok: false, error: 'Invoice tidak tersedia atau versi server belum mendukung perubahan invoice.' }
        }
        return { ok: true, data }
      } catch { return { ok: false, error: 'Invoice belum dapat dimuat. Coba lagi setelah koneksi pulih.' } }
    },
    async change(invoiceId, expectedVersion, kind, payload) {
      if (!available()) return unavailable()
      return finish(await operations.change({ invoiceId, expectedVersion, kind, payload }))
    },
    async reconcile(id) {
      if (!available()) return unavailable()
      return finish(await operations.reconcile(id))
    },
    async resume(id) {
      if (!available()) return unavailable()
      return finish(await operations.resume(id))
    },
    async refresh() {
      if (!available()) return unavailable()
      try { await refresh(); return available() ? { ok: true } : unavailable() }
      catch { return { ok: false, error: 'Data belum dapat diperbarui. Coba muat ulang lagi.' } }
    },
  }
}
