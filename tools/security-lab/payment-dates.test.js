import test from 'node:test'
import assert from 'node:assert/strict'
import { datesFixture, installDates, actorQuery, submit, correct, payment, allRows, iso, id, actors, book, order, debt, customer } from './payment-dates-fixture.js'
import { change, draft } from './invoice-lifecycle-fixture.js'

test('dated submission posts the selected WIB day and preserves server recording time', async t => {
  const db = await datesFixture(t)
  const api = (await db.query("SELECT to_regprocedure('public.pos_submit_payment_dated(uuid,text,numeric,text,text,date)') IS NOT NULL available")).rows[0]
  assert.equal(api.available, true, 'Dated payment RPC must exist')
  const before = Date.now()
  const result = await submit(db)
  const p = await payment(db)
  assert.equal(result.request.paymentDate, '2026-09-01')
  assert.equal(iso(p.paid_at), '2026-08-31T17:00:00.000Z')
  assert.ok(new Date(p.recorded_at).getTime() >= before - 1000)
  assert.equal(result.result.paid, 100000)
  const ledger = (await db.query(`SELECT e.received_at=p.recorded_at recorded,e.effective_at=p.paid_at effective,
    m.moved_at=p.paid_at cash FROM debt_payments p JOIN pos_security.payment_events e ON e.payment_id=p.id
    JOIN cash_movements m ON m.source_id=p.id`)).rows
  assert.deepEqual(ledger, [{ recorded: true, effective: true, cash: true }])
  assert.deepEqual((await db.query("SELECT entry_date::text AS day FROM accounting_entries WHERE source_type='debt_payment' ORDER BY account_code")).rows,
    [{ day: '2026-09-01' }, { day: '2026-09-01' }])
})

test('dated replay and recovery preserve original request and reject a changed date or actor', async t => {
  const db = await datesFixture(t)
  const result = await submit(db)
  const before = await allRows(db)
  assert.deepEqual(await submit(db, { zone: 'America/Los_Angeles' }), result)
  assert.deepEqual((await actorQuery(db, 'SELECT pos_payment_status($1) result', [id(800)]))[0].result, result)
  await assert.rejects(submit(db, { day: '2026-09-02' }), { code: '22023' })
  for (const patch of [{ amount: 100001 }, { method: 'qris' }, { notes: 'Changed request' }])
    await assert.rejects(submit(db, patch), { code: '22023' })
  await assert.rejects(submit(db, { actor: 'owner' }), { code: '42501' })
  await assert.rejects(submit(db, { legacy: true }), { code: '22023' })
  assert.deepEqual(await allRows(db), before)
})

test('migration backfills old timestamp without changing legacy replay evidence', async t => {
  let old, saved
  const db = await datesFixture(t, { beforeDates: async db => {
    saved = await submit(db, { legacy: true })
    old = await payment(db)
  } })
  const p = await payment(db)
  assert.equal(iso(p.paid_at), iso(old.paid_at))
  assert.equal(iso(p.recorded_at), iso(old.paid_at))
  assert.deepEqual(await submit(db, { legacy: true }), saved)
  assert.equal(Object.hasOwn(saved.request, 'paymentDate'), false)
  await assert.rejects(submit(db), { code: '22023' })
  const next = await submit(db, { legacy: true, op: id(801) })
  assert.equal(Object.hasOwn(next.request, 'paymentDate'), false)
  assert.equal((await db.query('SELECT bool_and(paid_at=recorded_at) same FROM debt_payments')).rows[0].same, true)
})

test('backfill preserves nullable legacy metadata and deleted receipts without rewriting history', async t => {
  const db = await datesFixture(t, { paid: 100000, mutate: async db => {
    await db.query(`INSERT INTO debt_payments(id,debt_id,invoice_no,amount,payment_method,paid_at,deleted_at)
      VALUES ($1,$2,'INV-LIFE',100000,'cash','2026-08-21T10:12:34.123456Z','2026-08-22T00:00:00Z')`, [id(781), debt])
  } })
  const p = (await db.query(`SELECT customer_id,book_id,paid_at=recorded_at preserved,
    paid_at::text stamp,deleted_at IS NOT NULL deleted FROM debt_payments`)).rows[0]
  assert.deepEqual(p, { customer_id: null, book_id: null, preserved: true,
    stamp: '2026-08-21 10:12:34.123456+00', deleted: true })
})

