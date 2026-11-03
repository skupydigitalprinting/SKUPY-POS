const money = value => {
  const amount = Number(value ?? 0)
  if (!Number.isFinite(amount) || amount < 0) throw new Error('Nominal piutang tidak valid. Muat ulang data sebelum mengunduh.')
  return Math.round(amount)
}

// Only consume the access-scoped collection supplied by App, never query beyond it.
export function buildReceivableReport(debts = [], customers = [], admins = []) {
  const customerMap = new Map(customers.map(c => [c.id, c]))
  const adminMap = new Map(admins.map(a => [a.id, a.name || a.username]))
  const groups = new Map(), seen = new Set(), invoices = []
  for (const debt of debts) {
    if (debt.deletedAt || debt.deleted_at) continue
    if (debt.id && seen.has(debt.id)) throw new Error('Data piutang duplikat. Muat ulang sebelum mengunduh.')
    seen.add(debt.id)
    const customer = customerMap.get(debt.customerId)
    const key = debt.customerId || `unlinked:${debt.id || invoices.length}`
    const total = money(debt.totalDebt), paid = money(debt.paid)
    const remaining = Math.max(0, total - paid)
    const name = customer?.name || 'Customer tidak tersedia'
    const pic = customer?.ownerName || adminMap.get(customer?.ownerUserId) || 'Tanpa PIC'
    const row = { id: debt.id, customerId: key, customer: name, pic, invoice: debt.invoiceNo || '-', date: debt.createdAt,
      dueDate: debt.dueDate, total, paid, remaining, status: remaining > 0 ? 'Aktif' : 'Lunas' }
    invoices.push(row)
    if (!groups.has(key)) groups.set(key, { id: key, name, pic, total: 0, paid: 0, remaining: 0, invoices: 0 })
    const group = groups.get(key)
    group.total += total; group.paid += paid; group.remaining += remaining; group.invoices++
  }
  const recap = [...groups.values()].sort((a, b) => b.remaining - a.remaining || a.name.localeCompare(b.name, 'id') || String(a.id).localeCompare(String(b.id)))
  const rank = new Map(recap.map((c, i) => [c.id, i]))
  invoices.sort((a, b) => rank.get(a.customerId) - rank.get(b.customerId) || String(a.date || '').localeCompare(String(b.date || '')) || a.invoice.localeCompare(b.invoice))
  const totals = recap.reduce((sum, c) => ({ ...sum, total: sum.total + c.total, paid: sum.paid + c.paid, remaining: sum.remaining + c.remaining }),
    { total: 0, paid: 0, remaining: 0, invoices: invoices.length, customers: recap.length, activeInvoices: invoices.filter(d => d.remaining > 0).length })
  return { totals, customers: recap, invoices }
}
