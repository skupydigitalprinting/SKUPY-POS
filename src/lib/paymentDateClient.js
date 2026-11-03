import { paymentDay, validPaymentDay } from '../utils/paymentDates.js'

export function createPaymentDateClient({ client, scope, isCurrent, storage = globalThis.sessionStorage, crypto = globalThis.crypto }) {
  const current = () => { if (!scope || !isCurrent?.()) throw new Error('Sesi berubah. Muat ulang sebelum mengedit tanggal.') }
  return {
    async edit(payment, fields) {
      try {
        current()
        const reason = String(fields.reason || '').trim()
        if (!payment?.id || !payment.paid_at || !validPaymentDay(fields.paymentDate) || fields.paymentDate > paymentDay()
          || !reason || reason.length > 1000) throw new Error('Isi tanggal pembayaran yang valid dan alasan koreksi.')
        const args = { p_payment_id: payment.id, p_expected_paid_at: payment.paid_at,
          p_payment_date: fields.paymentDate, p_reason: reason }
        const key = `skupy:payment-date:v1:${encodeURIComponent(scope)}:${payment.id}`
        const fingerprint = JSON.stringify(args)
        const saved = JSON.parse(storage.getItem(key) || 'null')
        // Preserve the operation identity when retrying a response lost in transit.
        const operation = saved?.fingerprint === fingerprint ? saved.operation : crypto.randomUUID()
        storage.setItem(key, JSON.stringify({ operation, fingerprint }))
        current()
        const response = await client.rpc('pos_change_payment_date', { p_operation_id: operation, ...args })
        current()
        if (response.error) {
          if (response.error.code === '40001') throw new Error('Tanggal telah berubah. Muat ulang riwayat sebelum mengedit lagi.')
          if (response.error.code === '42501') throw new Error('Akun ini tidak memiliki akses koreksi pembayaran tersebut.')
          if (response.error.code === '22023') throw new Error('Periksa tanggal pembayaran: tidak boleh sebelum tanggal invoice atau melebihi hari ini. Alasan koreksi juga wajib diisi.')
          throw new Error('Tanggal belum dapat dikoreksi. Catatan lama ini mungkin memerlukan pencocokan dengan buku kas terlebih dahulu.')
        }
        if (response.data?.payment_id !== payment.id || paymentDay(response.data?.paid_at) !== fields.paymentDate
          || !response.data?.recorded_at) throw new Error('Hasil koreksi belum terkonfirmasi. Muat ulang riwayat untuk memeriksa tanggal.')
        storage.removeItem(key)
        return { ok: true, data: response.data }
      } catch (error) {
        return { ok: false, error: error.message === 'Failed to fetch' || error.message === 'Lost response'
          ? 'Koneksi terputus. Muat ulang riwayat untuk memeriksa tanggal sebelum mencoba lagi.'
          : error.message || 'Tanggal pembayaran belum dapat disimpan.' }
      }
    },
  }
}
