// UI-only data. Every callback stays in memory; no business API is connected.
import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import Customers from '../../src/pages/Customers'
import Order from '../../src/pages/Order'
import Piutang from '../../src/pages/Piutang'
import { ToastProvider } from '../../src/components/Toast'
import '../../src/index.css'

const owner = { id: 'owner-test', role: 'owner', name: 'Owner Uji', username: 'owner-uji' }
const customer = { id: 'customer-test', name: 'Customer Uji', phone: '', whatsapp: '', address: '', email: '', notes: '', ownerUserId: owner.id, ownerName: owner.name, totalDebt: 50000, totalSpent: 100000, totalTransactions: 1 }
const order = { id: 'order-test', invoiceNo: 'SYNTHETIC-001', customerId: customer.id, customer: customer.name, cashierId: owner.id, cashier: owner.name, date: new Date().toISOString(), createdAt: new Date().toISOString(), total: 100000, paid: 50000, remaining: 50000, dp: 50000, status: 'pending', orderStatus: 'menunggu', items: [], paymentMethod: 'cash' }
const debt = { id: 'debt-test', customerId: customer.id, customer, invoiceNo: order.invoiceNo, transactionId: order.id, totalDebt: 100000, paid: 50000, remaining: 50000, status: 'aktif', createdAt: new Date().toISOString() }
const reject = async () => ({ ok: false, error: 'Aksi tidak tersedia dalam pengujian tampilan.' })
function Review() {
  const [view, setView] = useState('customers')
  const [rows, setRows] = useState([customer])
  const [saved, setSaved] = useState('')
  const shared = { customers: rows, transactions: [order], admins: [owner], currentUser: owner }
  return <ToastProvider><main style={{ padding: 16, color: 'var(--text-primary)' }}>
    <p className="text-xs mb-3">SYNTHETIC UI TEST</p>
    <nav className="flex gap-4 mb-4"><button onClick={() => setView('customers')}>Customers</button><button onClick={() => setView('order')}>Order</button><button onClick={() => setView('debt')}>Piutang</button></nav>
    {saved && <p role="status">{saved}</p>}
    {view === 'customers' ? <Customers {...shared} addCustomer={reject} deleteCustomer={reject} updateCustomer={async (id, patch) => {
      if ('ownerUserId' in patch) return { ok: false, error: 'Unexpected ownership field' }
      setRows(prev => prev.map(c => c.id === id ? { ...c, ...patch } : c))
      setSaved('Metadata tersimpan tanpa perubahan PIC.'); return { ok: true }
    }} /> : view === 'order' ? <Order {...shared} updateTransactionStatus={reject} updateTransactionPayment={reject} deleteTransaction={reject} updateOrderStatus={reject} reassignOrderCustomer={reject} getOrderCustomerChanges={async () => []} />
      : <Piutang {...shared} debts={[{ ...debt, customer: rows[0] }]} payDebt={reject} payCustomerDebtsFIFO={reject} deleteDebt={reject} getDebtPayments={async () => []} reassignReceivableCustomer={reject} getReceivableCustomerChanges={async () => []} />}
  </main></ToastProvider>
}
createRoot(document.getElementById('root')).render(<Review />)
