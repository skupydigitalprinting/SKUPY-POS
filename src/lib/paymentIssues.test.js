import test from 'node:test'
import assert from 'node:assert/strict'
import { retainUnresolvedPaymentIssues } from './paymentIssues.js'

test('confirmed invoice recovery unlocks its payment form but preserves another unresolved invoice', () => {
  const issues = { a: { invoiceNo: 'A', needsReconciliation: true }, b: { invoiceNo: 'B', needsReconciliation: true },
    c: { error: 'Invalid amount' }, d: { needsReconciliation: true } }
  assert.deepEqual(retainUnresolvedPaymentIssues(issues, [{ invoiceNo: 'B' }]), { b: issues.b, c: issues.c, d: issues.d })
})
