import React from 'react'
import { createRoot } from 'react-dom/client'
import Modal from '../../src/components/Modal'
import ReceivablePaymentHistory from '../../src/components/ReceivablePaymentHistory'
import '../../src/index.css'

// Synthetic local records; no database requests or real payment writes.
const invoices = [{ id: 'a', invoiceNo: 'UJI-INVOICE-A' }, { id: 'b', invoiceNo: 'UJI-INVOICE-B' }]
const rows = [
  { id: 'p1', debt_id: 'a', amount: 25000000, paid_at: '2026-10-16T08:55:00Z', payment_method: 'transfer' },
  { id: 'p2', debt_id: 'a', amount: 12597358, paid_at: '2026-09-02T06:19:00Z', payment_method: 'transfer' },
  { id: 'p3', debt_id: 'b', amount: 7402642, paid_at: '2026-09-02T06:19:00Z', payment_method: 'transfer' },
  { id: 'p4', debt_id: 'a', amount: 1000000, paid_at: '2026-09-02T06:20:00Z', payment_method: 'cash' },
  { id: 'p5', debt_id: 'b', amount: 2000000, paid_at: '2026-09-02T06:21:00Z', payment_method: 'qris' },
]
const scenario = new URLSearchParams(location.search).get('scenario')
let attempts = 0
const load = async () => {
  attempts++
  if (scenario === 'error' && attempts === 1) return { ok: false }
  return { ok: true, data: scenario === 'empty' ? rows.filter(row => row.payment_method !== 'transfer') : rows }
}
createRoot(document.getElementById('root')).render(<Modal open title="Customer Uji" subtitle="Riwayat Pembayaran" size="lg" onClose={() => {}}>
  <ReceivablePaymentHistory invoices={invoices} getReceivablePayments={load} openInvoice={() => {}} />
</Modal>)