test('missing historical timestamps abort migration without inventing provenance', async t => {
  const db = await datesFixture(t, { migrate: false, mutate: db => db.query(`INSERT INTO debt_payments
    (id,debt_id,invoice_no,amount,payment_method,paid_at) VALUES ($1,$2,'INV-LIFE',10,'cash',NULL)`, [id(782), debt]) })
  const before = await allRows(db)
  await assert.rejects(installDates(db), error => error.code === '55000' && /reconcile/i.test(error.message))
  await db.exec('ROLLBACK')
  assert.deepEqual(await allRows(db), before)
  assert.equal((await db.query("SELECT count(*)::int n FROM information_schema.columns WHERE table_schema='public' AND table_name='debt_payments' AND column_name='recorded_at'")).rows[0].n, 0)
})

test('unreviewed payment writer definitions abort migration instead of being overwritten', async t => {
  const db = await datesFixture(t, { migrate: false })
  const definition = (await db.query("SELECT pg_get_functiondef('public.pos_record_payment(uuid,text,numeric,text,text)'::regprocedure) body")).rows[0].body
  await db.exec(definition.replace("'payment denied'", "'Modified payment access rule'"))
  const before = await allRows(db)
  await assert.rejects(installDates(db), error => error.code === '55000' && /definition|baseline/i.test(error.message))
  await db.exec('ROLLBACK')
  assert.deepEqual(await allRows(db), before)
})

test('staff date correction is atomic, audited, CAS protected, and replayable after later correction', async t => {
  const db = await datesFixture(t)
  const submitted = await submit(db)
  const p = await payment(db)
  const before = await allRows(db)
  const args = { paymentId: p.id, expected: p.paid_at }
  const result = await correct(db, args)
  assert.deepEqual(Object.keys(result).sort(), ['paid_at', 'payment_id', 'recorded_at'])
  assert.equal(result.payment_id, p.id)
  assert.equal(iso(result.paid_at), '2026-09-01T17:00:00.000Z')
  assert.equal(iso(result.recorded_at), iso(p.recorded_at))
  const after = await allRows(db)
  for (const name of ['public.transactions', 'public.debts', 'public.customers', 'pos_security.payment_baselines',
    'pos_security.payment_operations', 'pos_security.payment_client_receipts']) assert.deepEqual(after[name], before[name], name)
  assert.equal((await db.query('SELECT count(*)::int n FROM pos_security.payment_date_operations')).rows[0].n, 1)
  const audit = (await db.query('SELECT * FROM pos_security.payment_date_operations')).rows[0]
  assert.equal(audit.actor_auth_user_id, actors.cashier.auth)
  assert.equal(audit.reason, 'Correct bank statement day')
  assert.equal(iso(audit.old_paid_at), iso(p.paid_at))
  assert.equal(iso(audit.new_paid_at), iso(result.paid_at))
  assert.deepEqual(await correct(db, args), result)
  await assert.rejects(correct(db, { ...args, op: id(901) }), { code: '40001' })
  await assert.rejects(correct(db, { ...args, day: '2026-09-03' }), { code: '22023' })
  await correct(db, { ...args, op: id(902), expected: result.paid_at, day: '2026-09-03' })
  assert.deepEqual(await correct(db, args), result)
  assert.deepEqual(await submit(db), submitted)
  assert.deepEqual((await actorQuery(db, 'SELECT pos_payment_status($1) result', [id(800)]))[0].result, submitted)
  assert.equal(iso((await payment(db)).paid_at), '2026-09-02T17:00:00.000Z')
  assert.equal((await db.query(`SELECT bool_and(e.effective_at=p.paid_at AND e.received_at=p.recorded_at
    AND m.moved_at=p.paid_at AND j.entry_date=(p.paid_at AT TIME ZONE 'Asia/Jakarta')::date) valid
    FROM debt_payments p JOIN pos_security.payment_events e ON e.payment_id=p.id
    JOIN cash_movements m ON m.source_id=p.id JOIN accounting_entries j ON j.source_id=p.id`)).rows[0].valid, true)
  const next = await submit(db, { op: id(802), day: '2026-09-04', method: 'qris' })
  assert.equal(next.result.paid, 200000)
  assert.equal(next.result.remaining, 300000)
})

