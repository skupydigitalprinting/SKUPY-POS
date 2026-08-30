const money = (value) => Math.max(0, Math.round(Number(value) || 0))

export function assetPaymentState(purchasePrice, payments = []) {
  const price = money(purchasePrice)
  const rawPaid = payments
    .filter(payment => !payment.deleted_at)
    .reduce((sum, payment) => sum + money(payment.amount), 0)
  const paid = Math.min(price, rawPaid)
  const outstanding = Math.max(0, price - paid)
  return {
    purchasePrice: price,
    paid,
    outstanding,
    status: outstanding > 0 ? 'credit' : 'paid',
  }
}

export function normalizeAssetPayment({ amount, method }) {
  return {
    amount: money(amount),
    method: ['cash', 'transfer', 'qris'].includes(method) ? method : 'transfer',
    activity: 'investing',
  }
}
