import React from 'react'
import { createRoot } from 'react-dom/client'
import Order from '../../src/pages/Order'
import Piutang from '../../src/pages/Piutang'
import Accounting from '../../src/pages/Accounting'
import { ToastProvider } from '../../src/components/Toast'
import { ConfirmProvider } from '../../src/components/Confirm'
import { InvoicePreviewProvider } from '../../src/components/InvoicePreview'
import '../../src/index.css'

// Synthetic UI-only fixture. All write callbacks terminate here, never at a data client.
const params = new URLSearchParams(location.search)
window.financialPreviewClient = {
  from(table) {
    const steps = []
    const chain = { then(resolve, reject) {
      const fail = table === params.get('fail')
      return Promise.resolve({ data: fail ? null : steps.includes('single') || steps.includes('maybeSingle') ? null : [],
        error: fail ? { message: 'Sumber laporan simulasi tidak tersedia' } : null, count: fail ? null : 0 }).then(resolve, reject)
    } }
    for (const name of ['select', 'eq', 'neq', 'is', 'in', 'gt', 'gte', 'lt', 'lte', 'order', 'range', 'limit', 'maybeSingle', 'single', 'ilike', 'or']) {
      chain[name] = () => { steps.push(name); return chain }
    }
    for (const name of ['insert', 'update', 'delete', 'upsert']) chain[name] = () => { throw new Error('Mutation forbidden in report fixture') }
    return chain
  },
  async rpc(name) {
    if (!['acc_dashboard', 'acc_summary', 'acc_recap_admin'].includes(name)) throw new Error('RPC not allowlisted in report fixture')
    return { data: name === 'acc_recap_admin' ? [] : { penjualan: 100000, uang_masuk_total: 50000, pengeluaran_total: 20000 }, error: null }
  },
  channel() { const channel = { on() { return channel }, subscribe() { return channel } }; return channel },
  removeChannel: async () => {},
}
const user = { id: 'synthetic-owner', role: 'owner', name: 'Admin Uji' }
const customer = { id: 'synthetic-customer', name: 'Pelanggan Uji', ownerUserId: user.id, ownerName: user.name }
const transaction = { id: 'synthetic-order', invoiceNo: 'UJI-001', customerId: customer.id,
  customer: customer.name, cashierId: user.id, cashier: user.name, date: new Date().toISOString(),
  total: 100000, paid: 20000, dp: 20000, remaining: 80000, status: 'pending',
  paymentMethod: 'cash', orderStatus: 'menunggu', items: [], statusHistory: [] }
const debt = { id: 'synthetic-debt', invoiceNo: transaction.invoiceNo, customerId: customer.id,
  transactionId: transaction.id, totalDebt: 100000, paid: 20000, remaining: 80000,
  status: 'aktif', createdAt: transaction.date }
window.paymentProbe = { calls: 0, inputs: [] }
const result = async (...args) => {
  window.paymentProbe.calls += 1
  window.paymentProbe.inputs.push(args)
  await new Promise(resolve => setTimeout(resolve, 80))
  if (params.get('outcome') === 'throw') throw new Error('Koneksi terputus saat menyimpan')
  if (params.get('outcome') === 'success') return { ok: true }
  return { ok: false, needsReconciliation: true, error: 'Pembayaran belum terkonfirmasi. Jangan ulangi pembayaran; periksa bersama owner.' }
}
const noMutation = async () => ({ ok: false, error: 'Hanya data simulasi' })
const common = { currentUser: user, admins: [user], customers: [customer], transactions: [transaction] }
createRoot(document.getElementById('root')).render(
  <ToastProvider><ConfirmProvider><InvoicePreviewProvider resolve={async () => null} storeInfo={{ name: 'SKUPY UJI' }}>
    <main style={{ padding: 16, maxWidth: 1400, margin: 'auto' }}>
      {params.get('view') === 'accounting' ? <Accounting admins={[user]} currentUser={user} /> : params.get('view') === 'piutang'
        ? <Piutang {...common} debts={[debt]} payDebt={result} payCustomerDebtsFIFO={result}
          deleteDebt={noMutation} getDebtPayments={async () => []} reassignReceivableCustomer={noMutation}
          getReceivableCustomerChanges={async () => []} />
        : <Order {...common} busy={false} storeInfo={{ name: 'SKUPY UJI' }}
          updateTransactionStatus={noMutation} updateTransactionPayment={result} deleteTransaction={noMutation}
          updateOrderStatus={noMutation} reassignOrderCustomer={noMutation} getOrderCustomerChanges={async () => []} />}
    </main>
  </InvoicePreviewProvider></ConfirmProvider></ToastProvider>,
)
