import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture, change, draft, id, as, snapshot, order, customer, debt, book, actors } from './invoice-lifecycle-fixture.js'

test('cashier edits invoice atomically preserving number/date/DP and reducing receivable', async t => {
  const db = await fixture(t, { baseline: process.env.INVOICE_BASELINE === '010' })
  const result = await change(db)
  assert.equal(result.total, 400000)
  assert.equal(result.paid, 200000)
  assert.equal(result.remaining, 200000)
  assert.equal(result.version, 1)
  assert.deepEqual((await db.query('SELECT invoice_no,total::int,paid::int,dp::int,remaining::int,created_at::text FROM transactions')).rows,
    [{ invoice_no: 'INV-LIFE', total: 400000, paid: 200000, dp: 200000, remaining: 200000, created_at: '2026-08-20 10:00:00+00' }])
  assert.equal(Number((await db.query('SELECT remaining FROM debts')).rows[0].remaining), 200000)
  assert.equal(Number((await db.query('SELECT total_debt FROM customers')).rows[0].total_debt), 200000)
})

test('edit below paid creates refund liability, not an overwritten payment', async t => {
  const db = await fixture(t)
  const result = await change(db, { payload: draft(150000) })
  assert.equal(result.paid, 200000)
  assert.equal(result.remaining, 0)
  assert.equal(result.refundDue, 50000)
  assert.equal(Number((await db.query("SELECT sum(credit-debit) amount FROM accounting_entries WHERE account_code='2195'")).rows[0].amount), 50000)
  assert.equal(Number((await db.query('SELECT sum(debit-credit) amount FROM accounting_entries')).rows[0].amount), 0)
})

test('cancellation removes active sale/debt and keeps real cash until explicit refund', async t => {
  const db = await fixture(t)
  const result = await change(db, { kind: 'cancel', payload: { reason: 'Customer cancelled' } })
  assert.equal(result.state, 'cancelled')
  assert.equal(result.refundDue, 200000)
  assert.equal(Number((await db.query('SELECT sum(amount) amount FROM cash_movements')).rows[0].amount), 200000)
  assert.equal(Number((await db.query('SELECT total_spent FROM customers')).rows[0].total_spent), 0)
  assert.equal(Number((await db.query('SELECT total_debt FROM customers')).rows[0].total_debt), 0)
  assert.equal((await db.query('SELECT deleted_at FROM transactions')).rows[0].deleted_at != null, true)
})

test('wrong-input void reverses recorded inflow, without labelling it a real refund', async t => {
  const db = await fixture(t)
  const result = await change(db, { kind: 'void_error', payload: { reason: 'Duplicate, no real receipt' } })
  assert.equal(result.state, 'voided')
  assert.equal(result.refundDue, 0)
  assert.equal(Number((await db.query("SELECT sum(CASE WHEN direction='in' THEN amount ELSE -amount END) amount FROM cash_movements")).rows[0].amount), 0)
  assert.equal((await db.query("SELECT count(*)::int count FROM cash_movements WHERE source_type='invoice_refund'")).rows[0].count, 0)
})

test('actor-bound replay returns once; changed payload and stale revision cannot mutate', async t => {
  const db = await fixture(t)
  const result = await change(db)
  const before = await snapshot(db)
  assert.deepEqual(await change(db), result)
  assert.deepEqual(await snapshot(db), before)
  await assert.rejects(change(db, { payload: draft(300000) }), { code: '22023' })
  await assert.rejects(change(db, { op: id(501) }), { code: '40001' })
  assert.deepEqual(await snapshot(db), before)
})

