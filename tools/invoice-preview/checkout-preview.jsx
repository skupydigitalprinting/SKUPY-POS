import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import Kasir from '../../src/pages/Kasir'
import CheckoutRecoveryPanel from '../../src/components/CheckoutRecoveryPanel'
import '../../src/index.css'

const products = [{ id: '80000000-0000-4000-8000-000000000920', name: 'Kaos Custom Uji', category: 'kaos', price: 100000, stock: 0, unit: 'pcs' }]
const customer = { id: '80000000-0000-4000-8000-000000000005', name: 'Pelanggan Uji', whatsapp: '', address: '' }
const lost = new URLSearchParams(location.search).get('outcome') === 'lost'
function Preview() {
  const [pending, setPending] = useState(null)
  const [receipt, setReceipt] = useState(null)
  const [revision, setRevision] = useState(0)
  const [count, setCount] = useState(0)
  const workflow = { reconcile: async () => {
    setPending(null); setRevision(v => v + 1)
    return { ok: true, data: receipt }
  } }
  async function checkout(draft) {
    const result = { ...draft, id: 'synthetic', invoiceNo: 'UJI-CHECKOUT-001', date: new Date().toISOString(),
      paymentMethod: draft.paymentMethod === 'hutang' && draft.paid > 0 ? draft.receiptMethod : draft.paymentMethod }
    setReceipt(result); setCount(v => v + 1)
    if (lost) {
      setPending({ operationId: 'synthetic-checkout' })
      return { ok: false, needsReconciliation: true, error: 'Respons terputus. Periksa status checkout.' }
    }
    setRevision(v => v + 1)
    return { ok: true, data: result }
  }
  return <main style={{ height: '100dvh', display: 'flex', flexDirection: 'column' }}>
    <header className="p-3 border-b text-sm">SKUPY POS | Data uji lokal | Invoice tersimpan: <span data-testid="count">{count}</span></header>
    <CheckoutRecoveryPanel workflow={workflow} pending={pending} />
    <Kasir products={products} customers={[customer]} currentUser={{ role: 'staff' }} storeInfo={{ name: 'SKUPY POS UJI' }}
      addTransaction={checkout} checkoutWorkflow={workflow} pendingCheckout={pending} checkoutRevision={revision} />
  </main>
}
createRoot(document.getElementById('root')).render(<Preview />)
