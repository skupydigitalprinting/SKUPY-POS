import test from 'node:test'
import assert from 'node:assert/strict'
import { storeFixture } from './helpers/storeFixture.js'

// Canonical payment integrity suite; the standalone audit imports this file.
// Real callbacks; synthetic transport only. Missing debt_id and inconsistent
// balances must be rejected before dispatch. Other SQL constraints, triggers, RLS,
// browser effects/rerenders, and production persistence are not represented.
// A failing invariant is deliberately a failing test, never an expected failure.
const clone = value => structuredClone(value)
const ok = data => ({ data: clone(data), error: null, count: null })
const rejected = { data: null, error: { code: '42501', message: 'Synthetic rejected query' }, status: 403 }
const mutation = request => request.steps.find(s => ['insert', 'update', 'delete'].includes(s.method))
const where = (request, field) => request.steps.find(s => s.method === 'eq' && s.args[0] === field)?.args[1]
const operation = request => mutation(request)?.method || 'select'

function seed({ debtOnly = false, transactionOnly = false, correction = false, fifo = false } = {}) {
  const paid = correction ? 50000 : 20000
  const transaction = {
    id: 't1', invoice_no: 'AUDIT-1', customer_id: 'c1', total: 100000,
    paid, dp: paid, remaining: 100000 - paid, status: 'pending', items: [],
    created_at: '2026-09-01T00:00:00Z', payment_method: 'hutang',
  }
  const debt = {
    id: 'd1', transaction_id: debtOnly ? null : 't1', invoice_no: 'AUDIT-1',
    customer_id: 'c1', total_debt: 100000, paid, remaining: 100000 - paid,
    status: 'aktif', created_at: transaction.created_at,
  }
  const db = {
    transactions: debtOnly ? [] : [transaction],
    debts: transactionOnly ? [] : [debt],
    debt_payments: correction ? [{
      id: 'p1', debt_id: transactionOnly ? null : 'd1', invoice_no: 'AUDIT-1',
      amount: 30000, payment_method: 'cash', paid_at: '2026-09-02T00:00:00Z',
      cashier_id: 'owner', notes: 'Synthetic installment',
    }] : [],
    customers: [{ id: 'c1', name: 'Synthetic customer', total_transactions: debtOnly ? 0 : 1,
      total_spent: debtOnly ? 0 : 100000, total_debt: transactionOnly ? 0 : 100000 - paid }],
  }
  if (fifo) {
    db.transactions.push({ ...transaction, id: 't2', invoice_no: 'AUDIT-2', total: 60000,
      paid: 10000, dp: 10000, remaining: 50000, created_at: '2026-09-03T00:00:00Z' })
    db.debts.unshift({ ...debt, id: 'd2', transaction_id: 't2', invoice_no: 'AUDIT-2',
      total_debt: 60000, paid: 10000, remaining: 50000, created_at: '2026-09-03T00:00:00Z' })
    Object.assign(db.customers[0], { total_transactions: 2, total_spent: 160000, total_debt: 130000 })
  }
  return db
}

// Supply request-aware scripted responses through the fixture's existing script
// array. This changes only this fixture instance, never the shared helper file.
// Successful writes affect these arrays only; rejected writes affect nothing.
async function audit(options, run) {
  const db = seed(options)
  options.prepare?.(db)
  const initial = db.transactions.filter(t => !options.book || t.book_id === options.book).map(t => ({ ...t, invoiceNo: t.invoice_no,
    customerId: t.customer_id, paymentMethod: t.payment_method, date: t.created_at }))
  const priorStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  if (options.book) Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: key => key === 'skupy_active_book' ? options.book : null } })
  try { await storeFixture(options.secure ?? false, async (store, transport) => {
    const faults = []
    const events = []
    transport.script.push(null)
    transport.script.shift = () => {
      const request = transport.requests.at(-1)
      const event = { table: request.table, method: operation(request), request }
      events.push(event)
      const fault = faults.find(f => !f.used && f.match(request))
      if (fault) {
        fault.used = true
        event.failed = true
        return fault.response
      }
      assert.ok(Object.hasOwn(db, request.table), `Unexpected table: ${request.table}`)
      const matches = row => request.steps.every(s => {
        if (s.method === 'eq') return row[s.args[0]] === s.args[1]
        if (s.method === 'is') return (row[s.args[0]] ?? null) === s.args[1]
        if (s.method === 'in') return s.args[1].includes(row[s.args[0]])
        return true
      })
      const change = mutation(request)
      let rows = db[request.table].filter(matches)
      if (change?.method === 'insert') {
        const input = Array.isArray(change.args[0]) ? change.args[0] : [change.args[0]]
        rows = input.map((row, i) => ({ id: `generated-${events.length}-${i}`, ...clone(row) }))
        db[request.table].push(...rows)
      } else if (change?.method === 'update') {
        rows.forEach(row => Object.assign(row, clone(change.args[0])))
      } else if (change?.method === 'delete') {
        db[request.table] = db[request.table].filter(row => !matches(row))
      }
      for (const step of request.steps) {
        if (step.method === 'order') rows.sort((a, b) => String(a[step.args[0]]).localeCompare(String(b[step.args[0]])) * (step.args[1]?.ascending === false ? -1 : 1))
        if (step.method === 'limit') rows = rows.slice(0, step.args[0])
        if (step.method === 'range') rows = rows.slice(step.args[0], step.args[1] + 1)
      }
      if (request.steps.some(s => ['single', 'maybeSingle'].includes(s.method))) {
        assert.ok(rows.length <= 1, 'Synthetic single-row lookup must not be ambiguous')
        return ok(rows[0] ?? null)
      }
      return ok(change ? null : rows)
    }
    // SSR does not rerender. Seed the existing captured array before calling FIFO.
    store.debts.push(...db.debts.filter(d => !options.book || d.book_id === options.book).map(d => ({ ...d, customerId: d.customer_id,
      totalDebt: d.total_debt, invoiceNo: d.invoice_no, transactionId: d.transaction_id, createdAt: d.created_at })))
    const fail = (match, response = rejected) => {
      const fault = { match, response, used: false }
      faults.push(fault)
      return fault
    }
    await run({ store, db, events, fail, transport })
    assert.ok(faults.every(f => f.used), 'Every scripted failure must actually be exercised')
  }, initial) } finally {
    if (options.book) {
      if (priorStorage) Object.defineProperty(globalThis, 'localStorage', priorStorage)
      else delete globalThis.localStorage
    }
  }
}

