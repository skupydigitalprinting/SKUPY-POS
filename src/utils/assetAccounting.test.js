import test from 'node:test'
import assert from 'node:assert/strict'
import { assetPaymentState, normalizeAssetPayment } from './assetAccounting.js'

test('menghitung DP dan sisa utang aset tanpa memengaruhi harga perolehan', () => {
  const state = assetPaymentState(100_000_000, [
    { amount: 20_000_000, deleted_at: null },
  ])

  assert.deepEqual(state, {
    purchasePrice: 100_000_000,
    paid: 20_000_000,
    outstanding: 80_000_000,
    status: 'credit',
  })
})

test('mengabaikan pembayaran yang sudah dihapus dan membatasi kelebihan bayar', () => {
  const state = assetPaymentState(100_000_000, [
    { amount: 60_000_000, deleted_at: null },
    { amount: 50_000_000, deleted_at: null },
    { amount: 10_000_000, deleted_at: '2026-08-31T00:00:00Z' },
  ])

  assert.equal(state.paid, 100_000_000)
  assert.equal(state.outstanding, 0)
  assert.equal(state.status, 'paid')
})

test('menormalisasi pembayaran aset sebagai arus kas investasi', () => {
  assert.deepEqual(normalizeAssetPayment({ amount: '20000000', method: 'qris' }), {
    amount: 20_000_000,
    method: 'qris',
    activity: 'investing',
  })
})
