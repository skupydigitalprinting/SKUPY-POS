import React, { useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import PaymentRecoveryPanel from '../../src/components/PaymentRecoveryPanel'
import '../../src/index.css'

function Preview() {
  const [pending, setPending] = useState([{ invoiceNo: 'UJI-PEMBAYARAN-001', operationId: 'synthetic-payment' }])
  const [count, setCount] = useState(0)
  const workflow = useMemo(() => ({
    reconcile: async () => ({ ok: false, needsReconciliation: true, unknown: true, error: 'Permintaan uji belum tersimpan.' }),
    resume: async () => { setCount(value => value + 1); setPending([]); return { ok: true } },
    refresh: async () => ({ ok: true }),
  }), [])
  return <main className="mx-auto max-w-3xl p-4 space-y-4">
    <h1 className="text-xl font-bold">SKUPY POS</h1>
    <p>Data uji lokal</p>
    <PaymentRecoveryPanel pending={pending} workflow={workflow} />
    <p role="status">Pembayaran uji tersimpan: {count}</p>
  </main>
}
createRoot(document.getElementById('root')).render(<Preview />)