const at = (table, method, predicate = () => true) => request => request.table === table && operation(request) === method && predicate(request)
const lookup = table => at(table, 'select', r => r.steps.some(s => s.method === 'maybeSingle'))
const summaryRead = table => at(table, 'select', r => where(r, 'customer_id') === 'c1')
const writes = events => events.filter(e => e.method !== 'select')
const pay = (store, amount = 30000, extra = {}) => store.processDebtPayment({ invoice_no: 'AUDIT-1', paymentAmount: amount, skipRefresh: true, ...extra })
const historyTotal = (db, invoice = 'AUDIT-1') => db.debt_payments.filter(p => p.invoice_no === invoice).reduce((sum, p) => sum + p.amount, 0)
const diagnostic = (result, events) => JSON.stringify({ result, operations: events.map(e => `${e.table}.${e.method}${e.failed ? ':FAILED' : ''}`) })
function incomplete(result, events) {
  assert.equal(result?.ok, false, diagnostic(result, events))
  assert.equal(result.needsReconciliation, true, 'Post-write uncertainty must be distinguished from a safe retry')
}
function balances(db, paid, remaining) {
  for (const row of [...db.transactions.filter(t => t.id === 't1'), ...db.debts.filter(d => d.id === 'd1')]) {
    assert.equal(row.paid, paid)
    assert.equal(row.remaining, remaining)
    assert.equal(row.status, remaining === 0 ? 'lunas' : row.id === 't1' ? 'pending' : 'aktif')
    if (row.id === 't1') assert.equal(row.dp, paid)
  }
}

for (const secure of [false, true]) {
  const mode = secure ? 'secure' : 'legacy'
  // Secure payments no longer use this sequential-write fixture. Its former
  // simulated secure baselines are superseded by invoiceStore and real SQL
  // recovery/ledger tests; every legacy behavior below stays covered.
  if (secure) {
    test('secure installment without a verified identity never dispatches or falls back', () => audit({ secure }, async ({ store, db, events, transport }) => {
      const before = clone(db)
      const result = await pay(store)
      assert.equal(result.ok, false)
      assert.equal(transport.requests.length, 0)
      assert.deepEqual(db, before)
      assert.equal(events.length, 0)
    }))
    continue
  }
  for (const debtOnly of [false, true]) {
    const path = debtOnly ? 'debt-only' : 'linked'
    for (const amount of [30000, 80000]) {
      test(`baseline ${mode} ${path}: ${amount === 30000 ? 'partial' : 'full'} payment retains initial DP`, () => audit({ secure, debtOnly }, async ({ store, db, events }) => {
        assert.equal((await pay(store, amount)).ok, true)
        balances(db, 20000 + amount, 80000 - amount)
        assert.equal(historyTotal(db), amount)
        assert.equal(db.debt_payments.length, 1)
        assert.equal(db.debt_payments[0].debt_id, 'd1')
        if (!secure) assert.equal(db.customers[0].total_debt, 80000 - amount)
        if (secure) assert.equal(events.some(e => e.table === 'customers'), false, 'Secure summary is database-owned, not emulated')
      }))
    }
    test(`guard ${mode} ${path}: overpayment never mutates balances or history`, () => audit({ secure, debtOnly }, async ({ store, db, events }) => {
      const before = clone(db)
      assert.equal((await pay(store, 80001)).ok, false)
      assert.deepEqual(db, before)
      assert.equal(writes(events).length, 0)
    }))
    for (const table of [...(debtOnly ? [] : ['transactions']), 'debts', 'debt_payments']) {
      test(`failure ${mode} ${path}: rejected ${table} write cannot report complete success`, () => audit({ secure, debtOnly }, async ({ store, events, fail }) => {
        fail(at(table, table === 'debt_payments' ? 'insert' : 'update'))
        const result = await pay(store)
        assert.equal(result.ok, false, diagnostic(result, events))
        if (table === 'debt_payments' || (!debtOnly && table === 'debts')) incomplete(result, events)
      }))
    }
  }
  test(`failure ${mode}: failed transaction lookup cannot become debt-only payment`, () => audit({ secure }, async ({ store, db, events, fail }) => {
    fail(lookup('transactions'))
    const before = clone(db)
    const result = await pay(store)
    assert.equal(writes(events).length, 0, diagnostic(result, events))
    assert.equal(result.ok, false)
    assert.deepEqual(db, before)
  }))
  for (const fallback of [false, true]) {
    test(`failure ${mode}: failed debt ${fallback ? 'transaction-id fallback' : 'invoice lookup'} must stop before any write`, () => audit({ secure, prepare(db) { if (fallback) db.debts[0].invoice_no = null } }, async ({ store, events, fail }) => {
      fail(at('debts', 'select', r => where(r, fallback ? 'transaction_id' : 'invoice_no') != null))
      const result = await pay(store)
      assert.equal(writes(events).length, 0, diagnostic(result, events))
      assert.equal(result.ok, false)
    }))
  }
}