test('same-day correction preserves a historical precise timestamp', async t => {
  const db = await datesFixture(t, { beforeDates: db => submit(db, { legacy: true }) })
  const p = await payment(db)
  const day = (await db.query("SELECT (paid_at AT TIME ZONE 'Asia/Jakarta')::date::text AS day FROM debt_payments")).rows[0].day
  const result = await correct(db, { paymentId: p.id, expected: p.paid_at, day })
  assert.equal(iso(result.paid_at), iso(p.paid_at))
  assert.equal(iso(result.recorded_at), iso(p.paid_at))
})

test('initial DP stays immutable while mixed dated tenders and corrections preserve the ledger balance', async t => {
  const db = await datesFixture(t, { paid: 200000 })
  const expected = (await db.query(`SELECT jsonb_build_object('invoice_no',invoice_no,'customer_id',customer_id,'book_id',book_id,
    'total',total,'paid',paid,'dp',dp,'remaining',remaining,'payment_method',payment_method,'created_at',created_at) value
    FROM transactions WHERE id=$1`, [order])).rows[0].value
  await actorQuery(db, 'SELECT pos_reconcile_initial_receipt($1,$2,$3)', [order, expected, 'Synthetic initial DP statement'], { actor: 'owner' })
  const original = (await db.query("SELECT to_jsonb(j) row FROM accounting_entries j WHERE source_type='sale' ORDER BY id")).rows
  await submit(db, { method: 'cash' })
  await submit(db, { op: id(801), method: 'qris', day: '2026-09-02' })
  const p = await payment(db)
  await correct(db, { paymentId: p.id, expected: p.paid_at, day: '2026-09-03' })
  const final = await submit(db, { op: id(802), method: 'transfer', day: '2026-09-04' })
  assert.equal(final.result.remaining, 0)
  assert.equal(final.result.paid, 500000)
  assert.deepEqual((await db.query("SELECT to_jsonb(j) row FROM accounting_entries j WHERE source_type='sale' ORDER BY id")).rows, original)
  assert.equal((await db.query('SELECT dp::int n FROM transactions')).rows[0].n, 200000)
  assert.equal((await db.query("SELECT sum(amount)::int n FROM cash_movements WHERE direction='in'")).rows[0].n, 500000)
  const before = await allRows(db)
  await assert.rejects(submit(db, { op: id(803), amount: 1 }), { code: '22023' })
  assert.deepEqual(await allRows(db), before)
})

test('scope denies outsiders, inactive identities, anonymous callers and revoked books', async t => {
  const db = await datesFixture(t)
  await submit(db)
  const p = await payment(db)
  const args = { paymentId: p.id, expected: p.paid_at }
  for (const actor of ['foreign', 'inactive']) {
    await assert.rejects(correct(db, { ...args, actor }), { code: '42501' })
    await assert.rejects(submit(db, { actor, op: id(850) }), { code: '42501' })
  }
  await assert.rejects(correct(db, { ...args, role: 'anon' }), { code: '42501' })
  await assert.rejects(submit(db, { role: 'anon' }), { code: '42501' })
  await correct(db, args)
  await db.query('DELETE FROM admin_book_access WHERE admin_id=$1', [actors.cashier.admin])
  await assert.rejects(correct(db, args), { code: '42501' })
  await assert.rejects(actorQuery(db, 'SELECT pos_payment_status($1)', [id(800)]), { code: '42501' })
})

test('scope permits authorized book staff on linked invoices and PIC on hidden orders', async t => {
  const db = await datesFixture(t, { mutate: async db => {
    await db.query('UPDATE transactions SET cashier_id=NULL WHERE id=$1', [order])
    await db.query('UPDATE accounting_entries SET cashier_id=NULL WHERE source_id=$1', [order])
  } })
  await submit(db)
  const p = await payment(db)
  await correct(db, { paymentId: p.id, expected: p.paid_at })
  await db.query('INSERT INTO admin_book_access(admin_id,book_id) VALUES ($1,$2)', [actors.foreign.admin, book])
  await assert.rejects(correct(db, { actor: 'foreign', op: id(910), paymentId: p.id,
    expected: '2026-09-01T17:00:00Z', day: '2026-09-03' }), { code: '42501' })
})

