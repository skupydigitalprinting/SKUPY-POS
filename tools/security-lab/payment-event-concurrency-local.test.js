import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture, id, auth, pic, ownerA, order, cashier, customer, admin, book } from './payment-event-postgres-fixture.js'

const options = { skip: process.env.SKUPY_RUN_LOCAL_PAYMENT_TESTS !== '1', timeout: 90000 }

test('receipt ledger PostgreSQL: simultaneous cash and bank receipts accumulate once', options, async () => {
  await fixture(async ({ competing, balances, sql }) => {
    const results = await competing([
      { op: id(100), amount: 30, method: 'cash' },
      { op: id(101), amount: 40, method: 'transfer', actor: pic },
    ])
    for (const result of results) assert.equal(result.ok, true, result.stderr)
    assert.deepEqual(balances(), { paid: 70, remaining: 30, debtPaid: 70, debtRemaining: 30,
      customerDebt: 30, payments: 2, operations: 2, cash: 70 })
    assert.deepEqual(JSON.parse(sql(`SELECT json_agg(x ORDER BY method) FROM
      (SELECT method,sum(amount)::int amount FROM cash_movements GROUP BY method) x`)),
    [{ method: 'cash', amount: 30 }, { method: 'transfer', amount: 40 }])
    assert.equal(sql(`SELECT count(*) FROM accounting_entries e JOIN debt_payments p ON p.id=e.source_id
      WHERE e.entry_date=(p.paid_at AT TIME ZONE 'Asia/Jakarta')::date`), '4')
    assert.equal(sql("SELECT sum(debit-credit) FROM accounting_entries WHERE account_code='1200'"), '30')
  })
})

test('receipt ledger PostgreSQL: six concurrent retries yield one QRIS receipt', options, async () => {
  await fixture(async ({ competing, balances, sql }) => {
    const results = await competing(Array.from({ length: 6 }, () => ({ op: id(100), amount: 30, method: 'qris' })))
    for (const result of results) {
      assert.equal(result.ok, true, result.stderr)
      assert.deepEqual(JSON.parse(result.stdout), { invoice_no: 'SYNTHETIC-1', amount: 30, paid: 30, remaining: 70, status: 'aktif' })
    }
    assert.deepEqual(balances(), { paid: 30, remaining: 70, debtPaid: 30, debtRemaining: 70,
      customerDebt: 70, payments: 1, operations: 1, cash: 30 })
    assert.equal(sql('SELECT count(*) FROM pos_security.payment_events'), '1')
    assert.equal(sql("SELECT sum(debit) FROM accounting_entries WHERE account_code='1100'"), '30')
  })
})

test('receipt ledger PostgreSQL: simultaneous final payments cannot overpay', options, async () => {
  await fixture(async ({ competing, balances }) => {
    const results = await competing([
      { op: id(100), amount: 100, method: 'cash' },
      { op: id(101), amount: 100, method: 'transfer' },
    ])
    assert.equal(results.filter(result => result.ok).length, 1)
    assert.match(results.find(result => !result.ok).stderr, /22023/)
    assert.deepEqual(balances(), { paid: 100, remaining: 0, debtPaid: 100, debtRemaining: 0,
      customerDebt: 0, payments: 1, operations: 1, cash: 100 })
  })
})

test('receipt ledger PostgreSQL: failed journal write rolls back all payment effects and can retry', options, async () => {
  await fixture(async ({ pay, balances, sql }) => {
    const before = balances()
    sql(`CREATE FUNCTION public.synthetic_reject_posting() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN RAISE EXCEPTION 'synthetic journal failure'; END $$;
      CREATE TRIGGER synthetic_reject_posting BEFORE INSERT ON public.accounting_entries
      FOR EACH ROW EXECUTE FUNCTION public.synthetic_reject_posting();`)
    const rejected = await pay(id(100), 30, 'failed', 'transfer')
    assert.equal(rejected.ok, false)
    assert.deepEqual(balances(), before)
    assert.equal(sql('SELECT count(*) FROM pos_security.payment_events'), '0')
    assert.equal(sql('SELECT count(*) FROM pos_security.payment_baselines'), '0')
    assert.equal(sql('SELECT count(*) FROM pos_security.payment_write_context'), '0')
    sql('DROP TRIGGER synthetic_reject_posting ON public.accounting_entries;')
    const retried = await pay(id(100), 30, 'retry', 'transfer')
    assert.equal(retried.ok, true, retried.stderr)
    assert.deepEqual(balances(), { paid: 30, remaining: 70, debtPaid: 30, debtRemaining: 70,
      customerDebt: 70, payments: 1, operations: 1, cash: 30 })
  })
})

test('receipt ledger PostgreSQL: operation receipt cannot be shared between authorized cashiers', options, async () => {
  await fixture(async ({ competing, balances }) => {
    const results = await competing([
      { op: id(100), amount: 30, method: 'transfer' },
      { op: id(100), amount: 30, method: 'transfer', actor: pic },
    ])
    assert.equal(results.filter(result => result.ok).length, 1)
    const denied = results.find(result => !result.ok)
    assert.match(denied.stderr, /42501/)
    assert.equal(denied.stdout, '')
    assert.deepEqual(balances(), { paid: 30, remaining: 70, debtPaid: 30, debtRemaining: 70,
      customerDebt: 70, payments: 1, operations: 1, cash: 30 })
  })
})