test('anonymous, foreign, inactive and supplied authority fields are rejected', async t => {
  const db = await fixture(t)
  const before = await snapshot(db)
  for (const actor of ['foreign', 'inactive']) await assert.rejects(change(db, { actor }), { code: '42501' })
  await assert.rejects(as(db, 'cashier', 'SELECT pos_apply_invoice_change($1,$2,0,$3,$4)', [id(500), order, 'edit', draft()], 'anon'), { code: '42501' })
  for (const field of ['paid', 'actor', 'customer_id', 'book_id', 'tax']) {
    await assert.rejects(change(db, { payload: { ...draft(), [field]: 0 } }), { code: '22023' })
  }
  assert.deepEqual(await snapshot(db), before)
})

test('stored row suppression rolls back invoice, debt, journal and operation', async t => {
  const db = await fixture(t)
  const before = await snapshot(db)
  await db.exec(`CREATE FUNCTION suppress_invoice_debt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
    CREATE TRIGGER z_suppress BEFORE UPDATE ON debts FOR EACH ROW EXECUTE FUNCTION suppress_invoice_debt();`)
  await assert.rejects(change(db), { code: '23514' })
  assert.deepEqual(await snapshot(db), before)
})

test('original 010 payments continue after reprice and advance invoice version', async t => {
  const db = await fixture(t)
  await change(db)
  await as(db, 'cashier', 'SELECT pos_record_payment($1,$2,$3,$4,$5)', [id(502), 'INV-LIFE', 100000, 'transfer', ''])
  const row = (await db.query('SELECT paid::int,remaining::int,version FROM transactions')).rows[0]
  assert.deepEqual(row, { paid: 300000, remaining: 100000, version: 2 })
  await assert.rejects(change(db, { op: id(503), version: 1 }), { code: '40001' })
})

test('partial and full refunds reduce liability and actual cash once, including actor-scoped status', async t => {
  const db = await fixture(t)
  await change(db, { kind: 'cancel', payload: { reason: 'Cancelled' } })
  const payload = { reason: 'Actual refund', amount: 50000, method: 'cash', occurred_at: new Date().toISOString(), reference: 'synthetic-refund' }
  const first = await change(db, { op: id(510), version: 1, kind: 'refund', payload })
  assert.equal(first.refundDue, 150000)
  assert.equal(first.paid, 150000)
  assert.deepEqual(await change(db, { op: id(510), version: 1, kind: 'refund', payload }), first)
  const status = (await as(db, 'cashier', 'SELECT pos_invoice_change_status($1) result', [id(510)]))[0].result
  assert.equal(status.state, 'complete')
  assert.deepEqual(status.result, first)
  assert.deepEqual((await as(db, 'foreign', 'SELECT pos_invoice_change_status($1) result', [id(510)]))[0].result, { state: 'unknown' })
  await assert.rejects(change(db, { op: id(511), version: 2, kind: 'refund', payload: { ...payload, amount: 150001 } }), { code: '22023' })
  const last = await change(db, { op: id(512), version: 2, kind: 'refund', payload: { ...payload, amount: 150000 } })
  assert.equal(last.refundDue, 0)
  assert.equal(last.paid, 0)
  assert.equal(Number((await db.query("SELECT sum(CASE WHEN direction='in' THEN amount ELSE -amount END) value FROM cash_movements")).rows[0].value), 0)
})

test('refund of overpayment permits later reprice and receipt without rewriting the initial DP', async t => {
  const db = await fixture(t)
  await change(db, { payload: draft(150000) })
  await change(db, { op: id(520), version: 1, kind: 'refund', payload: {
    reason: 'Excess returned', amount: 50000, method: 'cash', occurred_at: new Date().toISOString(), reference: 'synthetic-refund',
  } })
  const next = await change(db, { op: id(521), version: 2, payload: draft(300000) })
  assert.equal(next.remaining, 150000)
  await as(db, 'cashier', 'SELECT pos_record_payment($1,$2,$3,$4,$5)', [id(522), 'INV-LIFE', 150000, 'qris', ''])
  assert.deepEqual((await db.query('SELECT paid::int,dp::int,remaining::int FROM transactions')).rows, [{ paid: 300000, dp: 200000, remaining: 0 }])
})