test('authorized same-book invoice staff can correct another cashier receipt but cannot replay their operation', async t => {
  const db = await datesFixture(t)
  await submit(db)
  await db.query('INSERT INTO admin_book_access(admin_id,book_id) VALUES ($1,$2)', [actors.foreign.admin, book])
  const p = await payment(db)
  const result = await correct(db, { actor: 'foreign', paymentId: p.id, expected: p.paid_at })
  assert.equal(iso(result.paid_at), '2026-09-01T17:00:00.000Z')
  await assert.rejects(correct(db, { paymentId: p.id, expected: p.paid_at }), { code: '42501' })
  assert.equal((await payment(db)).cashier_id, actors.cashier.admin)
})

test('date correction works on lifecycle-managed invoices without changing revisions or adjustments', async t => {
  const db = await datesFixture(t)
  await submit(db)
  await change(db, { version: 1, payload: draft(400000) })
  const before = await allRows(db)
  const p = await payment(db)
  await correct(db, { paymentId: p.id, expected: p.paid_at })
  const after = await allRows(db)
  for (const table of ['public.transactions', 'public.debts', 'pos_security.invoice_states', 'pos_security.invoice_events',
    'pos_security.invoice_operations']) assert.deepEqual(after[table], before[table], table)
  assert.deepEqual(after['public.accounting_entries'].filter(x => x.row.source_type !== 'debt_payment'),
    before['public.accounting_entries'].filter(x => x.row.source_type !== 'debt_payment'))
})

test('refund-pending invoice permits date correction without changing the refund liability or paid balance', async t => {
  const db = await datesFixture(t)
  await submit(db, { amount: 300000 })
  await change(db, { version: 1, payload: draft(200000) })
  const p = await payment(db)
  const before = await allRows(db)
  assert.deepEqual((await db.query(`SELECT t.total::int total,t.paid::int paid,t.remaining::int remaining,s.refund_due::int refund_due
    FROM transactions t JOIN pos_security.invoice_states s ON s.order_id=t.id`)).rows,
  [{ total: 200000, paid: 300000, remaining: 0, refund_due: 100000 }])
  await correct(db, { paymentId: p.id, expected: p.paid_at })
  const after = await allRows(db)
  for (const table of ['public.transactions', 'public.debts', 'public.customers', 'pos_security.invoice_states',
    'pos_security.invoice_events', 'pos_security.invoice_operations', 'pos_security.payment_baselines'])
    assert.deepEqual(after[table], before[table], table)
  await change(db, { op: id(550), version: 2, kind: 'refund', payload: {
    amount: 50000, method: 'transfer', reason: 'Synthetic partial refund', reference: 'Synthetic refund reference',
    occurred_at: '2026-09-04T10:00:00Z',
  } })
  const partial = await payment(db)
  await correct(db, { op: id(901), paymentId: p.id, expected: partial.paid_at, day: '2026-09-03' })
  assert.deepEqual((await db.query(`SELECT t.paid::int paid,t.remaining::int remaining,s.refund_due::int refund_due
    FROM transactions t JOIN pos_security.invoice_states s ON s.order_id=t.id`)).rows,
  [{ paid: 250000, remaining: 0, refund_due: 50000 }])
})

test('refund-pending correction rejects inconsistent refund state without changing any rows', async t => {
  const db = await datesFixture(t)
  await submit(db, { amount: 300000 })
  await change(db, { version: 1, payload: draft(200000) })
  await db.exec('UPDATE pos_security.invoice_states SET refund_due=0')
  const p = await payment(db)
  const before = await allRows(db)
  await assert.rejects(correct(db, { paymentId: p.id, expected: p.paid_at }), { code: '23514' })
  assert.deepEqual(await allRows(db), before)
})