test('receipt ledger PostgreSQL: deactivation committed during authorization blocks waiting payment', options, async () => {
  await fixture(async ({ gate, waitBlocked, pay, balances }) => {
    const before = balances()
    const [result] = await gate(`UPDATE pos_security.user_access SET active=false WHERE auth_user_id='${auth}';`, async () => {
      const payment = pay(id(100), 30, 'waiting_payment', 'qris')
      await waitBlocked(['waiting_payment'], ['gate'])
      return [payment]
    })
    assert.equal(result.ok, false)
    assert.match(result.stderr, /42501/)
    assert.equal(result.stdout, '')
    assert.deepEqual(balances(), before)
  })
})

test('receipt ledger PostgreSQL: attested initial cash DP survives concurrent bank installments unchanged', options, async () => {
  await fixture(async ({ pay, competing, balances, sql, asActor }) => {
    const initial = balances()
    const beforeJournal = sql("SELECT json_agg(e ORDER BY id) FROM accounting_entries e WHERE source_type='sale'")
    const denied = await pay(id(100), 30, 'before_attestation', 'transfer')
    assert.equal(denied.ok, false)
    assert.match(denied.stderr, /22023/)
    assert.deepEqual(balances(), initial)
    const attested = await asActor(ownerA, 'attest_initial', `SELECT public.pos_reconcile_initial_receipt('${order}',
      (SELECT jsonb_build_object('invoice_no',t.invoice_no,'customer_id',t.customer_id,'book_id',t.book_id,
        'total',t.total,'paid',t.paid,'dp',t.dp,'remaining',t.remaining,'payment_method',t.payment_method,'created_at',t.created_at)
        FROM public.transactions t WHERE t.id='${order}'), 'synthetic-local-dp-receipt');`)
    assert.equal(attested.ok, true, attested.stderr)
    const results = await competing([
      { op: id(100), amount: 30, method: 'transfer' },
      { op: id(101), amount: 40, method: 'qris', actor: pic },
    ])
    for (const result of results) assert.equal(result.ok, true, result.stderr)
    assert.deepEqual(balances(), { paid: 90, remaining: 10, debtPaid: 90, debtRemaining: 10,
      customerDebt: 10, payments: 2, operations: 2, cash: 90 })
    assert.equal(sql("SELECT json_agg(e ORDER BY id) FROM accounting_entries e WHERE source_type='sale'"), beforeJournal)
    assert.equal(sql('SELECT dp FROM transactions'), '20')
    assert.equal(sql("SELECT sum(debit-credit) FROM accounting_entries WHERE account_code='1000'"), '20')
    assert.equal(sql("SELECT sum(debit-credit) FROM accounting_entries WHERE account_code='1100'"), '70')
    assert.equal(sql(`SELECT count(*) FROM accounting_entries e JOIN debt_payments p ON p.id=e.source_id
      WHERE e.entry_date=(p.paid_at AT TIME ZONE 'Asia/Jakarta')::date`), '4')
  }, { initialPaid: 20 })
})

test('receipt ledger PostgreSQL: unattributed journal line aborts the whole receipt', options, async () => {
  await fixture(async ({ sql, pay, balances }) => {
    const before = balances()
    sql(`CREATE FUNCTION public.synthetic_clear_attribution() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN IF NEW.source_type='debt_payment' AND NEW.account_code='1000' THEN NEW.cashier_id=NULL; END IF;
      RETURN NEW; END $$;
      CREATE TRIGGER zz_synthetic_clear_attribution BEFORE INSERT ON public.accounting_entries
      FOR EACH ROW EXECUTE FUNCTION public.synthetic_clear_attribution();`)
    const result = await pay(id(100), 30, 'null_attribution')
    assert.equal(result.ok, false)
    assert.match(result.stderr, /23514/)
    assert.deepEqual(balances(), before)
    assert.equal(sql('SELECT count(*) FROM pos_security.payment_events'), '0')
  })
})

test('receipt ledger PostgreSQL: new overnight sale uses WIB and accepts its first payment', options, async () => {
  await fixture(async ({ sql, asActor }) => {
    sql(`SET TIME ZONE 'UTC'; INSERT INTO public.transactions
      (id,invoice_no,customer_id,cashier_id,book_id,total,paid,dp,remaining,status,payment_method,created_at)
      VALUES('${id(150)}','SYNTHETIC-NIGHT','${customer}','${admin}','${book}',100,0,0,100,'pending','cash','2026-09-11T18:00:00Z');`)
    assert.equal(sql(`SELECT count(*) FROM accounting_entries WHERE source_id='${id(150)}' AND entry_date='2026-09-12'`), '2')
    const result = await asActor(cashier, 'overnight_payment', `SELECT public.pos_record_payment('${id(151)}','SYNTHETIC-NIGHT',30,'transfer','');`)
    assert.equal(result.ok, true, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout), { invoice_no: 'SYNTHETIC-NIGHT', amount: 30, paid: 30, remaining: 70, status: 'aktif' })
  })
})
