import React, { useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import Piutang from '../../src/pages/Piutang'
import { ToastProvider } from '../../src/components/Toast'
import '../../src/index.css'

// Local synthetic records only. No session, RPC, or production writes.
const scenario = new URLSearchParams(location.search).get('scenario')
const invoice = { id: 'synthetic-receivable', invoiceNo: 'UJI-PIUTANG-001', version: 1,
  total: 488520, paid: 0, remaining: 488520 }
const originalDebt = { id: 'synthetic-debt', transactionId: scenario === 'unlinked' ? null : invoice.id,
  invoiceNo: invoice.invoiceNo, customerId: 'synthetic-customer', totalDebt: invoice.total,
  paid: 0, createdAt: '2026-10-05T08:00:00Z', status: 'aktif' }
const currentUser = { id: 'synthetic-staff', name: 'Kasir Uji', role: 'staff' }
const customers = [{ id: 'synthetic-customer', name: 'Customer Uji', ownerUserId: currentUser.id }]

function Preview() {
  const [debts, setDebts] = useState([originalDebt])
  const [writes, setWrites] = useState(0)
  const [legacyWrites, setLegacyWrites] = useState(0)
  const [pending, setPending] = useState([])
  const workflow = useMemo(() => ({
    load: async () => ({ ok: true, data: invoice }),
    pending: () => [],
    change: async () => {
      setWrites(value => value + 1)
      if (scenario === 'uncertain') {
        setPending([{ operationId: 'synthetic-operation', invoiceId: invoice.id, kind: 'cancel' }])
        return { ok: false, needsReconciliation: true, unknown: true, error: 'Respons uji terputus.' }
      }
      setDebts([])
      return { ok: true }
    },
    reconcile: async () => { setPending([]); setDebts([]); return { ok: true, committed: true } },
    refresh: async () => ({ ok: true }),
  }), [])
  return <ToastProvider>
    <p role="status" className="p-4">Data uji lokal. Permintaan invoice: {writes}. Hapus lama: {legacyWrites}. Piutang: {debts.length}.</p>
    <Piutang debts={debts} customers={customers} transactions={scenario === 'unlinked' ? [] : [invoice]}
      currentUser={currentUser} invoiceWorkflow={workflow} pendingInvoiceChanges={pending}
      deleteDebt={async () => { setLegacyWrites(value => value + 1); return { ok: false } }}
      getDebtPayments={async () => ({ ok: true, data: [] })} />
  </ToastProvider>
}
createRoot(document.getElementById('root')).render(<Preview />)