for (const debtOnly of [false, true]) {
  for (const stage of ['transaction summary read', 'debt summary read', 'customer summary write']) {
    test(`failure legacy ${debtOnly ? 'debt-only' : 'linked'}: ${stage} is propagated`, () => audit({ debtOnly }, async ({ store, events, fail }) => {
      const match = stage === 'transaction summary read' ? summaryRead('transactions') : stage === 'debt summary read' ? summaryRead('debts') : at('customers', 'update')
      fail(request => writes(events).length > 0 && match(request))
      incomplete(await pay(store), events)
    }))
  }
}

test('transaction-only payment is rejected before dispatch because debt_id is required', () => audit({ transactionOnly: true }, async ({ store, db, events }) => {
  const before = clone(db)
  const result = await pay(store)
  assert.equal(result.ok, false)
  assert.equal(!!result.needsReconciliation, false)
  assert.equal(writes(events).length, 0)
  assert.deepEqual(db, before)
}))

test('baseline: sequential payments reread current balances and do not lose initial DP', () => audit({}, async ({ store, db }) => {
  assert.equal((await pay(store, 30000)).ok, true)
  assert.equal((await pay(store, 50000)).ok, true)
  balances(db, 100000, 0)
  assert.equal(historyTotal(db), 80000)
  assert.equal(db.debt_payments.length, 2)
}))

for (const amount of [0, -1, NaN, 'not money']) {
  test(`guard: invalid payment ${String(amount)} has no writes`, () => audit({}, async ({ store, events }) => {
    assert.equal((await pay(store, amount)).ok, false)
    assert.equal(writes(events).length, 0)
  }))
}

test('guard: missing invoice and missing records cannot take payment', () => audit({}, async ({ store, events }) => {
  assert.equal((await pay(store, 30000, { invoice_no: '' })).ok, false)
  assert.equal((await pay(store, 30000, { invoice_no: 'MISSING' })).ok, false)
  assert.equal(writes(events).length, 0)
}))

test('baseline: Order wrapper delegates payment against fresh server balances', () => audit({}, async ({ store, db }) => {
  Object.assign(db.transactions[0], { paid: 40000, dp: 40000, remaining: 60000 })
  Object.assign(db.debts[0], { paid: 40000, remaining: 60000 })
  assert.equal((await store.updateTransactionPayment('t1', 30000)).ok, true)
  balances(db, 70000, 30000)
  assert.equal(db.debt_payments[0].payment_method, 'cash')
  assert.equal(db.debt_payments[0].notes, 'Pembayaran dari halaman Order')
}))

test('guard: Order wrapper rejects unknown transaction and overpayment', () => audit({}, async ({ store, events }) => {
  assert.equal((await store.updateTransactionPayment('missing', 30000)).ok, false)
  assert.equal((await store.updateTransactionPayment('t1', 80001)).ok, false)
  assert.equal(writes(events).length, 0)
}))

for (const fallback of [false, true]) {
  test(`baseline: payDebt preserves method/notes through ${fallback ? 'transaction-id fallback' : 'invoice lookup'}`, () => audit({ prepare(db) { if (fallback) db.debts[0].invoice_no = null } }, async ({ store, db }) => {
    assert.equal((await store.payDebt('d1', 30000, 'qris', 'Synthetic receipt')).ok, true)
    balances(db, 50000, 50000)
    assert.equal(db.debt_payments[0].payment_method, 'qris')
    assert.equal(db.debt_payments[0].notes, 'Synthetic receipt')
  }))
}

test('guard: payDebt rejects failed debt resolution without writes', () => audit({}, async ({ store, events, fail }) => {
  fail(lookup('debts'))
  assert.equal((await store.payDebt('d1', 30000)).ok, false)
  assert.equal(writes(events).length, 0)
}))

for (const entry of ['Order', 'Piutang']) {
  test(`failure: ${entry} wrapper propagates history write failure`, () => audit({}, async ({ store, events, fail }) => {
    fail(at('debt_payments', 'insert'))
    const result = await (entry === 'Order' ? store.updateTransactionPayment('t1', 30000) : store.payDebt('d1', 30000))
    incomplete(result, events)
  }))
}

for (const stage of ['transactions', 'debt_payments']) {
  test(`failure: disconnected ${stage} write returns reconciliation, not an unhandled rejection`, () => audit({}, async ({ store, events, fail }) => {
    fail(at(stage, stage === 'transactions' ? 'update' : 'insert'), new Error('Synthetic disconnected write'))
    let result
    await assert.doesNotReject(async () => { result = await pay(store) })
    incomplete(result, events)
  }))
}

test('failure: exhausted legacy invoice-column history retry is not successful payment', () => audit({}, async ({ store, events, fail }) => {
  fail(at('debt_payments', 'insert'), { data: null, error: { code: 'PGRST204', message: "Could not find the 'invoice_no' column" } })
  fail(at('debt_payments', 'insert'))
  incomplete(await pay(store), events)
}))

test('baseline FIFO: oldest invoice settles first, then allocates only remainder', () => audit({ fifo: true }, async ({ store, db }) => {
  const result = await store.payCustomerDebtsFIFO({ customerId: 'c1', amount: 100000 })
  assert.equal(result.ok, true)
  assert.equal(result.paid, 100000)
  assert.deepEqual(db.debt_payments.map(p => [p.invoice_no, p.amount]), [['AUDIT-1', 80000], ['AUDIT-2', 20000]])
  balances(db, 100000, 0)
  assert.equal(db.transactions[1].remaining, 30000)
  assert.equal(db.customers[0].total_debt, 30000)
}))

