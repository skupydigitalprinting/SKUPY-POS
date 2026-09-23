import test from 'node:test'
import assert from 'node:assert/strict'
import { createInvoiceDraft, validateInvoiceDraft, validateInvoiceRemoval } from './invoiceDraft.js'

const invoice = { id: 'one', invoiceNo: 'INV-1', customer: 'Pelanggan', customerId: 'unchanged',
  items: [{ productId: 'deleted-product', name: 'Snapshot lama', qty: 2, price: 250000 }],
  discount: 0, tax: 1000, paid: 200000, notes: 'Catatan', dueDate: '2026-10-01' }

test('form quotes edited lines preserving DP and excludes authority fields from submission', () => {
  const draft = createInvoiceDraft(invoice)
  assert.equal(draft.items[0].unit, 'pcs')
  draft.items[0].price = '150000'
  draft.reason = 'Pelanggan mengganti barang'
  draft.customer_id = 'attacker'
  draft.paid = '0'
  const { quote, payload } = validateInvoiceDraft(invoice, draft)
  assert.equal(quote.total, 301000)
  assert.equal(quote.paid, 200000)
  assert.equal(quote.remaining, 101000)
  assert.equal(payload.items[0].name, 'Snapshot lama')
  assert.deepEqual(Object.keys(payload).sort(), ['customerName', 'discount', 'due_date', 'items', 'notes', 'reason'])
  assert.equal(invoice.items[0].price, 250000)
})

test('form refuses invalid calendar date and requires a nonblank correction reason', () => {
  const draft = createInvoiceDraft(invoice)
  assert.throws(() => validateInvoiceDraft(invoice, draft), /Alasan/)
  draft.reason = 'Salah input'
  for (const date of ['2026-02-30', '2026-13-01', 'junk', '2026-2-01']) {
    assert.throws(() => validateInvoiceDraft(invoice, { ...draft, dueDate: date }), /Tanggal/)
  }
  assert.equal(validateInvoiceDraft(invoice, { ...draft, dueDate: '' }).payload.due_date, null)
})

test('incorrect receipt removal requires explicit no-real-money confirmation', () => {
  assert.throws(() => validateInvoiceRemoval(invoice, 'void_error', 'Duplikat', false), /uang/)
  assert.deepEqual(validateInvoiceRemoval(invoice, 'void_error', ' Duplikat ', true), { reason: 'Duplikat' })
  assert.deepEqual(validateInvoiceRemoval(invoice, 'cancel', 'Pesanan batal', false), { reason: 'Pesanan batal' })
  assert.throws(() => validateInvoiceRemoval(invoice, 'delete_all', 'Batal', true))
  assert.throws(() => validateInvoiceRemoval(invoice, 'cancel', ' ', false))
})

test('draft rejects malformed, negative and fractional prices and discounts without sanitizing them', () => {
  for (const value of ['150000,50', '-150000', '12abc', '1e6', '']) {
    const draft = { ...createInvoiceDraft(invoice), reason: 'Koreksi' }
    assert.throws(() => validateInvoiceDraft(invoice, { ...draft, discount: value }))
    draft.items[0].price = value
    assert.throws(() => validateInvoiceDraft(invoice, draft))
  }
})
