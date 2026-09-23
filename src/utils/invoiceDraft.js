import { calculateInvoiceChange, parseInvoiceNumber } from './invoiceChanges.js'

function requiredText(value, label, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new Error(`${label} wajib diisi (maksimal ${max} karakter).`)
  }
  return value.trim()
}

export function createInvoiceDraft(invoice) {
  return {
    items: (invoice.items || []).map(item => ({ ...item, unit: item.unit || 'pcs',
      qty: String(item.qty), price: String(item.price) })),
    discount: String(invoice.discount ?? 0), customerName: invoice.customer || '',
    notes: invoice.notes || '', dueDate: invoice.dueDate || '', reason: '',
  }
}

export function quoteInvoiceDraft(invoice, draft) {
  return calculateInvoiceChange({
    items: draft.items.map((item, index) => ({ productId: item.productId ?? null,
      name: item.name, unit: item.unit,
      qty: parseInvoiceNumber(item.qty, `items.${index}.qty`),
      price: parseInvoiceNumber(item.price, `items.${index}.price`),
    })),
    discount: parseInvoiceNumber(draft.discount, 'discount'),
    tax: invoice.tax ?? 0, paid: invoice.paid,
  })
}

export function validateInvoiceDraft(invoice, draft) {
  const reason = requiredText(draft.reason, 'Alasan perubahan', 1000)
  if (draft.dueDate && (!/^\d{4}-\d{2}-\d{2}$/.test(draft.dueDate)
    || !Number.isFinite(Date.parse(`${draft.dueDate}T00:00:00Z`))
    || new Date(`${draft.dueDate}T00:00:00Z`).toISOString().slice(0, 10) !== draft.dueDate)) {
    throw new Error('Tanggal jatuh tempo tidak valid.')
  }
  if (typeof draft.notes !== 'string' || draft.notes.length > 4000) throw new Error('Catatan maksimal 4000 karakter.')
  const customerName = requiredText(draft.customerName, 'Nama pelanggan', 256)
  const quote = quoteInvoiceDraft(invoice, draft)
  return { quote, payload: { items: quote.items, discount: quote.discount, customerName,
    notes: draft.notes, due_date: draft.dueDate || null, reason } }
}

export function validateInvoiceRemoval(invoice, kind, reason, noRealMoney) {
  if (!['cancel', 'void_error'].includes(kind)) throw new Error('Jenis penghapusan tidak valid.')
  if (!Number.isSafeInteger(invoice.paid) || invoice.paid < 0) throw new Error('Pembayaran invoice tidak valid.')
  if (kind === 'void_error' && invoice.paid > 0 && noRealMoney !== true) {
    throw new Error('Konfirmasikan bahwa tidak ada uang nyata yang diterima pada nota ini.')
  }
  return { reason: requiredText(reason, 'Alasan penghapusan', 1000) }
}