test('baseline FIFO: existing cap never allocates above aggregate outstanding', () => audit({ fifo: true }, async ({ store, db }) => {
  const result = await store.payCustomerDebtsFIFO({ customerId: 'c1', amount: 200000 })
  assert.equal(result.ok, true)
  assert.equal(result.paid, 130000)
  assert.equal(db.debt_payments.reduce((s, p) => s + p.amount, 0), 130000)
  assert.ok(db.debts.every(d => d.remaining === 0 && d.status === 'lunas'))
  assert.equal(db.customers[0].total_debt, 0)
}))

test('guard FIFO: invalid amount/customer and no debts cause no writes', () => audit({}, async ({ store, events }) => {
  for (const input of [{ customerId: 'c1', amount: 0 }, { customerId: '', amount: 1 }, { customerId: 'missing', amount: 1 }]) {
    assert.equal((await store.payCustomerDebtsFIFO(input)).ok, false)
  }
  assert.equal(writes(events).length, 0)
}))

for (const method of ['update', 'insert']) {
  test(`failure FIFO: rejected first-invoice ${method} is not counted as paid`, () => audit({ fifo: true }, async ({ store, events, fail }) => {
    fail(at(method === 'update' ? 'transactions' : 'debt_payments', method))
    const result = await store.payCustomerDebtsFIFO({ customerId: 'c1', amount: 100000 })
    assert.equal(result.results?.find(r => r.debtId === 'd1')?.ok, false, diagnostic(result, events))
    incomplete(result, events)
  }))
}

test('failure FIFO: partial completion is distinguishable from fully successful payment', () => audit({ fifo: true }, async ({ store, events, fail }) => {
  fail(at('transactions', 'select', r => where(r, 'invoice_no') === 'AUDIT-2'), new Error('Synthetic second-invoice disconnect'))
  let result
  await assert.doesNotReject(async () => { result = await store.payCustomerDebtsFIFO({ customerId: 'c1', amount: 100000 }) })
  incomplete(result, events)
  assert.equal(result.paid, 80000)
}))

test('failure FIFO: unavailable oldest invoice must not silently pay a newer invoice out of order', () => audit({ fifo: true, prepare(db) { db.debts.find(d => d.id === 'd1').invoice_no = null; db.debts.find(d => d.id === 'd1').transaction_id = null } }, async ({ store, events }) => {
  const result = await store.payCustomerDebtsFIFO({ customerId: 'c1', amount: 30000 })
  assert.equal(writes(events).length, 0, diagnostic(result, events))
  assert.equal(result.ok, false)
}))

for (const action of ['edit', 'delete']) {
  const correct = (store, amount = 10000) => action === 'edit' ? store.editDebtPayment('p1', { amount }) : store.deleteDebtPayment('p1')
  for (const debtOnly of [false, true]) {
    test(`baseline correction ${action} ${debtOnly ? 'debt-only' : 'linked'} preserves initial DP`, () => audit({ correction: true, debtOnly }, async ({ store, db }) => {
      assert.equal((await correct(store)).ok, true)
      const paid = action === 'edit' ? 30000 : 20000
      balances(db, paid, 100000 - paid)
      assert.equal(historyTotal(db), paid - 20000)
      assert.equal(db.customers[0].total_debt, 100000 - paid)
    }))
  }
  test(`failure correction ${action}: invoice-only history also updates its transaction`, () => audit({ correction: true, transactionOnly: true }, async ({ store, db }) => {
    assert.equal((await correct(store)).ok, true)
    assert.equal(db.transactions[0].paid, 20000 + historyTotal(db), 'Successful correction must preserve paid = initial DP + payment history')
  }))
  for (const stage of ['payment read', 'payment write', 'debt read', 'debt write', 'transaction read', 'transaction write', 'transaction summary read', 'debt summary read', 'customer summary write']) {
    test(`failure correction ${action}: ${stage} cannot be silently ignored`, () => audit({ correction: true }, async ({ store, events, fail }) => {
      const match = {
        'payment read': lookup('debt_payments'),
        'payment write': at('debt_payments', action === 'edit' ? 'update' : 'delete'),
        'debt read': lookup('debts'), 'debt write': at('debts', 'update'),
        'transaction read': lookup('transactions'), 'transaction write': at('transactions', 'update'),
        'transaction summary read': summaryRead('transactions'), 'debt summary read': summaryRead('debts'),
        'customer summary write': at('customers', 'update'),
      }[stage]
      fail(request => (!stage.includes('summary read') || writes(events).length > 0) && match(request))
      const result = await correct(store)
      assert.equal(result.ok, false, diagnostic(result, events))
      if (stage === 'payment read') assert.equal(writes(events).length, 0)
      else if (!['debt read', 'transaction read'].includes(stage)) incomplete(result, events)
      else {
        assert.equal(!!result.needsReconciliation, false)
        assert.equal(writes(events).length, 0)
      }
    }))
  }
  test(`failure correction ${action}: missing linked debt is not a successful history-only correction`, () => audit({ correction: true, prepare(db) { db.debts = [] } }, async ({ store, events }) => {
    const result = await correct(store)
    assert.equal(result.ok, false)
    assert.equal(!!result.needsReconciliation, false)
    assert.equal(writes(events).length, 0)
  }))
  test(`failure correction ${action}: linked-debt preflight disconnect returns safe rejection`, () => audit({ correction: true }, async ({ store, events, fail }) => {
    fail(lookup('debts'), new Error('Synthetic preflight disconnect'))
    let result
    await assert.doesNotReject(async () => { result = await correct(store) })
    assert.equal(result.ok, false)
    assert.equal(!!result.needsReconciliation, false)
    assert.equal(writes(events).length, 0)
  }))
}