test('unpaid removal and customerless fully paid invoice preserve valid financial semantics', async t => {
  const unpaid = await fixture(t, { paid: 0 })
  const result = await change(unpaid, { kind: 'cancel', payload: { reason: 'Cancelled' } })
  assert.equal(result.refundDue, 0)
  const anonymous = await fixture(t, { mutate: db => db.exec('DELETE FROM debts; UPDATE transactions SET customer_id=NULL,paid=500000,dp=500000,remaining=0;') })
  const reduced = await change(anonymous, { payload: draft(400000) })
  assert.equal(reduced.refundDue, 100000)
  assert.equal((await anonymous.query('SELECT count(*)::int value FROM debts')).rows[0].value, 0)
})

test('malformed quantities, amounts and unknown fields are rejected by SQL, not only the UI', async t => {
  const db = await fixture(t)
  const before = await snapshot(db)
  for (const line of [{ qty: 1.5 }, { qty: 0 }, { qty: 1.001, unit: 'meter' }, { price: -1 }, { price: 1.5 }, { price: '1000' }, { unit: 'invalid' }, { amount: 1 }]) {
    const payload = draft()
    Object.assign(payload.items[0], line)
    await assert.rejects(change(db, { payload }), { code: '22023' })
  }
  await assert.rejects(change(db, { payload: { ...draft(), discount: 500001 } }), { code: '22023' })
  assert.deepEqual(await snapshot(db), before)
})

test('customer statistics, audit and stored operation suppression must roll back everything', async t => {
  for (const table of ['customers', 'pos_security.invoice_states', 'pos_security.invoice_events', 'pos_security.invoice_operations']) {
    const db = await fixture(t)
    const before = await snapshot(db)
    await db.exec(`CREATE FUNCTION suppress_final_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
      CREATE TRIGGER z_suppress BEFORE ${table.endsWith('invoice_events') ? 'INSERT' : 'UPDATE'} ON ${table} FOR EACH ROW EXECUTE FUNCTION suppress_final_write();`)
    await assert.rejects(change(db), { code: '23514' }, table)
    assert.deepEqual(await snapshot(db), before, table)
  }
})

test('journal or cash attribution corruption cannot pass balance-only checks', async t => {
  for (const table of ['accounting_entries', 'cash_movements']) {
    const db = await fixture(t)
    const before = await snapshot(db)
    await db.exec(`CREATE FUNCTION corrupt_attribution() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.cashier_id:=NULL; RETURN NEW; END $$;
      CREATE TRIGGER z_corrupt BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION corrupt_attribution();`)
    await assert.rejects(change(db, { kind: 'void_error', payload: { reason: 'Incorrect receipt' } }), { code: '23514' }, table)
    assert.deepEqual(await snapshot(db), before, table)
  }
})

test('production status remains editable after invoice revision without allowing money or cancellation bypass', async t => {
  const db = await fixture(t)
  await change(db)
  await as(db, 'cashier', "UPDATE transactions SET order_status='diproses',status_history='[]' WHERE id=$1", [order])
  assert.equal((await db.query('SELECT version FROM transactions')).rows[0].version, 2)
  for (const assignment of ["paid=100000", "order_status='dibatalkan'", "deleted_at=now()", "total=1", "cashier_id=NULL"]) {
    await assert.rejects(as(db, 'cashier', `UPDATE transactions SET ${assignment} WHERE id=$1`, [order]))
  }
  await change(db, { op: id(560), version: 2, kind: 'cancel', payload: { reason: 'Cancelled' } })
  await assert.rejects(db.query("UPDATE transactions SET order_status='diproses' WHERE id=$1", [order]), { code: '55000' })
})

test('nullable invoice creator never grants a cashier invisible invoice access', async t => {
  const db = await fixture(t, { mutate: db => db.exec('UPDATE transactions SET cashier_id=NULL') })
  assert.equal((await as(db, 'cashier', 'SELECT id FROM transactions')).length, 0)
  await assert.rejects(change(db), { code: '42501' })
})

