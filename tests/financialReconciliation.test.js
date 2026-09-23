import test from 'node:test'
import assert from 'node:assert/strict'
import { reconcileSnapshot } from '../tools/financial-audit/reconcile.js'

const snapshot = () => ({
  transactions: [{ id: 't', invoice_no: 'INV-1', total: 100000, paid: 50000, remaining: 50000 }],
  debts: [{ id: 'd', transaction_id: 't', invoice_no: 'INV-1', total_debt: 100000, paid: 50000, remaining: 50000 }],
  debt_payments: [{ id: 'p', debt_id: 'd', invoice_no: 'INV-1', amount: 30000 }],
})
test('reconciliation reports supplied scope and never infers a complete production audit', () => {
  const data = snapshot(), before = structuredClone(data)
  const result = reconcileSnapshot(data)
  assert.equal(result.scope, 'supplied-snapshot-only')
  assert.equal(result.productionVerified, false)
  assert.deepEqual(result.findings, [])
  assert.deepEqual(data, before)
})
test('reconciliation rejects incomplete input instead of treating missing tables as empty', () => {
  assert.throws(() => reconcileSnapshot({ transactions: [] }), /snapshot/i)
})
test('reconciliation detects balance mismatch without proposing an automatic correction', () => {
  const data = snapshot(); data.debts[0].paid = 40000; data.debts[0].remaining = 60000
  const result = reconcileSnapshot(data)
  assert.ok(result.findings.some(f => f.code === 'invoice-debt-mismatch'))
  assert.equal(Object.hasOwn(result, 'updates'), false)
})
test('reconciliation detects orphan payment and excessive receipt history', () => {
  const data = snapshot(); data.debt_payments[0].amount = 60000
  data.debt_payments.push({ id: 'orphan', debt_id: 'missing', amount: 2000 })
  const codes = reconcileSnapshot(data).findings.map(f => f.code)
  assert.ok(codes.includes('history-exceeds-paid'))
  assert.ok(codes.includes('orphan-payment'))
})
test('cancelled balances need review, not an assumed refund', () => {
  const data = snapshot(); data.transactions[0].order_status = 'dibatalkan'
  const codes = reconcileSnapshot(data).findings.map(f => f.code)
  assert.ok(codes.includes('cancelled-receipt-needs-disposition'))
  assert.ok(codes.includes('cancelled-receivable'))
})
test('ambiguous duplicate invoices and invalid monetary values are reported', () => {
  const data = snapshot(); data.transactions.push({ ...data.transactions[0], id: 't2', paid: 'invalid' })
  const codes = reconcileSnapshot(data).findings.map(f => f.code)
  assert.ok(codes.includes('duplicate-invoice'))
  assert.ok(codes.includes('invalid-money'))
})
test('conflicting payment invoice and debt identity cannot be silently matched', () => {
  const data = snapshot(); data.debt_payments[0].invoice_no = 'WRONG'
  assert.ok(reconcileSnapshot(data).findings.some(f => f.code === 'payment-link-conflict'))
})
test('soft deleted entries are retained as review findings, not erased from the supplied audit', () => {
  const data = snapshot(); data.transactions[0].deleted_at = '2026-09-12T00:00:00Z'
  assert.ok(reconcileSnapshot(data).findings.some(f => f.code === 'deleted-financial-record'))
})
test('opening debt cannot adopt an existing invoice merely by matching its number', () => {
  const data = snapshot(); data.debts[0].transaction_id = null; data.debts[0].is_opening = true
  assert.ok(reconcileSnapshot(data).findings.some(f => f.code === 'ambiguous-invoice-link'))
})
test('supplied customer/book conflicts are flagged and absent fields remain unassessed', () => {
  const data = snapshot()
  Object.assign(data.transactions[0], { customer_id: 'a', book_id: 'b' })
  Object.assign(data.debts[0], { customer_id: 'other', book_id: 'other' })
  Object.assign(data.debt_payments[0], { customer_id: 'a', book_id: 'b' })
  const result = reconcileSnapshot(data)
  assert.equal(result.findings.filter(f => f.code === 'scope-link-conflict').length, 4)
  assert.ok(reconcileSnapshot(snapshot()).unassessed.includes('missing-customer-or-book-fields'))
})
test('zero and precision-losing decimal receipts are invalid', () => {
  for (const amount of [0, '30000.000000000000001']) {
    const data = snapshot(); data.debt_payments[0].amount = amount
    assert.ok(reconcileSnapshot(data).findings.some(f => f.code === 'invalid-money'), String(amount))
  }
  const data = snapshot(); data.debt_payments[0].amount = '30000.000'
  assert.deepEqual(reconcileSnapshot(data).findings, [])
})