test('refund-pending correction rejects a refund account that does not reconcile to the journal', async t => {
  const db = await datesFixture(t)
  await submit(db, { amount: 300000 })
  await change(db, { version: 1, payload: draft(200000) })
  await db.exec(`INSERT INTO accounts(code,name,type,normal) VALUES ('2196','Synthetic other liability','liability','credit');
    UPDATE pos_security.invoice_account_config SET refund_account='2196'`)
  const p = await payment(db)
  const before = await allRows(db)
  await assert.rejects(correct(db, { paymentId: p.id, expected: p.paid_at }), { code: '23514' })
  assert.deepEqual(await allRows(db), before)
})

test('cancelled invoice requires review and cannot receive a new date correction', async t => {
  const db = await datesFixture(t)
  await submit(db)
  const p = await payment(db)
  await change(db, { version: 1, kind: 'cancel', payload: { reason: 'Synthetic cancellation' } })
  const before = await allRows(db)
  await assert.rejects(correct(db, { paymentId: p.id, expected: p.paid_at }), { code: '42501' })
  await assert.rejects(correct(db, { actor: 'owner', paymentId: p.id, expected: p.paid_at }), { code: '55000' })
  assert.deepEqual(await allRows(db), before)
})

test('missing managed ledger events cannot be mistaken for unledgered legacy receipts', async t => {
  const db = await datesFixture(t, { beforeDates: async db => {
    await submit(db, { legacy: true })
    await db.exec('DELETE FROM pos_security.payment_events')
  } })
  const p = await payment(db)
  const before = await allRows(db)
  await assert.rejects(correct(db, { paymentId: p.id, expected: p.paid_at }), { code: '23514' })
  assert.deepEqual(await allRows(db), before)
})

test('invalid dates, future days, pre-invoice days and invalid correction reasons leave no writes', async t => {
  const db = await datesFixture(t)
  const before = await allRows(db)
  for (const day of [null, 'infinity', '-infinity', '9999-12-31', '2026-08-19']) {
    await assert.rejects(submit(db, { day }), { code: '22023' })
    assert.deepEqual(await allRows(db), before)
  }
  await submit(db)
  const p = await payment(db)
  const paid = await allRows(db)
  for (const patch of [{ day: null }, { day: 'infinity' }, { day: '9999-12-31' }, { day: '2026-08-19' },
    { expected: null }, { expected: 'infinity' }, { reason: '' }, { reason: ' '.repeat(10) }, { reason: 'x'.repeat(1001) }]) {
    await assert.rejects(correct(db, { paymentId: p.id, expected: p.paid_at, ...patch }), { code: '22023' })
    assert.deepEqual(await allRows(db), paid)
  }
})

test('dated submission accepts 1900-01-01 but rejects earlier days even for opening debts', async t => {
  const db = await datesFixture(t, { mutate: db => db.exec(`UPDATE debts SET transaction_id=NULL,is_opening=true;
    DELETE FROM transactions;`) })
  const before = await allRows(db)
  await assert.rejects(submit(db, { day: '1899-12-31' }), { code: '22023' })
  assert.deepEqual(await allRows(db), before)
  const saved = await submit(db, { day: '1900-01-01' })
  assert.equal(saved.request.paymentDate, '1900-01-01')
  assert.equal((await db.query("SELECT (paid_at AT TIME ZONE 'Asia/Jakarta')::date::text AS day FROM debt_payments")).rows[0].day, '1900-01-01')
})

test('date correction accepts the 1900 boundary but rejects earlier opening-debt dates', async t => {
  const db = await datesFixture(t, { mutate: db => db.exec(`UPDATE debts SET transaction_id=NULL,is_opening=true;
    DELETE FROM transactions;`) })
  await submit(db)
  const p = await payment(db)
  const before = await allRows(db)
  await assert.rejects(correct(db, { paymentId: p.id, expected: p.paid_at, day: '1899-12-31' }), { code: '22023' })
  assert.deepEqual(await allRows(db), before)
  await correct(db, { paymentId: p.id, expected: p.paid_at, day: '1900-01-01' })
  assert.equal((await db.query("SELECT (paid_at AT TIME ZONE 'Asia/Jakarta')::date::text AS day FROM debt_payments")).rows[0].day, '1900-01-01')
})

