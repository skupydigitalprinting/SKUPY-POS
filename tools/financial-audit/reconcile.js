// Pure, read-only diagnostics. No network, environment, credentials or corrective writes.
// A caller-supplied snapshot cannot establish completeness or production provenance.
export function reconcileSnapshot(snapshot) {
  const tables = ['transactions', 'debts', 'debt_payments']
  if (!snapshot || tables.some(table => !Array.isArray(snapshot[table]) ||
    snapshot[table].some(row => !row || typeof row !== 'object' || Array.isArray(row)))) {
    throw new TypeError('Snapshot harus berisi transactions, debts, dan debt_payments lengkap.')
  }
  const findings = []
  const unassessed = new Set(['snapshot-completeness', 'journal-postings', 'initial-deposit-source-documents'])
  const add = (code, table, row, values = {}) => findings.push({ code, table,
    id: row.id ?? null, invoiceNo: row.invoice_no ?? null, ...values })
  const money = value => (typeof value === 'number' || (typeof value === 'string' && /^\d+(?:\.0+)?$/.test(value))) &&
    Number.isSafeInteger(Number(value)) && Number(value) >= 0
  const scope = (parent, child, table) => {
    for (const field of ['customer_id', 'book_id']) {
      if (!Object.hasOwn(parent, field) || !Object.hasOwn(child, field)) unassessed.add('missing-customer-or-book-fields')
      else if (parent[field] !== child[field]) add('scope-link-conflict', table, child, { field })
    }
  }
  const indexes = {}
  for (const table of tables) {
    const ids = new Map(), invoices = new Map()
    for (const row of snapshot[table]) {
      if (!row.id) add('missing-id', table, row)
      const rows = ids.get(row.id) || []
      rows.push(row); ids.set(row.id, rows)
      if (rows.length === 2) add('duplicate-id', table, row)
      if (row.invoice_no) {
        const matches = invoices.get(row.invoice_no) || []
        matches.push(row); invoices.set(row.invoice_no, matches)
        if (matches.length === 2 && table !== 'debt_payments') add('duplicate-invoice', table, row)
      }
      const fields = table === 'debt_payments' ? ['amount'] : [table === 'debts' ? 'total_debt' : 'total', 'paid', 'remaining']
      for (const field of fields) if (!money(row[field]) || (field === 'amount' && Number(row[field]) <= 0)) add('invalid-money', table, row, { field })
      if (row.deleted_at) add('deleted-financial-record', table, row)
      if (table !== 'debt_payments' && fields.every(field => money(row[field])) &&
        Number(row[fields[0]]) !== Number(row.paid) + Number(row.remaining)) {
        add('balance-equation-mismatch', table, row)
      }
    }
    indexes[table] = { ids, invoices }
  }
  const unique = rows => rows?.length === 1 ? rows[0] : null
  const linked = new Map()
  for (const debt of snapshot.debts) {
    const byId = debt.transaction_id ? indexes.transactions.ids.get(debt.transaction_id) : null
    const byInvoice = debt.invoice_no ? indexes.transactions.invoices.get(debt.invoice_no) : null
    if (!debt.transaction_id && byInvoice?.length) {
      add('ambiguous-invoice-link', 'debts', debt)
      continue
    }
    const transaction = debt.transaction_id ? unique(byId) : unique(byInvoice)
    if (debt.transaction_id && !transaction) add('missing-or-ambiguous-transaction', 'debts', debt)
    if (!transaction) continue // An opening debt may legitimately have no sale.
    linked.set(debt.id, transaction)
    scope(transaction, debt, 'debts')
    if (debt.invoice_no && debt.invoice_no !== transaction.invoice_no) add('debt-link-conflict', 'debts', debt)
    if (['paid', 'remaining'].some(field => money(debt[field]) && money(transaction[field]) && Number(debt[field]) !== Number(transaction[field])) ||
      (money(debt.total_debt) && money(transaction.total) && Number(debt.total_debt) !== Number(transaction.total))) {
      add('invoice-debt-mismatch', 'debts', debt)
    }
    if (transaction.order_status === 'dibatalkan' && Number(debt.remaining) > 0) add('cancelled-receivable', 'debts', debt)
  }
  const histories = new Map()
  for (const receipt of snapshot.debt_payments) {
    const debt = unique(indexes.debts.ids.get(receipt.debt_id))
    if (!debt) { add('orphan-payment', 'debt_payments', receipt); continue }
    scope(debt, receipt, 'debt_payments')
    if (receipt.invoice_no && receipt.invoice_no !== debt.invoice_no) {
      add('payment-link-conflict', 'debt_payments', receipt); continue
    }
    if (!receipt.deleted_at && money(receipt.amount)) histories.set(debt.id, (histories.get(debt.id) || 0) + Number(receipt.amount))
  }
  for (const debt of snapshot.debts) {
    const history = histories.get(debt.id) || 0
    const transaction = linked.get(debt.id)
    if ((money(debt.paid) && history > Number(debt.paid)) || (transaction && money(transaction.paid) && history > Number(transaction.paid))) {
      add('history-exceeds-paid', 'debts', debt, { historyTotal: history })
    }
  }
  for (const transaction of snapshot.transactions) {
    if (transaction.order_status === 'dibatalkan' && Number(transaction.paid) > 0) add('cancelled-receipt-needs-disposition', 'transactions', transaction)
  }
  return { scope: 'supplied-snapshot-only', productionVerified: false,
    rows: Object.fromEntries(tables.map(table => [table, snapshot[table].length])), findings, unassessed: [...unassessed] }
}
