function invalid(field, message) {
  const error = new Error(message)
  error.field = field
  throw error
}

function rupiah(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) invalid(field, 'Masukkan nominal rupiah bulat, minimal nol.')
  return value
}

export function parseInvoiceNumber(value, field) {
  if (typeof value !== 'string' || !/^\d+(?:[.,]\d+)?$/.test(value.trim())) {
    invalid(field, 'Masukkan angka tanpa pemisah ribuan.')
  }
  const number = Number(value.trim().replace(',', '.'))
  if (!Number.isFinite(number)) invalid(field, 'Angka tidak valid.')
  return number
}

export function calculateInvoiceChange({ items, discount, tax, paid }) {
  if (!Array.isArray(items) || items.length === 0) invalid('items', 'Tambahkan minimal satu barang.')
  rupiah(discount, 'discount')
  rupiah(tax, 'tax')
  rupiah(paid, 'paid')
  let hundredths = 0
  const copied = items.map((item, index) => {
    const field = `items.${index}`
    if (!item || typeof item !== 'object') invalid(field, 'Barang tidak valid.')
    if (typeof item.name !== 'string' || !item.name.trim()) invalid(`${field}.name`, 'Nama barang wajib diisi.')
    if (!['pcs', 'meter', 'yard'].includes(item.unit)) invalid(`${field}.unit`, 'Satuan tidak dikenal.')
    rupiah(item.price, `${field}.price`)
    const scaled = Math.round(item.qty * 100)
    if (typeof item.qty !== 'number' || !Number.isFinite(item.qty) || item.qty <= 0
      || !Number.isSafeInteger(scaled) || scaled / 100 !== item.qty
      || (item.unit === 'pcs' && !Number.isInteger(item.qty))) {
      invalid(`${field}.qty`, 'Jumlah PCS harus bulat; meter/yard maksimal dua desimal.')
    }
    const amount = item.price * scaled
    if (!Number.isSafeInteger(amount) || !Number.isSafeInteger(hundredths + amount)) {
      invalid('subtotal', 'Nilai invoice terlalu besar.')
    }
    hundredths += amount
    return { ...item }
  })
  const subtotal = Math.round(hundredths / 100)
  if (discount > subtotal) invalid('discount', 'Diskon melebihi subtotal.')
  const total = subtotal - discount + tax
  rupiah(total, 'total')
  return { items: copied, subtotal, discount, tax, total, paid,
    remaining: Math.max(0, total - paid), overpaid: Math.max(0, paid - total) }
}