test('date correction accepts a 1000-character reason and rejects 1001 without writes', async t => {
  const db = await datesFixture(t)
  await submit(db)
  const p = await payment(db)
  const before = await allRows(db)
  await assert.rejects(correct(db, { paymentId: p.id, expected: p.paid_at, reason: 'x'.repeat(1001) }), { code: '22023' })
  assert.deepEqual(await allRows(db), before)
  await correct(db, { paymentId: p.id, expected: p.paid_at, reason: 'x'.repeat(1000) })
  assert.equal((await db.query('SELECT length(reason) n FROM pos_security.payment_date_operations')).rows[0].n, 1000)
})

test('same invoice day is valid at midnight WIB and passes original receipt verification', async t => {
  const db = await datesFixture(t)
  await submit(db, { day: '2026-08-20' })
  await db.query('SELECT pos_security.invoice_verify_original_receipts($1,$2)', [order, debt])
  const p = await payment(db)
  await correct(db, { paymentId: p.id, expected: p.paid_at, day: '2026-08-21' })
  await db.query('SELECT pos_security.invoice_verify_original_receipts($1,$2)', [order, debt])
})

test('accounting dashboard and summary assign WIB midnight to the selected day under UTC sessions', async t => {
  const db = await datesFixture(t)
  await submit(db)
  for (const zone of ['UTC', 'America/Los_Angeles', 'Asia/Jakarta']) {
    const result = (await actorQuery(db, `SELECT acc_dashboard('2026-09-01','2026-09-01') dashboard,
      acc_summary('2026-09-01','2026-09-01') summary,
      acc_dashboard('2026-08-31','2026-08-31') previous`, [], { actor: 'owner', zone }))[0]
    assert.equal(result.dashboard.cicilan, 100000)
    assert.equal(result.summary.cash_in, 100000)
    assert.equal(result.previous.cicilan, 0)
  }
  const p = await payment(db)
  await correct(db, { paymentId: p.id, expected: p.paid_at, day: '2026-10-01' })
  const result = (await actorQuery(db, `SELECT acc_summary('2026-09-01','2026-09-01') old,
    acc_summary('2026-10-01','2026-10-01') current`, [], { actor: 'owner' }))[0]
  assert.equal(result.old.cash_in, 0)
  assert.equal(result.current.cash_in, 100000)
})

test('direct date/recorded-time writes and private capabilities remain denied', async t => {
  const db = await datesFixture(t)
  await submit(db)
  const before = await allRows(db)
  for (const sql of ["UPDATE debt_payments SET paid_at=now()", "UPDATE debt_payments SET recorded_at=now()",
    "UPDATE cash_movements SET moved_at=now() WHERE source_type='debt_payment'",
    "UPDATE accounting_entries SET entry_date=current_date WHERE source_type='debt_payment'",
    'SELECT * FROM pos_security.payment_date_operations', 'SELECT * FROM pos_security.payment_date_write_context']) {
    await assert.rejects(actorQuery(db, sql, [], { actor: 'owner' }))
  }
  await assert.rejects(actorQuery(db, "SELECT set_config('skupy.payment_date_write','true',true); UPDATE debt_payments SET paid_at=now()", [], { actor: 'owner' }))
  assert.deepEqual(await allRows(db), before)
})

test('inherited default grants cannot expose correction helpers, evidence or service-role writes', async t => {
  const db = await datesFixture(t, { beforeDates: db => db.exec(`ALTER DEFAULT PRIVILEGES IN SCHEMA pos_security
    GRANT ALL ON TABLES TO authenticated,anon,service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA pos_security GRANT EXECUTE ON FUNCTIONS TO authenticated,anon,service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO authenticated,anon,service_role`) })
  for (const role of ['anon', 'authenticated', 'service_role']) {
    const checks = (await db.query(`SELECT
      has_table_privilege($1,'pos_security.payment_date_operations','SELECT,INSERT,UPDATE,DELETE') audit,
      has_table_privilege($1,'pos_security.payment_date_write_context','SELECT,INSERT,UPDATE,DELETE') capability,
      has_function_privilege($1,'pos_security.record_payment_with_date(uuid,text,numeric,text,text,date,boolean)','EXECUTE') writer,
      has_function_privilege($1,'pos_security.payment_date_check(public.debt_payments)','EXECUTE') verifier,
      has_function_privilege($1,'pos_security.payment_date_write_allowed(text,text,jsonb,jsonb)','EXECUTE') guard,
      has_function_privilege($1,'pos_security.lifecycle_write_allowed(text,text,jsonb,jsonb)','EXECUTE') lifecycle`, [role])).rows[0]
    assert.deepEqual(checks, { audit: false, capability: false, writer: false, verifier: false, guard: false, lifecycle: false })
  }
  for (const role of ['anon', 'service_role']) await assert.rejects(submit(db, { role }), { code: '42501' })
})

