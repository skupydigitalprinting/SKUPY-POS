import React, { useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import Order from '../../src/pages/Order'
import { createInvoiceWorkflow } from '../../src/lib/invoiceWorkflow'
import { calculateInvoiceChange } from '../../src/utils/invoiceChanges'

// Real Order component, synthetic transport and customers only. No Supabase client.
const initial = { id: 'synthetic-order', invoiceNo: 'UJI-ORDER-001', customer: 'Pelanggan Uji', version: 0,
  subtotal: 2000000, total: 2000000, paid: 200000, dp: 200000, remaining: 1800000, discount: 0, tax: 0,
  notes: '', dueDate: '', date: new Date().toISOString(), cashierId: 'cashier', cashier: 'Kasir Uji',
  status: 'pending', orderStatus: 'menunggu', paymentMethod: 'cash',
  items: [{ productId: 'shirt', name: 'Kaos Custom', qty: 20, price: 100000, unit: 'pcs' }] }
function Preview() {
  const outcome = new URLSearchParams(location.search).get('outcome')
  const pendingDeleted = outcome === 'pending-deleted'
  const saved = useRef(pendingDeleted ? { ...initial, deletedAt: new Date().toISOString() } : structuredClone(initial))
  const [rows, setRows] = useState(pendingDeleted ? [] : [initial])
  const [revision, setRevision] = useState(0)
  const [message, setMessage] = useState('')
  const uncertain = useRef(false)
  const receipt = useRef(pendingDeleted ? { ok: true, data: { invoiceId: initial.id, state: 'cancelled' } } : null)
  const unresolved = useRef(pendingDeleted)
  const pendingChanges = () => unresolved.current ? [{ invoiceId: initial.id, kind: 'cancel', operationId: 'synthetic-pending' }] : []
  const workflow = useMemo(() => createInvoiceWorkflow({
    enabled: true, isCurrent: () => true, readInvoice: async () => structuredClone(saved.current),
    invalidate: () => setRevision(value => value + 1),
    refresh: async () => setRows(saved.current.deletedAt ? [] : [structuredClone(saved.current)]),
    operations: {
      pending: pendingChanges,
      async change({ expectedVersion, kind, payload }) {
        if (outcome === 'stale') return { ok: false, needsRefresh: true, error: 'Invoice berubah di sesi uji lain.' }
        if (outcome === 'offline' && !uncertain.current) {
          uncertain.current = true
          return { ok: false, needsReconciliation: true, error: 'Koneksi uji terputus sebelum penyimpanan.' }
        }
        if (saved.current.version !== expectedVersion) return { ok: false, needsRefresh: true }
        if (kind === 'edit') saved.current = { ...saved.current, ...calculateInvoiceChange({ ...payload, tax: 0, paid: saved.current.paid }),
          customer: payload.customerName, notes: payload.notes, dueDate: payload.due_date, version: expectedVersion + 1 }
        else saved.current = { ...saved.current, deletedAt: new Date().toISOString(), remaining: 0, version: expectedVersion + 1 }
        receipt.current = { ok: true, data: { invoiceId: initial.id, state: kind === 'edit' ? 'active' : 'cancelled' } }
        setMessage(kind === 'edit' ? 'Perubahan data uji tersimpan' : 'Invoice uji dihapus; pembayaran Rp200.000 masih perlu refund')
        if (outcome === 'lost' && !uncertain.current) { uncertain.current = true; return { ok: false, needsReconciliation: true } }
        return receipt.current
      },
      async reconcile() { if (receipt.current) unresolved.current = false; return receipt.current || { ok: false, needsReconciliation: true, unknown: true, error: 'Permintaan uji belum ditemukan.' } },
    },
  }), [])
  return <main className="p-4">
    <h1 className="text-xl font-semibold">SKUPY POS: Order Uji Lokal</h1>
    <p data-testid="turnover">Omzet uji: Rp{(10000000 + rows.reduce((sum, row) => sum + row.total, 0)).toLocaleString('id-ID')}</p>
    {message && <p role="status">{message}</p>}
    <Order transactions={rows} products={[]} customers={[]} admins={[{ id: 'cashier', name: 'Kasir Uji' }]}
      currentUser={{ id: 'cashier', name: 'Kasir Uji', role: 'staff' }} invoiceWorkflow={workflow} invoiceRevision={revision} pendingInvoiceChanges={pendingChanges()}
      storeInfo={{ name: 'SKUPY UJI', bank: {} }} busy={false}
      updateOrderStatus={async () => ({ ok: false, error: 'Hanya alur invoice diuji di sini.' })}
      updateTransactionPayment={async () => ({ ok: false, error: 'Tidak ada pembayaran nyata pada preview ini.' })} />
  </main>
}
createRoot(document.getElementById('root')).render(<Preview />)