test('baseline correction edit: increase installment to full payment and reopen by deleting it', () => audit({ correction: true }, async ({ store, db }) => {
  assert.equal((await store.editDebtPayment('p1', { amount: 80000 })).ok, true)
  balances(db, 100000, 0)
  assert.equal(historyTotal(db), 80000)
  assert.equal((await store.deleteDebtPayment('p1')).ok, true)
  balances(db, 20000, 80000)
  assert.equal(historyTotal(db), 0)
}))

test('baseline correction edit: metadata-only edit leaves balances unchanged', () => audit({ correction: true }, async ({ store, db, events }) => {
  assert.equal((await store.editDebtPayment('p1', { paymentMethod: 'transfer', notes: 'Corrected receipt', paidAt: '2026-09-03T00:00:00Z', cashierId: 'owner2' })).ok, true)
  balances(db, 50000, 50000)
  assert.equal(db.debt_payments[0].amount, 30000)
  assert.equal(db.debt_payments[0].payment_method, 'transfer')
  assert.equal(db.debt_payments[0].cashier_id, 'owner2')
  assert.equal(db.debt_payments[0].notes, 'Corrected receipt')
  assert.deepEqual(writes(events).map(e => e.table), ['debt_payments'])
}))

test('failure correction edit: excessive amount cannot succeed with history above mirrored paid', () => audit({ correction: true }, async ({ store, db }) => {
  const before = clone(db)
  const result = await store.editDebtPayment('p1', { amount: 200000 })
  if (!result.ok) assert.deepEqual(db, before, 'Invalid correction should not partially persist')
  else {
    assert.equal(db.debts[0].paid, 20000 + historyTotal(db), 'Accepted correction must not silently clamp balances below DP + recorded payments')
    assert.equal(db.transactions[0].paid, db.debts[0].paid)
  }
}))

for (const amount of [-1, 'not money', Infinity]) {
  test(`failure correction edit: invalid amount ${String(amount)} is rejected, not converted to another receipt`, () => audit({ correction: true }, async ({ store, db, events }) => {
    const before = clone(db)
    const result = await store.editDebtPayment('p1', { amount })
    assert.equal(result.ok, false, diagnostic(result, events))
    assert.deepEqual(db, before)
  }))
}

test('baseline correction edit: repeating identical correction does not apply delta twice', () => audit({ correction: true }, async ({ store, db }) => {
  assert.equal((await store.editDebtPayment('p1', { amount: 10000 })).ok, true)
  assert.equal((await store.editDebtPayment('p1', { amount: 10000 })).ok, true)
  balances(db, 30000, 70000)
  assert.equal(db.debt_payments.length, 1)
}))

test('guard correction delete: repeated deletion cannot subtract a second time', () => audit({ correction: true }, async ({ store, db }) => {
  assert.equal((await store.deleteDebtPayment('p1')).ok, true)
  assert.equal((await store.deleteDebtPayment('p1')).ok, false)
  balances(db, 20000, 80000)
}))

test('baseline history: reads are oldest-first and read failure is not successful empty history', () => audit({ correction: true }, async ({ store, events, fail }) => {
  const result = await store.getDebtPayments('d1')
  assert.equal(result.ok, true)
  assert.equal(result.data[0].id, 'p1')
  assert.ok(events[0].request.steps.some(s => s.method === 'order' && s.args[0] === 'paid_at' && s.args[1].ascending))
  fail(at('debt_payments', 'select'))
  assert.equal((await store.getDebtPayments('d1')).ok, false)
  assert.equal(writes(events).length, 0)
}))

for (const response of [null, {}, { data: null }, { error: null }, { data: null, error: null }, { data: {}, error: null }, { data: [], error: null }]) {
  for (const table of ['transactions', 'debts', 'debt_payments']) {
    test('malformed ' + table + ' write ' + JSON.stringify(response) + ' stops and blocks repeat', () => audit({}, async ({ store, events, fail }) => {
      fail(at(table, table === 'debt_payments' ? 'insert' : 'update'), response)
      incomplete(await pay(store), events)
      const count = events.length
      incomplete(await pay(store), events)
      assert.equal(events.length, count, 'Uncertain payment must not be dispatched twice')
    }))
  }
}
for (const action of ['edit', 'delete']) {
  test(action + ' history dispatch failure blocks subsequent correction and payment', () => audit({ correction: true }, async ({ store, events, fail }) => {
    fail(at('debt_payments', action === 'edit' ? 'update' : 'delete'), new Error('Connection lost'))
    const correct = () => action === 'edit' ? store.editDebtPayment('p1', { amount: 10000 }) : store.deleteDebtPayment('p1')
    incomplete(await correct(), events)
    const count = events.length
    incomplete(await correct(), events)
    incomplete(await pay(store), events)
    assert.equal(writes(events).length, 1)
    assert.ok(events.length >= count)
  }))
}
test('preflight failure remains retryable', () => audit({ fifo: true }, async ({ store, events, fail }) => {
  fail(lookup('transactions'))
  const result = await pay(store)
  assert.equal(result.ok, false)
  assert.equal(!!result.needsReconciliation, false)
  assert.equal((await pay(store)).ok, true)
}))
test('payDebt fallback read throw returns safe rejection without a mutation', () => audit({ prepare(db) { db.debts[0].invoice_no = null } }, async ({ store, events, fail }) => {
  fail(lookup('transactions'), new Error('Read disconnected'))
  const result = await store.payDebt('d1', 30000)
  assert.equal(result.ok, false)
  assert.equal(!!result.needsReconciliation, false)
  assert.equal(writes(events).length, 0)
}))
test('paid order cancellation is rejected before deleting legacy cash postings', () => audit({}, async ({ store, events }) => {
  const result = await store.updateOrderStatus('t1', 'dibatalkan')
  assert.equal(result.ok, false)
  assert.equal(!!result.needsReconciliation, false)
  assert.equal(writes(events).length, 0)
}))

