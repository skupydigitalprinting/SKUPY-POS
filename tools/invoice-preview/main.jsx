import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Pencil, Trash2 } from 'lucide-react'
import InvoiceEditor from '../../src/components/InvoiceEditor'
import InvoiceDeleteDialog from '../../src/components/InvoiceDeleteDialog'
import { Button, ProductImage } from '../../src/components/ui'
import { calculateInvoiceChange } from '../../src/utils/invoiceChanges'
import { formatCurrency } from '../../src/utils/helpers'
import '../../src/index.css'

// Synthetic browser-only workflow. No data client, session, RPC or external write.
const original = { id: 'synthetic-invoice', invoiceNo: 'UJI-001', customer: 'Pelanggan Uji', version: 0,
  total: 2000000, paid: 200000, remaining: 1800000, discount: 0, tax: 0, notes: '', dueDate: '',
  items: [{ productId: 'shirt', name: 'Kaos Custom', qty: 20, price: 100000, unit: 'pcs' }] }
const products = [{ id: 'shirt', name: 'Kaos Custom', price: 100000, unit: 'pcs' },
  { id: 'flag', name: 'Bendera', price: 20000, unit: 'meter' }]
const outcome = new URLSearchParams(location.search).get('outcome')
function Preview() {
  const [invoice, setInvoice] = useState(original)
  const [view, setView] = useState(null)
  const [message, setMessage] = useState('')
  async function result() {
    if (outcome === 'throw') throw new Error('Synthetic lost response')
    if (outcome === 'uncertain') return { ok: false, needsReconciliation: true, error: 'Status simulasi belum terkonfirmasi.' }
    if (outcome === 'reject') return { ok: false, error: 'Invoice sudah berubah. Muat data terbaru.' }
    return { ok: true }
  }
  async function edit(payload) {
    const status = await result()
    if (!status.ok) return status
    const values = calculateInvoiceChange({ ...payload, tax: invoice.tax, paid: invoice.paid })
    setInvoice({ ...invoice, ...values, customer: payload.customerName, notes: payload.notes,
      dueDate: payload.due_date, version: invoice.version + 1 })
    setMessage('Perubahan simulasi tersimpan')
    return status
  }
  async function remove(kind) {
    const status = await result()
    if (!status.ok) return status
    setMessage(kind === 'cancel' ? 'Invoice simulasi dihapus. Perlu refund: Rp200.000.' : 'Nota simulasi salah input dihapus.')
    setInvoice(null)
    return status
  }
  return <main className="p-4 sm:p-8 max-w-4xl mx-auto space-y-5">
    <header className="flex justify-between gap-3 flex-wrap"><h1 className="text-xl font-bold">SKUPY POS</h1><span>Data uji lokal</span></header>
    <section><h2 className="text-sm">Omzet aktif</h2><p className="text-2xl font-semibold" data-testid="turnover">Rp{formatCurrency(10000000 + (invoice?.total || 0))}</p></section>
    {invoice && <section className="border-y py-4 flex gap-4 items-center flex-wrap" style={{ borderColor: 'var(--border)' }}>
      <div className="w-16 h-16 overflow-hidden rounded-lg"><ProductImage alt="Kaos Custom" /></div>
      <div className="flex-1 min-w-0"><h2 className="font-bold">{invoice.invoiceNo}</h2><p>{invoice.customer}</p><p>Rp{formatCurrency(invoice.total)}</p></div>
      <Button onClick={() => setView('edit')}><Pencil size={16} />Edit Invoice</Button>
      <Button variant="danger" onClick={() => setView('delete')}><Trash2 size={16} />Hapus Invoice</Button>
    </section>}
    {message && <p role="status">{message}</p>}
    {invoice && view === 'edit' && <InvoiceEditor key={invoice.version} invoice={invoice} products={products} onClose={() => setView(null)} onSave={edit} />}
    {invoice && view === 'delete' && <InvoiceDeleteDialog invoice={invoice} onClose={() => setView(null)} onConfirm={remove} />}
  </main>
}
createRoot(document.getElementById('root')).render(<Preview />)