test('opening debt can use a historical day without manufacturing an invoice or changing balances on correction', async t => {
  const db = await datesFixture(t, { mutate: db => db.exec(`UPDATE debts SET transaction_id=NULL,is_opening=true;
    DELETE FROM transactions;`) })
  await submit(db, { day: '2020-01-01' })
  const p = await payment(db)
  await correct(db, { paymentId: p.id, expected: p.paid_at, day: '2020-01-02' })
  assert.equal((await db.query('SELECT count(*)::int n FROM transactions')).rows[0].n, 0)
  assert.equal((await db.query('SELECT paid::int amount FROM debts')).rows[0].amount, 100000)
})

test('legacy distinct postings can change day without manufacturing a ledger money event', async t => {
  const db = await datesFixture(t, { paid: 100000, mutate: async db => {
    await db.query(`INSERT INTO debt_payments(id,debt_id,invoice_no,amount,payment_method,paid_at,cashier_id,customer_id,book_id)
      VALUES ($1,$2,'INV-LIFE',100000,'cash','2026-08-21T10:00:00Z',$3,$4,$5)`,
    [id(783), debt, actors.cashier.admin, null, null])
    await db.exec(`UPDATE transactions SET dp=0;
      DELETE FROM accounting_entries WHERE source_type='sale' AND account_code='1000';
      UPDATE accounting_entries SET debit=500000 WHERE source_type='sale' AND account_code='1200';
      DELETE FROM cash_movements WHERE source_type='sale';
      INSERT INTO accounting_entries(entry_date,source_type,source_id,invoice_no,account_code,debit,credit,cashier_id)
      VALUES ('2026-08-21','debt_payment','${id(783)}','INV-LIFE','1000',100000,0,'${actors.cashier.admin}'),
        ('2026-08-21','debt_payment','${id(783)}','INV-LIFE','1200',0,100000,'${actors.cashier.admin}');
      INSERT INTO cash_movements(moved_at,direction,method,amount,source_type,source_id,invoice_no,cashier_id)
      VALUES ('2026-08-21T10:00:00Z','in','cash',100000,'debt_payment','${id(783)}','INV-LIFE','${actors.cashier.admin}');`)
  } })
  const p = await payment(db)
  await correct(db, { paymentId: p.id, expected: p.paid_at })
  assert.equal((await db.query('SELECT count(*)::int n FROM pos_security.payment_events')).rows[0].n, 0)
  const preserved = await payment(db)
  assert.equal(preserved.customer_id, null)
  assert.equal(preserved.book_id, null)
  assert.equal(iso(preserved.paid_at), '2026-09-01T17:00:00.000Z')
})

test('legacy receipts without distinct postings fail with actionable reconciliation error', async t => {
  const db = await datesFixture(t, { paid: 100000, mutate: async db => {
    await db.query(`INSERT INTO debt_payments(id,debt_id,invoice_no,amount,payment_method,paid_at,cashier_id,customer_id,book_id)
      VALUES ($1,$2,'INV-LIFE',100000,'cash','2026-08-21T10:00:00Z',$3,$4,$5)`,
    [id(780), debt, actors.cashier.admin, null, null])
  } })
  const p = await payment(db)
  const before = await allRows(db)
  await assert.rejects(correct(db, { paymentId: p.id, expected: p.paid_at }), error =>
    error.code === '55000' && /reconcil/i.test(error.message) && /posting/i.test(error.message))
  assert.deepEqual(await allRows(db), before)
})