test('status Lunas cannot settle an outstanding invoice without a payment receipt', () => audit({}, async ({ store, events, db }) => {
  const before = clone(db)
  const result = await store.updateTransactionStatus('t1', 'lunas')
  assert.equal(result.ok, false)
  assert.equal(!!result.needsReconciliation, false)
  assert.match(result.error, /Tambah Pembayaran/)
  assert.equal(writes(events).length, 0)
  assert.deepEqual(db, before)
}))

for (const table of ['transactions', 'debts']) {
  for (const response of [{ data: null, error: null, count: null }, { data: [], error: null, count: null }, { data: { id: 'wrong' }, error: null, count: null }]) {
    test('synchronization requires the affected ' + table + ' row ' + JSON.stringify(response), () => audit({}, async ({ store, events, fail }) => {
      fail(at(table, 'update'), response)
      incomplete(await store.syncDebtPaymentStatus('AUDIT-1'), events)
    }))
  }
}
test('status change without settlement does not change paid or remaining', () => audit({}, async ({ store, db }) => {
  assert.equal((await store.updateTransactionStatus('t1', 'proses')).ok, true)
  assert.equal(db.transactions[0].paid, 20000)
  assert.equal(db.transactions[0].remaining, 80000)
  assert.equal(db.transactions[0].status, 'proses')
  assert.equal(db.debt_payments.length, 0)
}))
for (const table of ['transactions', 'debts']) {
  test(table + ' internal balance drift cannot be normalized by a new payment', () => audit({ prepare(db) { db[table][0].remaining = 1 } }, async ({ store, events, db }) => {
    const before = clone(db)
    const result = await pay(store)
    assert.equal(result.ok, false)
    assert.equal(!!result.needsReconciliation, false)
    assert.equal(writes(events).length, 0)
    assert.deepEqual(db, before)
  }))
}

for (const method of ['cash', 'transfer', 'qris']) {
  test('Order passes selected tender ' + method + ' to payment history', () => audit({}, async ({ store, db }) => {
    assert.equal((await store.updateTransactionPayment('t1', 30000, method)).ok, true)
    assert.equal(db.debt_payments[0].payment_method, method)
  }))
}
for (const method of ['hutang', '', 'bogus', null]) {
  test('invalid tender ' + String(method) + ' is rejected before any write', () => audit({}, async ({ store, events }) => {
    const result = await pay(store, 30000, { paymentMethod: method })
    assert.equal(result.ok, false)
    assert.equal(!!result.needsReconciliation, false)
    assert.equal(writes(events).length, 0)
  }))
}
test('legacy missing invoice column can use a definitively rejected insert fallback', () => audit({}, async ({ store, db, events, fail }) => {
  fail(at('debt_payments', 'insert'), { data: null, error: { code: 'PGRST204', message: "Could not find the 'invoice_no' column" } })
  assert.equal((await pay(store)).ok, true)
  assert.equal(db.debt_payments.length, 1)
  assert.equal(db.debt_payments[0].debt_id, 'd1')
  assert.equal(db.debt_payments[0].amount, 30000)
}))

for (const action of ['edit', 'delete']) {
  for (const mismatch of ['customer_id', 'invoice_no', 'total_debt', 'paid', 'remaining']) {
    test(action + ' correction rejects mismatched ' + mismatch + ' before history mutation', () => audit({ correction: true,
      prepare(db) { db.debts[0][mismatch] = ['customer_id', 'invoice_no'].includes(mismatch) ? 'OTHER' : 1 },
    }, async ({ store, db, events }) => {
      const before = clone(db)
      const result = await (action === 'edit' ? store.editDebtPayment('p1', { amount: 10000 }) : store.deleteDebtPayment('p1'))
      assert.equal(result.ok, false)
      assert.equal(!!result.needsReconciliation, false)
      assert.deepEqual(db, before)
      assert.equal(writes(events).length, 0)
    }))
  }
}
test('uncertain customer does not block an unrelated customer payment', () => audit({ fifo: true,
  prepare(db) { db.transactions[1].customer_id = 'c2'; db.debts[0].customer_id = 'c2'; db.customers.push({ id: 'c2' }) },
}, async ({ store, events, db, fail }) => {
  fail(at('debt_payments', 'insert'))
  incomplete(await pay(store), events)
  const result = await pay(store, 10000, { invoice_no: 'AUDIT-2' })
  assert.equal(result.ok, true)
  assert.equal(db.transactions[1].paid, 20000)
}))
for (const action of ['deleteDebt', 'deleteTransaction']) {
  for (const response of [rejected, new Error('Delete disconnected'), {}, { data: null, error: null }]) {
    test(action + ' unconfirmed deletion preserves failure and blocks retry ' + JSON.stringify(response), () => audit({ prepare: unpaid }, async ({ store, events, fail }) => {
      fail(at(action === 'deleteDebt' ? 'debts' : 'transactions', 'delete'), response)
      const id = action === 'deleteDebt' ? 'd1' : 't1'
      incomplete(await store[action](id), events)
      incomplete(await store[action](id), events)
      assert.equal(writes(events).length, 1)
    }))
  }
  test(action + ' summary failure after deletion is incomplete', () => audit({ prepare: unpaid }, async ({ store, events, fail }) => {
    fail(request => writes(events).length > 0 && summaryRead('transactions')(request))
    incomplete(await store[action](action === 'deleteDebt' ? 'd1' : 't1'), events)
  }))
}