test('historical installments cannot be replaced by an aggregate initial receipt', async t => {
  const db = await fixture(t, { paid: 300000, mutate: db => db.exec(`
    UPDATE transactions SET dp=200000;
    ALTER TABLE debt_payments DISABLE TRIGGER USER;
    INSERT INTO debt_payments(id,debt_id,invoice_no,amount,payment_method,paid_at,customer_id,book_id,cashier_id)
      VALUES('${id(570)}','${debt}','INV-LIFE',100000,'transfer','2026-09-01T10:00:00Z','${customer}','${book}','${actors.cashier.admin}');
    ALTER TABLE debt_payments ENABLE TRIGGER USER;`) })
  const before = await snapshot(db)
  await assert.rejects(change(db), { code: '23514' })
  assert.deepEqual(await snapshot(db), before)
})

test('suppressed payment baseline rolls back successful-looking invoice revision', async t => {
  const db = await fixture(t)
  const before = await snapshot(db)
  await db.exec(`CREATE FUNCTION suppress_baseline() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
    CREATE TRIGGER z_suppress BEFORE INSERT ON pos_security.payment_baselines FOR EACH ROW EXECUTE FUNCTION suppress_baseline();`)
  await assert.rejects(change(db), { code: '23514' })
  assert.deepEqual(await snapshot(db), before)
})

test('balanced but inflated debit and credit cannot pass exact journal verification', async t => {
  const db = await fixture(t)
  const before = await snapshot(db)
  await db.exec(`CREATE FUNCTION corrupt_gross() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.debit:=NEW.debit+12345; NEW.credit:=NEW.credit+12345; RETURN NEW; END $$;
    CREATE TRIGGER z_corrupt BEFORE INSERT ON accounting_entries FOR EACH ROW EXECUTE FUNCTION corrupt_gross();`)
  await assert.rejects(change(db), { code: '23514' })
  assert.deepEqual(await snapshot(db), before)
})

test('properly posted installments are adopted and remain payable after editing', async t => {
  const db = await fixture(t, { paid: 0 })
  await as(db, 'cashier', 'SELECT pos_record_payment($1,$2,$3,$4,$5)', [id(580), 'INV-LIFE', 100000, 'transfer', ''])
  const before = await db.query("SELECT to_jsonb(p) row FROM debt_payments p")
  const result = await change(db, { version: 1 })
  assert.equal(result.paid, 100000)
  assert.equal(result.remaining, 300000)
  assert.deepEqual((await db.query("SELECT to_jsonb(p) row FROM debt_payments p")).rows, before.rows)
  await as(db, 'cashier', 'SELECT pos_record_payment($1,$2,$3,$4,$5)', [id(581), 'INV-LIFE', 50000, 'cash', ''])
  assert.equal(Number((await db.query('SELECT paid FROM transactions')).rows[0].paid), 150000)
})

test('manager can revise an unassigned invoice while ordinary cashier remains denied', async t => {
  const db = await fixture(t, { mutate: db => db.exec(`UPDATE transactions SET cashier_id=NULL;
    UPDATE accounting_entries SET cashier_id=NULL; UPDATE cash_movements SET cashier_id=NULL;`) })
  const result = await change(db, { actor: 'owner' })
  assert.equal(result.total, 400000)
  assert.equal(result.version, 1)
})

test('legacy cancellation markers cannot be reactivated through edit', async t => {
  for (const status of ['cancelled', 'canceled', 'dibatalkan', ' CANCELLED ']) {
    const db = await fixture(t, { mutate: db => db.query('UPDATE transactions SET status=$1', [status]) })
    const before = await snapshot(db)
    await assert.rejects(change(db), { code: '22023' })
    assert.deepEqual(await snapshot(db), before)
  }
})
