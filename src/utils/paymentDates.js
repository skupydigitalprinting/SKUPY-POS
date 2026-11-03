const dayFormat = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit' })

export function paymentDay(value = new Date()) {
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? dayFormat.format(date) : ''
}

export function validPaymentDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value && value >= '1900-01-01'
}