function unpaid(db) {
  db.transactions.forEach(t => Object.assign(t, { paid: 0, dp: 0, remaining: t.total }))
  db.debts.forEach(d => Object.assign(d, { paid: 0, remaining: d.total_debt }))
}
test('tiny legacy fractional artifacts normalize only on explicit payment', () => audit({ prepare(db) {
  db.transactions[0].total = 100000.00000001
  db.transactions[0].remaining = 80000.00000001
} }, async ({ store, db }) => {
  assert.equal((await pay(store)).ok, true)
  assert.equal(db.transactions[0].paid, 50000)
  assert.equal(db.transactions[0].remaining, 50000)
  assert.equal(db.debts[0].paid, 50000)
  assert.equal(db.debt_payments[0].amount, 30000)
}))
test('tiny legacy fractional artifacts permit a valid receipt correction', () => audit({ correction: true, prepare(db) {
  db.transactions[0].total = 100000.00000001
  db.transactions[0].remaining = 50000.00000001
  db.debt_payments[0].amount = 30000.00000001
} }, async ({ store, db }) => {
  assert.equal((await store.editDebtPayment('p1', { amount: 40000 })).ok, true)
  assert.equal(db.transactions[0].paid, 60000)
  assert.equal(db.debts[0].paid, 60000)
}))
for (const value of [null, -0.01, Infinity, NaN, 'not money']) {
  test('invalid raw balance ' + String(value) + ' cannot be normalized by a payment', () => audit({ prepare(db) { db.transactions[0].paid = value } }, async ({ store, events }) => {
    assert.equal((await pay(store)).ok, false)
    assert.equal(writes(events).length, 0)
  }))
}
test('an equation mismatch of at least one rupiah cannot be hidden by rounding', () => audit({ prepare(db) {
  Object.assign(db.transactions[0], { total: 100000.49, paid: 19999.51, remaining: 79999.51 })
} }, async ({ store, events }) => {
  assert.equal((await pay(store)).ok, false)
  assert.equal(writes(events).length, 0)
}))
for (const entry of ['refreshAll', 'refreshTransactions', 'refreshDebts', 'refreshDebtPayments']) {
  test(entry + ' emits soft-delete filters at the financial read boundary', () => storeFixture(false, async (store, { requests, outcome }) => {
    outcome.data = []
    await store[entry]()
    const financial = requests.filter(r => ['transactions', 'debts', 'debt_payments'].includes(r.table))
    assert.equal(financial.length, entry === 'refreshAll' ? 3 : 1)
    for (const request of financial) {
      assert.ok(request.steps.some(s => s.method === 'is' && s.args[0] === 'deleted_at' && s.args[1] === null))
      if (request.table === 'debt_payments') assert.ok(request.steps.find(s => s.method === 'select').args[0].includes('deleted_at'))
    }
  }))
}
test('transaction mapping retains a deleted flag for downstream financial guards', () => storeFixture(false, async (store, { script }) => {
  script.push(ok({ id: 'deleted', invoice_no: 'DELETED', deleted_at: '2026-09-01T00:00:00Z' }))
  const trx = await store.getTransactionByInvoice('DELETED')
  assert.equal(trx.deletedAt, '2026-09-01T00:00:00Z')
}))
test('FIFO only allocates debts in the selected book, not an older invoice in another book', () => audit({ fifo: true, book: 'A', prepare(db) {
  db.transactions.forEach(t => { t.book_id = t.id === 't1' ? 'B' : 'A' })
  db.debts.forEach(d => { d.book_id = d.id === 'd1' ? 'B' : 'A' })
} }, async ({ store, db }) => {
  assert.equal(store.activeBookId, 'A')
  assert.equal(store.debts.length, 1)
  const result = await store.payCustomerDebtsFIFO({ customerId: 'c1', amount: 30000 })
  assert.equal(result.ok, true)
  assert.deepEqual(db.debt_payments.map(p => [p.invoice_no, p.amount]), [['AUDIT-2', 30000]])
  assert.equal(db.transactions[0].paid, 20000)
}))
for (const action of ['deleteTransaction', 'deleteDebt']) {
  for (const historyOnly of [false, true]) {
    test(action + ' refuses paid records or retained history before destructive mutation ' + historyOnly, () => audit({ correction: true, prepare(db) { if (historyOnly) unpaid(db) } }, async ({ store, db, events }) => {
      const before = clone(db)
      const result = await store[action](action === 'deleteDebt' ? 'd1' : 't1')
      assert.equal(result.ok, false)
      assert.equal(!!result.needsReconciliation, false)
      assert.equal(result.needsReview, true)
      assert.equal(writes(events).length, 0)
      assert.deepEqual(db, before)
    }))
  }
  test(action + ' permits deletion of an unpaid record with no receipt history', () => audit({ prepare: unpaid }, async ({ store, db }) => {
    assert.equal((await store[action](action === 'deleteDebt' ? 'd1' : 't1')).ok, true)
    assert.equal(db[action === 'deleteDebt' ? 'debts' : 'transactions'].length, 0)
  }))
}
test('unpaid cancellation with outstanding linked debt is rejected before any write', () => audit({ prepare: unpaid }, async ({ store, events, db }) => {
  const before = clone(db)
  const result = await store.updateOrderStatus('t1', 'dibatalkan')
  assert.equal(result.ok, false)
  assert.equal(!!result.needsReconciliation, false)
  assert.equal(result.needsReview, true)
  assert.equal(writes(events).length, 0)
  assert.deepEqual(db, before)
}))
test('unpaid cancellation without a linked debt or receipts still works', () => audit({ transactionOnly: true, prepare: unpaid }, async ({ store, db }) => {
  assert.equal((await store.updateOrderStatus('t1', 'dibatalkan')).ok, true)
  assert.equal(db.transactions[0].order_status, 'dibatalkan')
}))
test('correction cannot increase a receipt whose existing history exceeds parent paid', () => audit({ correction: true, prepare(db) { db.debt_payments[0].amount = 70000 } }, async ({ store, db, events }) => {
  const before = clone(db)
  const result = await store.editDebtPayment('p1', { amount: 80000 })
  assert.equal(result.ok, false)
  assert.equal(!!result.needsReconciliation, false)
  assert.equal(result.needsReview, true)
  assert.equal(writes(events).length, 0)
  assert.deepEqual(db, before)
}))
test('correction sums all active linked receipts but ignores deleted receipt history', () => audit({ correction: true, prepare(db) {
  db.debt_payments.push({ id: 'old', debt_id: 'd1', invoice_no: 'AUDIT-1', amount: 90000, deleted_at: '2026-09-01' })
} }, async ({ store, db }) => {
  assert.equal((await store.editDebtPayment('p1', { amount: 40000 })).ok, true)
  assert.equal(db.transactions[0].paid, 60000)
}))
test('customer summary excludes deleted and cancelled turnover and deleted debts', () => audit({ prepare(db) {
  db.transactions.push({ ...db.transactions[0], id: 'cancelled', invoice_no: 'CANCELLED', total: 200000, order_status: 'dibatalkan' },
    { ...db.transactions[0], id: 'deleted', invoice_no: 'DELETED', total: 300000, deleted_at: '2026-09-01' })
  db.debts.push({ ...db.debts[0], id: 'deleted-debt', remaining: 900000, deleted_at: '2026-09-01' })
} }, async ({ store, db }) => {
  assert.equal((await store.recalculateCustomerSummary('c1')).ok, true)
  assert.equal(db.customers[0].total_spent, 100000)
  assert.equal(db.customers[0].total_transactions, 1)
  assert.equal(db.customers[0].total_debt, 80000)
}))
test('customer summary does not silently clear unresolved cancelled linked receivables', () => audit({ prepare(db) { db.transactions[0].order_status = 'dibatalkan' } }, async ({ store, db, events }) => {
  const before = clone(db)
  const result = await store.recalculateCustomerSummary('c1')
  assert.equal(result.ok, false)
  assert.equal(result.needsReview, true)
  assert.equal(!!result.needsReconciliation, false)
  assert.equal(writes(events).length, 0)
  assert.deepEqual(db, before)
}))
for (const response of [{}, { error: null }, { data: null }, { data: null, error: null, count: 0 }, { data: null, error: null, count: null }, { data: [], error: null, count: null }, { data: { id: 'wrong' }, error: null, count: null }]) {
  test('malformed customer summary result ' + JSON.stringify(response) + ' is incomplete', () => audit({}, async ({ store, events, fail }) => {
    fail(at('customers', 'update'), response)
    incomplete(await pay(store), events)
  }))
}

