import test from 'node:test'
import assert from 'node:assert/strict'
import { calculateInvoiceChange, parseInvoiceNumber } from './invoiceChanges.js'

const line = { productId: 'shirt', name: 'Kaos lama', price: 100000, qty: 4, unit: 'pcs' }
const draft = (overrides = {}) => ({ items: [{ ...line }], discount: 0, tax: 0, paid: 200000, ...overrides })

test('reprice same invoice preserves receipts and recalculates debt or overpayment', () => {
  assert.deepEqual(calculateInvoiceChange(draft()), {
    items: [line], subtotal: 400000, discount: 0, tax: 0, total: 400000,
    paid: 200000, remaining: 200000, overpaid: 0,
  })
  const reduced = calculateInvoiceChange(draft({ items: [{ ...line, price: 150000, qty: 1 }] }))
  assert.equal(reduced.paid, 200000)
  assert.equal(reduced.remaining, 0)
  assert.equal(reduced.overpaid, 50000)
})

test('preserves saved line snapshots, input and stored tax', () => {
  const input = draft({ tax: 44000, discount: 20000 })
  const before = structuredClone(input)
  const result = calculateInvoiceChange(input)
  assert.deepEqual(input, before)
  assert.equal(result.items[0].name, 'Kaos lama')
  assert.equal(result.items[0].price, 100000)
  assert.equal(result.total, 424000)
  result.items[0].qty = 99
  assert.equal(input.items[0].qty, 4)
})

test('rounds sum of fractional meter and yard lines once to rupiah', () => {
  const result = calculateInvoiceChange(draft({ paid: 0, items: [
    { ...line, price: 1, qty: 0.25, unit: 'meter' },
    { ...line, price: 1, qty: 0.25, unit: 'yard' },
  ] }))
  assert.equal(result.subtotal, 1)
  assert.equal(calculateInvoiceChange(draft({ items: [{ ...line, qty: 1.13, unit: 'meter' }] })).total, 113000)
})

test('free custom line is allowed; quantity is not capped by stock', () => {
  assert.equal(calculateInvoiceChange(draft({ items: [{ ...line, price: 0, qty: 9999 }] })).total, 0)
})

for (const [label, patch, field] of [
  ['empty items', { items: [] }, 'items'],
  ['missing items', { items: null }, 'items'],
  ['null line', { items: [null] }, 'items.0'],
  ['empty name', { items: [{ ...line, name: ' ' }] }, 'items.0.name'],
  ['zero quantity', { items: [{ ...line, qty: 0 }] }, 'items.0.qty'],
  ['PCS fraction', { items: [{ ...line, qty: 1.5 }] }, 'items.0.qty'],
  ['unknown unit', { items: [{ ...line, unit: 'invalid' }] }, 'items.0.unit'],
  ['excess precision', { items: [{ ...line, qty: 1.001, unit: 'meter' }] }, 'items.0.qty'],
  ['negative price', { items: [{ ...line, price: -1 }] }, 'items.0.price'],
  ['fractional rupiah', { items: [{ ...line, price: 1.5 }] }, 'items.0.price'],
  ['noncanonical numeric string', { items: [{ ...line, price: '1000' }] }, 'items.0.price'],
  ['NaN', { paid: NaN }, 'paid'], ['Infinity', { tax: Infinity }, 'tax'],
  ['negative paid', { paid: -1 }, 'paid'], ['negative discount', { discount: -1 }, 'discount'],
  ['excess discount', { discount: 400001 }, 'discount'],
  ['unsafe quantity', { items: [{ ...line, qty: Number.MAX_SAFE_INTEGER }] }, 'items.0.qty'],
  ['unsafe amount', { tax: Number.MAX_SAFE_INTEGER + 1 }, 'tax'],
  ['unsafe line product', { items: [{ ...line, price: Number.MAX_SAFE_INTEGER }] }, 'subtotal'],
  ['unsafe total', { tax: Number.MAX_SAFE_INTEGER }, 'total'],
]) test(`rejects ${label} with field-specific error`, () => {
  assert.throws(() => calculateInvoiceChange(draft(patch)), error => error.field === field)
})

test('parses decimal comma only at form boundary without accepting partial numbers', () => {
  assert.equal(parseInvoiceNumber('1,25', 'qty'), 1.25)
  assert.equal(parseInvoiceNumber(' 150000 ', 'price'), 150000)
  for (const value of ['', ' ', '12abc', '1.000,50', '1,2,3', 'Infinity', '1e6', null]) {
    assert.throws(() => parseInvoiceNumber(value, 'qty'), error => error.field === 'qty')
  }
})