for (const badField of ['customer_id', 'book_id']) {
  test(`date-only capability cannot authorize conflicting legacy ${badField}`, async t => {
    const db = await datesFixture(t, { mutate: db => db.query(`INSERT INTO debt_payments
      (id,debt_id,invoice_no,amount,paid_at,${badField}) VALUES ($1,$2,'INV-LIFE',10,'2026-08-21T10:00:00Z',$3)`,
    [id(784), debt, id(9999)]) })
    const p = await payment(db)
    const before = await allRows(db)
    await assert.rejects(correct(db, { paymentId: p.id, expected: p.paid_at }), { code: '23514' })
    assert.deepEqual(await allRows(db), before)
  })
}

for (const target of ['receipt', 'event', 'cash', 'journal', 'audit']) {
  test(`silent ${target} date correction suppression rolls back every financial and audit row`, async t => {
    const db = await datesFixture(t)
    await submit(db)
    const p = await payment(db)
    const table = { receipt: 'public.debt_payments', event: 'pos_security.payment_events', cash: 'public.cash_movements',
      journal: 'public.accounting_entries', audit: 'pos_security.payment_date_operations' }[target]
    await db.exec(`CREATE FUNCTION public.synthetic_date_suppress() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
      CREATE TRIGGER zz_synthetic_date_suppress BEFORE ${target === 'audit' ? 'INSERT' : 'UPDATE'} ON ${table}
      FOR EACH ROW EXECUTE FUNCTION public.synthetic_date_suppress()`)
    const before = await allRows(db)
    await assert.rejects(correct(db, { paymentId: p.id, expected: p.paid_at }), { code: '23514' })
    assert.deepEqual(await allRows(db), before)
  })
}

for (const target of ['receipt', 'event', 'cash', 'journal', 'audit']) {
  test(`date correction cannot silently alter ${target} amounts or provenance`, async t => {
    const db = await datesFixture(t)
    await submit(db)
    const p = await payment(db)
    const table = { receipt: 'public.debt_payments', event: 'pos_security.payment_events', cash: 'public.cash_movements',
      journal: 'public.accounting_entries', audit: 'pos_security.payment_date_operations' }[target]
    const modification = { receipt: 'NEW.amount:=NEW.amount+1', event: "NEW.received_at:=NEW.received_at-interval '1 second'",
      cash: 'NEW.amount:=NEW.amount+1', journal: 'NEW.debit:=NEW.debit+1', audit: "NEW.reason:='Silently changed reason'" }[target]
    await db.exec(`CREATE FUNCTION public.synthetic_correction_mutate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${modification}; RETURN NEW; END $$;
      CREATE TRIGGER zz_synthetic_correction_mutate BEFORE ${target === 'audit' ? 'INSERT' : 'UPDATE'} ON ${table}
      FOR EACH ROW EXECUTE FUNCTION public.synthetic_correction_mutate()`)
    const before = await allRows(db)
    await assert.rejects(correct(db, { paymentId: p.id, expected: p.paid_at }), { code: '23514' })
    assert.deepEqual(await allRows(db), before)
  })
}

for (const target of ['receipt', 'event', 'cash', 'journal', 'recovery']) {
  test(`dated submission rolls back when ${target} persistence silently changes`, async t => {
    const db = await datesFixture(t)
    const table = { receipt: 'public.debt_payments', event: 'pos_security.payment_events', cash: 'public.cash_movements',
      journal: 'public.accounting_entries', recovery: 'pos_security.payment_client_receipts' }[target]
    const modification = { receipt: "NEW.recorded_at:=NEW.recorded_at-interval '1 day'", event: "NEW.effective_at:=NEW.effective_at-interval '1 day'",
      cash: "NEW.moved_at:=NEW.moved_at-interval '1 day'", journal: 'NEW.entry_date:=NEW.entry_date-1', recovery: "NEW.request:=NEW.request-'paymentDate'" }[target]
    await db.exec(`CREATE FUNCTION public.synthetic_date_mutate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${modification}; RETURN NEW; END $$;
      CREATE TRIGGER zz_synthetic_date_mutate BEFORE INSERT ON ${table}
      FOR EACH ROW EXECUTE FUNCTION public.synthetic_date_mutate()`)
    const before = await allRows(db)
    await assert.rejects(submit(db), { code: '23514' })
    assert.deepEqual(await allRows(db), before)
  })
}
