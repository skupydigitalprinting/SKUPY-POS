import React, { useRef, useState } from 'react'
import { Trash2 } from 'lucide-react'
import Modal from './Modal'
import { Button, Textarea } from './ui'
import { formatCurrency } from '../utils/helpers'
import { validateInvoiceRemoval } from '../utils/invoiceDraft'

export default function InvoiceDeleteDialog({ invoice, onClose, onConfirm }) {
  const [kind, setKind] = useState('cancel')
  const [reason, setReason] = useState('')
  const [noRealMoney, setNoRealMoney] = useState(false)
  const [pending, setPending] = useState(false)
  const [uncertain, setUncertain] = useState(false)
  const [error, setError] = useState('')
  const submitting = useRef(false)
  const close = () => { if (!submitting.current) onClose?.() }
  async function submit(event) {
    event.preventDefault()
    if (submitting.current || uncertain || !onConfirm) return
    let payload
    try { payload = validateInvoiceRemoval(invoice, kind, reason, noRealMoney) }
    catch (error) { setError(error.message); return }
    submitting.current = true; setPending(true); setError('')
    try {
      const result = await onConfirm(kind, payload)
      if (result?.ok !== true) {
        setUncertain(result?.needsReconciliation === true || !result)
        setError(result?.error || 'Hasil penghapusan belum terkonfirmasi. Periksa status sebelum mengulangi.')
      } else onClose?.()
    } catch {
      setUncertain(true)
      setError('Hasil penghapusan belum terkonfirmasi. Periksa status sebelum mengulangi.')
    } finally { submitting.current = false; setPending(false) }
  }
  return <Modal open title="Hapus Invoice" subtitle={invoice.invoiceNo} onClose={close} lockClose={pending}>
    <form onSubmit={submit} aria-label="Hapus Invoice" className="space-y-4" style={{ color: 'var(--text-primary)' }}>
      <dl className="space-y-2 text-sm">
        {[[ 'Total invoice', invoice.total ], [ 'Pembayaran diterima', invoice.paid ], [ 'Sisa tagihan', invoice.remaining ]].map(([label, value]) =>
          <div key={label} className="flex justify-between flex-wrap gap-2"><dt>{label}</dt><dd>Rp{formatCurrency(value) || '0'}</dd></div>)}
      </dl>
      <fieldset disabled={pending || uncertain} className="space-y-3 min-w-0">
        <legend className="text-sm font-semibold mb-2">Jenis penghapusan</legend>
        <label className="flex gap-2 items-start text-sm"><input type="radio" name="removal-kind" checked={kind === 'cancel'} onChange={() => setKind('cancel')} />Pesanan tidak jadi</label>
        <label className="flex gap-2 items-start text-sm"><input type="radio" name="removal-kind" checked={kind === 'void_error'} onChange={() => setKind('void_error')} />Salah input / duplikat</label>
        {invoice.paid > 0 && (kind === 'cancel'
          ? <p className="text-sm" style={{ color: 'var(--amber)' }}>Perlu refund: Rp{formatCurrency(invoice.paid)}. Penghapusan tidak mentransfer uang dan belum mencatat refund.</p>
          : <label className="flex gap-2 items-start text-sm"><input type="checkbox" checked={noRealMoney} onChange={event => setNoRealMoney(event.target.checked)} />Tidak ada uang nyata yang diterima pada nota ini; catatan pembayarannya salah.</label>)}
        <Textarea label="Alasan penghapusan" aria-label="Alasan penghapusan" value={reason} required maxLength={1000} onChange={event => setReason(event.target.value)} />
      </fieldset>
      <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>Invoice dikeluarkan dari daftar dan omzet aktif. Nomor invoice tidak dipakai ulang.</p>
      {error && <p role="alert" className="text-sm" style={{ color: 'var(--red)' }}>{error}</p>}
      <div className="flex justify-end gap-2 flex-wrap">
        <Button type="button" variant="secondary" onClick={close} disabled={pending}>Batal</Button>
        <Button type="submit" variant="danger" disabled={pending || uncertain || !onConfirm}><Trash2 size={16} />{pending ? 'Menghapus...' : 'Hapus Invoice'}</Button>
      </div>
    </form>
  </Modal>
}
