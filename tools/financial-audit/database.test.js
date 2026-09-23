import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'

const require = createRequire(import.meta.url)
let PGlite
try { ({ PGlite } = require('../security-lab/node_modules/@electric-sql/pglite')) } catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error
  ;({ PGlite } = require('/private/tmp/skupy-security-stage2/tools/security-lab/node_modules/@electric-sql/pglite'))
}
const schema = await readFile(new URL('../security-lab/business-schema.sql', import.meta.url), 'utf8')
const customer = '20000000-0000-4000-8000-000000000001'
const order = '20000000-0000-4000-8000-000000000002'
const debt = '20000000-0000-4000-8000-000000000003'

// A fresh in-memory PostgreSQL engine per case. No endpoints or credentials.
async function setup(t, paid = 20000) {
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated;
    CREATE SCHEMA auth; CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT NULL::uuid $$;`)
  await db.exec(schema)
  await db.exec(`INSERT INTO accounts(code,name,type,normal)
    SELECT code,code,'asset','debit' FROM unnest(ARRAY['1000','1100','1200','4000','5000','6000']) code;
    INSERT INTO customers(id,name) VALUES ('${customer}','Synthetic audit customer');`)
  await db.query(`INSERT INTO transactions(id,invoice_no,customer_id,total,paid,dp,remaining,payment_method,created_at)
    VALUES ($1,'AUDIT-001',$2,100000,$3::numeric,$3::numeric,100000-$3::numeric,'cash','2026-08-20T10:00:00Z')`, [order, customer, paid])
  await db.query(`INSERT INTO debts(id,transaction_id,customer_id,invoice_no,total_debt,paid,remaining)
    VALUES ($1,$2,$3,'AUDIT-001',100000,$4::numeric,100000-$4::numeric)`, [debt, order, customer, paid])
  return db
}
const number = async (db, sql) => Number((await db.query(sql)).rows[0].value)
const dashboard = async (db, from = '2026-08-01', to = '2026-09-30') =>
  (await db.query('SELECT acc_dashboard($1::date,$2::date) value', [from, to])).rows[0].value
const summary = async (db, from = '2026-08-01', to = '2026-09-30') =>
  (await db.query('SELECT acc_summary($1::date,$2::date) value', [from, to])).rows[0].value
async function installment(db, amount = 30000) {
  // Model the current client's read/absolute-write schedule; not a hook invocation.
  const paidBefore = await number(db, `SELECT paid value FROM transactions WHERE id='${order}'`)
  const paidAfter = paidBefore + amount
  const remaining = 100000 - paidAfter
  await db.query('UPDATE transactions SET paid=$1,dp=$1,remaining=$2 WHERE id=$3', [paidAfter, remaining, order])
  await db.query('UPDATE debts SET paid=$1,remaining=$2 WHERE id=$3', [paidAfter, remaining, debt])
  await db.query(`INSERT INTO debt_payments(debt_id,invoice_no,amount,payment_method,paid_at)
    VALUES ($1,'AUDIT-001',$2,'transfer','2026-09-10T10:00:00Z')`, [debt, amount])
}

test('baseline: invoice DP posts balanced revenue, cash and receivable', async t => {
  const db = await setup(t)
  const totals = await summary(db)
  assert.equal(totals.revenue, 100000)
  assert.equal(totals.cash_in, 20000)
  assert.equal(totals.piutang, 80000)
  assert.equal(await number(db, 'SELECT sum(debit-credit) value FROM accounting_entries'), 0)
})

test('baseline: installment updates debt and total receipts without double counting', async t => {
  const db = await setup(t)
  await installment(db)
  assert.equal((await dashboard(db)).uang_masuk_total, 50000)
  assert.equal(await number(db, `SELECT remaining value FROM debts WHERE id='${debt}'`), 50000)
  assert.equal(await number(db, 'SELECT sum(debit-credit) value FROM accounting_entries'), 0)
})

test('receipt date: September installment agrees between cash ledger and dashboard', async t => {
  const db = await setup(t)
  await installment(db)
  const expected = (await dashboard(db, '2026-09-01', '2026-09-30')).uang_masuk_total
  const actual = (await summary(db, '2026-09-01', '2026-09-30')).cash_in
  t.diagnostic(JSON.stringify({ expectedSeptember: 30000, dashboard: expected, ledger: actual }))
  assert.equal(expected, 30000)
  assert.equal(actual, expected)
})

test('receipt method: cash DP plus transfer installment agrees with ledger balances', async t => {
  const db = await setup(t)
  await installment(db)
  const actual = await summary(db)
  const report = await dashboard(db)
  t.diagnostic(JSON.stringify({ expectedCash: 20000, expectedBank: 30000,
    ledgerCash: actual.kas, ledgerBank: actual.bank, dashboardCash: report.saldo_kas, dashboardBank: report.saldo_rekening }))
  assert.deepEqual({ cash: report.saldo_kas, bank: report.saldo_rekening }, { cash: 20000, bank: 30000 })
  assert.deepEqual({ cash: actual.kas, bank: actual.bank }, { cash: 20000, bank: 30000 })
})

test('cancellation: unpaid cancelled invoice leaves matching receivables across modules', async t => {
  const db = await setup(t, 0)
  await db.query("UPDATE transactions SET order_status='dibatalkan' WHERE id=$1", [order])
  const report = await dashboard(db)
  const ledger = await summary(db)
  t.diagnostic(JSON.stringify({ dashboardReceivable: report.piutang_aktif, ledgerReceivable: ledger.piutang }))
  assert.equal(report.penjualan, 0)
  // Full unpaid cancellation with no separate cancellation fee in this fixture.
  assert.equal(ledger.piutang, 0)
  assert.equal(report.piutang_aktif, 0)
})

test('cancellation: received DP cannot disappear without a refund movement', async t => {
  const db = await setup(t)
  await db.query("UPDATE transactions SET order_status='dibatalkan' WHERE id=$1", [order])
  const actual = await dashboard(db)
  const ledger = await summary(db)
  t.diagnostic(JSON.stringify({ received: 20000, refunds: ledger.cash_out, dashboardReceipts: actual.uang_masuk_total, ledgerReceipts: ledger.cash_in }))
  assert.equal(ledger.cash_out, 0)
  assert.deepEqual({ dashboard: actual.uang_masuk_total, ledger: ledger.cash_in }, { dashboard: 20000, ledger: 20000 })
})

test('customer recap: cancelled order turnover matches accounting turnover', async t => {
  const db = await setup(t, 0)
  await db.query("UPDATE transactions SET order_status='dibatalkan' WHERE id=$1", [order])
  await db.query('SELECT recalculate_customer_summary($1)', [customer])
  const spent = await number(db, `SELECT total_spent value FROM customers WHERE id='${customer}'`)
  const sales = (await dashboard(db)).penjualan
  t.diagnostic(JSON.stringify({ customerSpent: spent, dashboardSales: sales }))
  assert.equal(spent, sales)
})

test('opening debt receipt: payment is also present in cash ledger', async t => {
  const db = await setup(t, 0)
  await db.query('DELETE FROM transactions WHERE id=$1', [order])
  await db.query(`INSERT INTO debts(id,customer_id,invoice_no,total_debt,paid,remaining,is_opening)
    VALUES ($1,$2,'OPENING-AUDIT',100000,0,100000,true)`, [debt, customer])
  await db.query('UPDATE debts SET paid=30000,remaining=70000 WHERE id=$1', [debt])
  await db.query(`INSERT INTO debt_payments(debt_id,invoice_no,amount,payment_method,paid_at)
    VALUES ($1,'OPENING-AUDIT',30000,'transfer','2026-09-10T10:00:00Z')`, [debt])
  const actual = (await summary(db)).cash_in
  const expected = (await dashboard(db)).uang_masuk_total
  t.diagnostic(JSON.stringify({ dashboardReceipts: expected, ledgerReceipts: actual }))
  assert.equal(expected, 30000)
  assert.equal(actual, expected)
})

test('reposting failure: successful SQL update must not leave a stale ledger', async t => {
  const db = await setup(t, 0)
  await db.exec('ALTER TABLE accounting_entries ADD CONSTRAINT synthetic_posting_failure CHECK (credit < 150000)')
  let rejected = false
  try { await db.query('UPDATE transactions SET total=200000,remaining=200000 WHERE id=$1', [order]) }
  catch { rejected = true }
  const total = await number(db, `SELECT total value FROM transactions WHERE id='${order}'`)
  const revenue = (await summary(db)).revenue
  t.diagnostic(JSON.stringify({ rejected, invoice: total, ledgerRevenue: revenue }))
  assert.equal(total, revenue, 'Either both stay at 100000 after rejection or both become 200000')
})

test('concurrent readers: two accepted payments must not overwrite one another', async t => {
  const db = await setup(t)
  const read = () => number(db, `SELECT paid value FROM transactions WHERE id='${order}'`)
  const beforeA = await read()
  const beforeB = await read()
  // Deterministic interleaving of two clients that both read before either writes.
  for (const [before, amount] of [[beforeA, 30000], [beforeB, 40000]]) {
    const paidAfter = before + amount
    await db.query('UPDATE transactions SET paid=$1,dp=$1,remaining=100000-$1::numeric WHERE id=$2', [paidAfter, order])
    await db.query('UPDATE debts SET paid=$1,remaining=100000-$1::numeric WHERE id=$2', [paidAfter, debt])
    await db.query(`INSERT INTO debt_payments(debt_id,invoice_no,amount,payment_method,paid_at)
      VALUES ($1,'AUDIT-001',$2,'transfer','2026-09-10T10:00:00Z')`, [debt, amount])
  }
  const actual = await read()
  const installments = await number(db, 'SELECT sum(amount) value FROM debt_payments')
  const received = 20000 + installments
  t.diagnostic(JSON.stringify({ actualPaid: actual, received, expectedRemaining: 10000 }))
  assert.equal(await number(db, 'SELECT count(*) value FROM debt_payments'), 2)
  assert.equal(installments, 70000)
  const mirrored = (await db.query(`SELECT paid,remaining FROM debts WHERE id='${debt}'`)).rows[0]
  const remaining = await number(db, `SELECT remaining value FROM transactions WHERE id='${order}'`)
  assert.deepEqual({ transactionPaid: actual, transactionRemaining: remaining,
    debtPaid: Number(mirrored.paid), debtRemaining: Number(mirrored.remaining) },
  { transactionPaid: 90000, transactionRemaining: 10000, debtPaid: 90000, debtRemaining: 10000 })
})