for (const action of ['payment', 'editDebtPayment', 'deleteDebtPayment', 'deleteTransaction', 'deleteDebt']) {
  test(action + ' checks unresolved customer balances before any write', () => audit({
    correction: action.includes('DebtPayment'),
    prepare(db) {
      if (['deleteTransaction', 'deleteDebt'].includes(action)) unpaid(db)
      db.transactions.push({ ...db.transactions[0], id: 'cancelled', invoice_no: 'CANCELLED', order_status: 'dibatalkan' })
      db.debts.push({ ...db.debts[0], id: 'cancelled-debt', transaction_id: 'cancelled', invoice_no: 'CANCELLED' })
    },
  }, async ({ store, db, events }) => {
    const before = clone(db)
    const result = action === 'payment' ? await pay(store)
      : action === 'editDebtPayment' ? await store.editDebtPayment('p1', { amount: 40000 })
      : await store[action](action === 'deleteDebtPayment' ? 'p1' : action === 'deleteDebt' ? 'd1' : 't1')
    assert.equal(result.ok, false)
    assert.equal(result.needsReview, true)
    assert.equal(!!result.needsReconciliation, false)
    assert.equal(writes(events).length, 0)
    assert.deepEqual(db, before)
  }))
}
test('displayed debt history loads more than one page without writes', () => audit({ correction: true, prepare(db) {
  const base = db.debt_payments[0]
  db.debt_payments = Array.from({ length: 1001 }, (_, i) => ({ ...base, id: `p${String(i).padStart(4, '0')}` }))
} }, async ({ store, events }) => {
  const result = await store.getDebtPayments('d1')
  assert.equal(result.ok, true)
  assert.equal(result.data.length, 1001)
  assert.equal(new Set(result.data.map(row => row.id)).size, 1001)
  assert.equal(writes(events).length, 0)
}))
test('displayed debt history excludes soft-deleted receipts', () => audit({ correction: true, prepare(db) {
  db.debt_payments.push({ ...db.debt_payments[0], id: 'deleted', amount: 90000, deleted_at: '2026-09-01' })
} }, async ({ store, events }) => {
  const result = await store.getDebtPayments('d1')
  assert.equal(result.ok, true)
  assert.deepEqual(result.data.map(row => row.id), ['p1'])
  assert.equal(writes(events).length, 0)
}))
for (const table of ['transactions', 'debts']) {
  test(table + ' unavailable during customer preflight cannot cause partial payment', () => audit({}, async ({ store, db, events, fail }) => {
    const before = clone(db)
    fail(summaryRead(table))
    const result = await pay(store)
    assert.equal(result.ok, false)
    assert.equal(!!result.needsReconciliation, false)
    assert.equal(writes(events).length, 0)
    assert.deepEqual(db, before)
  }))
}
