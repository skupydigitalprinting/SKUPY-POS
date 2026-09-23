import React, { useMemo, useRef, useState } from 'react'
import { Plus, Save, Trash2 } from 'lucide-react'
import Modal from './Modal'
import { Button, Input, Textarea } from './ui'
import { formatCurrency } from '../utils/helpers'
import { createInvoiceDraft, quoteInvoiceDraft, validateInvoiceDraft } from '../utils/invoiceDraft'

// Mount with key={invoice.id + ':' + invoice.version} when refreshing a stale form.
export default function InvoiceEditor({ invoice, products = [], onClose, onSave }) {
  const [draft, setDraft] = useState(() => createInvoiceDraft(invoice))
  const [productId, setProductId] = useState('')
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const [uncertain, setUncertain] = useState(false)
  const submitting = useRef(false)
  const quote = useMemo(() => {
    try { return { value: quoteInvoiceDraft(invoice, draft) } }
    catch (error) { return { error: error.message } }
  }, [invoice, draft])
  const set = (field, value) => setDraft(current => ({ ...current, [field]: value }))
  const editLine = (index, field, value) => setDraft(current => ({ ...current,
    items: current.items.map((item, i) => i === index ? { ...item, [field]: value } : item) }))
  const close = () => { if (!submitting.current) onClose?.() }
  function addProduct() {
    const product = products.find(item => String(item.id) === productId)
    if (!product) return
    setDraft(current => ({ ...current, items: [...current.items, {
      productId: product.id, name: product.name, qty: '1', price: String(product.price), unit: product.unit || 'pcs',
    }] }))
    setProductId('')
  }
  async function submit(event) {
    event.preventDefault()
    if (submitting.current || uncertain || !onSave) return
    let payload
    try { payload = validateInvoiceDraft(invoice, draft).payload }
    catch (error) { setError(error.message); return }
    submitting.current = true; setPending(true); setError('')
    try {
      const result = await onSave(payload)
      if (result?.ok !== true) {
        setUncertain(result?.needsReconciliation === true || !result)
        setError(result?.error || 'Hasil penyimpanan belum terkonfirmasi. Periksa status sebelum mengulangi.')
      } else onClose?.()
    } catch {
      setUncertain(true)
      setError('Hasil penyimpanan belum terkonfirmasi. Periksa status sebelum mengulangi.')
    } finally { submitting.current = false; setPending(false) }
  }
  const locked = pending || uncertain
  return <Modal open title="Edit Invoice" subtitle={invoice.invoiceNo} onClose={close} size="lg" mobileFull lockClose={pending}>
    <form onSubmit={submit} aria-label="Edit Invoice" className="space-y-4" style={{ color: 'var(--text-primary)' }}>
      <fieldset disabled={locked} className="space-y-4 min-w-0">
        <Input label="Nama pelanggan" aria-label="Nama pelanggan" value={draft.customerName}
          maxLength={256} onChange={event => set('customerName', event.target.value)} />
        <div className="flex items-end gap-2 min-w-0">
          <label className="text-xs flex-1 min-w-0">Tambah produk
            <select aria-label="Tambah produk" value={productId} onChange={event => setProductId(event.target.value)}
              className="w-full mt-1 p-2.5 rounded-lg text-sm" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
              <option value="">Pilih produk</option>
              {products.filter(product => !product.deletedAt && !product.deleted_at).map(product =>
                <option key={product.id} value={product.id}>{product.name}</option>)}
            </select>
          </label>
          <Button type="button" variant="secondary" disabled={!productId} onClick={addProduct}
            title="Tambah produk" aria-label="Tambahkan produk"><Plus size={18} /></Button>
        </div>
        <div className="divide-y" style={{ borderColor: 'var(--border)' }}>
          {draft.items.map((item, index) => <div key={index} className="py-3 space-y-2" style={{ borderColor: 'var(--border)' }}>
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold text-sm break-words min-w-0">{item.name}</span>
              <Button type="button" variant="ghost" size="sm" onClick={() => set('items', draft.items.filter((_, i) => i !== index))}
                title={`Hapus barang ${index + 1}`} aria-label={`Hapus barang ${index + 1}`}><Trash2 size={16} /></Button>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Input label={`Jumlah (${item.unit})`} aria-label={`Jumlah barang ${index + 1}`} inputMode={item.unit === 'pcs' ? 'numeric' : 'decimal'}
                value={item.qty} onChange={event => editLine(index, 'qty', event.target.value)} />
              <Input label="Harga satuan" prefix="Rp" inputMode="numeric" aria-label={`Harga barang ${index + 1}`} value={item.price}
                onChange={event => editLine(index, 'price', event.target.value)} />
            </div>
          </div>)}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Input label="Diskon" prefix="Rp" inputMode="numeric" aria-label="Diskon" value={draft.discount} onChange={event => set('discount', event.target.value)} />
          <Input label="Jatuh tempo" aria-label="Jatuh tempo" type="date" value={draft.dueDate} onChange={event => set('dueDate', event.target.value)} />
        </div>
        <Textarea label="Catatan pesanan" aria-label="Catatan pesanan" value={draft.notes} maxLength={4000} onChange={event => set('notes', event.target.value)} />
        <Textarea label="Alasan perubahan" aria-label="Alasan perubahan" required value={draft.reason} maxLength={1000} onChange={event => set('reason', event.target.value)} />
      </fieldset>
      {quote.value && <dl className="space-y-2 text-sm border-t pt-3" style={{ borderColor: 'var(--border)' }}>
        {[[ 'Subtotal', quote.value.subtotal ], [ 'Pajak tersimpan', quote.value.tax ], [ 'Total invoice', quote.value.total ],
          [ 'Pembayaran diterima', quote.value.paid ], [ 'Sisa tagihan', quote.value.remaining ],
          ...(quote.value.overpaid ? [[ 'Kelebihan bayar', quote.value.overpaid ]] : [])].map(([label, value]) =>
          <div key={label} className="flex justify-between gap-3 flex-wrap"><dt>{label}</dt><dd className="font-semibold">Rp{formatCurrency(value) || '0'}</dd></div>)}
      </dl>}
      {(error || quote.error) && <p role="alert" className="text-sm" style={{ color: 'var(--red)' }}>{error || quote.error}</p>}
      <div className="flex justify-end gap-2 flex-wrap">
        <Button type="button" variant="secondary" onClick={close} disabled={pending}>Batal</Button>
        <Button type="submit" disabled={locked || !!quote.error || !onSave}><Save size={16} />{pending ? 'Menyimpan...' : 'Simpan Perubahan'}</Button>
      </div>
    </form>
  </Modal>
}
