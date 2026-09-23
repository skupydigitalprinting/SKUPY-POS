import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
const read = p => readFile(new URL(p, import.meta.url), 'utf8')
// The explicit baseline switch demonstrates the regression without changing 009.
const candidate = process.env.PAYMENT_LEDGER_BASELINE === '009' ? '' : await read('../../supabase/security-stage2/010_payment_event_ledger.sql')
const id = n => `a1000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const users = Object.fromEntries(['owner','cashier','pic','foreign','inactive','unmapped'].map((name,i) =>
  [name,{ admin:id(i+1),auth:id(i+11),session:id(i+21) }]))
const book=id(100), otherBook=id(101), customer=id(200), order=id(300), debt=id(400), operation=id(500)
const saleDate='2026-08-20T10:00:00.000Z'
async function setup(t, { paid=0, mutate, opening=false } = {}) {
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(`CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS; CREATE ROLE unrelated NOLOGIN;
    CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE TABLE auth.sessions(id uuid PRIMARY KEY,user_id uuid REFERENCES auth.users,created_at timestamptz);
    CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS
      $$ SELECT nullif(current_setting('request.jwt.claims',true),'')::jsonb $$;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT (auth.jwt()->>'sub')::uuid $$;`)
  await db.exec(await read('business-schema.sql'))
  for (const file of ['001_identity_bridge.sql','002_username_login.sql','003_password_recovery.sql',
    '004_password_reset_status.sql','005_staff_directory.sql']) await db.exec(await read(`../../supabase/security-stage2/${file}`))
  for (const [name,u] of Object.entries(users)) {
    await db.query('INSERT INTO auth.users VALUES ($1)',[u.auth])
    await db.query('INSERT INTO auth.sessions VALUES ($1,$2,clock_timestamp())',[u.session,u.auth])
    await db.query("INSERT INTO admins(id,username,name,password,role) VALUES ($1,$2,$2,'synthetic','owner')",[u.admin,name])
    if (name!=='unmapped') await db.query(`INSERT INTO pos_security.user_access(auth_user_id,admin_id,role,active,login_username)
      VALUES ($1,$2,$3,$4,$5)`,[u.auth,u.admin,name==='owner'?'owner':'staff',name!=='inactive',name])
  }
  await db.exec(`INSERT INTO accounts(code,name,type,normal)
    SELECT code,code,'asset','debit' FROM unnest(ARRAY['1000','1100','1200','4000']) code;
    INSERT INTO books(id,name) VALUES ('${book}','Synthetic A'),('${otherBook}','Synthetic B');
    INSERT INTO admin_book_access(admin_id,book_id) VALUES ('${users.cashier.admin}','${book}'),
      ('${users.pic.admin}','${book}'),('${users.foreign.admin}','${otherBook}');
    INSERT INTO customers(id,name,owner_user_id,book_id) VALUES ('${customer}','Synthetic','${users.pic.admin}','${book}');`)
  if (!opening) await db.query(`INSERT INTO transactions(id,invoice_no,customer_id,cashier_id,book_id,total,paid,dp,remaining,payment_method,created_at)
    VALUES ($1,'INV-A',$2,$3,$4,100,$5,$5,100-$5::numeric,'cash',$6)`,[order,customer,users.cashier.admin,book,paid,saleDate])
  await db.query(`INSERT INTO debts(id,invoice_no,customer_id,transaction_id,cashier_id,book_id,total_debt,paid,remaining,is_opening)
    VALUES ($1,'INV-A',$2,$3,$4,$5,100,$6,100-$6::numeric,$7)`,[debt,customer,opening?null:order,users.cashier.admin,book,paid,opening])
  if (mutate) await mutate(db)
  await db.exec(await read('../../supabase/security-stage2/006_business_access.sql'))
  await db.query('SELECT recalculate_customer_summary($1)',[customer])
  await db.exec(`ALTER DEFAULT PRIVILEGES GRANT ALL ON TABLES TO PUBLIC,anon,authenticated,service_role;
    ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO PUBLIC,anon,authenticated,service_role;`)
  await db.exec(await read('../../supabase/security-stage2/009_business_operations.sql'))
  if (candidate) try { await db.exec(candidate) } catch (e) { delete e.query; throw e }
  return db
}
async function as(db,name,sql,params=[],role='authenticated',extra={}) {
  const u=users[name]
  return db.transaction(async tx => {
    await tx.exec(`SET LOCAL ROLE ${role}; SET LOCAL TIME ZONE 'Asia/Jakarta'`)
    await tx.query("SELECT set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:u.auth,session_id:u.session,...extra})])
    return (await tx.query(sql,params)).rows
  })
}
const pay = async (db,{name='cashier',op=operation,amount=30,method='cash',invoice='INV-A',notes=''}={}) =>
  (await as(db,name,'SELECT pos_record_payment($1,$2,$3,$4,$5) result',[op,invoice,amount,method,notes]))[0].result
const scalar = async (db,sql) => (await db.query(sql)).rows[0].value
const snapshot = async db => {
  const result={}
  for (const table of ['transactions','debts','debt_payments','customers','accounting_entries','cash_movements',
    'pos_security.payment_operations',...(candidate?['pos_security.payment_baselines','pos_security.payment_events','pos_security.payment_write_context']:[])]) {
    result[table]=(await db.query(`SELECT to_jsonb(x) value FROM ${table} x ORDER BY to_jsonb(x)::text`)).rows
  }
  return result
}
const expectedInitial = (paid=20) => ({invoice_no:'INV-A',customer_id:customer,book_id:book,total:100,paid,dp:paid,
  remaining:100-paid,payment_method:'cash',created_at:'2026-08-20T10:00:00+00:00'})
const reconcile = async (db,{name='owner',expected=expectedInitial(),evidence='synthetic-initial-receipt-001'}={}) =>
  (await as(db,name,'SELECT pos_reconcile_initial_receipt($1,$2,$3) result',[order,expected,evidence]))[0].result

test('actual receipt date: cash installment does not migrate to original sale date',async t => {
  const db=await setup(t)
  await pay(db)
  const rows=(await db.query(`SELECT e.entry_date::text,e.account_code,e.debit::int,e.credit::int,
    e.entry_date=(p.paid_at AT TIME ZONE 'Asia/Jakarta')::date same_date
    FROM accounting_entries e JOIN debt_payments p ON p.id=e.source_id ORDER BY account_code`)).rows
  assert.equal(rows.length,2)
  assert.deepEqual(rows.map(({entry_date,...r})=>r),[
    {account_code:'1000',debit:30,credit:0,same_date:true},{account_code:'1200',debit:0,credit:30,same_date:true}])
  assert.notEqual(rows[0].entry_date,'2026-08-20')
  assert.equal(Number(await scalar(db,"SELECT sum(debit) value FROM accounting_entries WHERE source_type='sale' AND account_code='1000'")),0)
  assert.equal(Number(await scalar(db,"SELECT sum(debit-credit) value FROM accounting_entries WHERE account_code='1200'")),70)
})

test('cash, transfer and QRIS append exact tenders with no cumulative repost double count',async t => {
  const db=await setup(t)
  for (const [i,method,amount] of [[0,'cash',20],[1,'transfer',30],[2,'qris',50]]) await pay(db,{op:id(500+i),method,amount})
  assert.deepEqual((await db.query('SELECT method,sum(amount)::int amount FROM cash_movements GROUP BY method ORDER BY method')).rows,
    [{method:'cash',amount:20},{method:'qris',amount:50},{method:'transfer',amount:30}])
  assert.deepEqual((await db.query('SELECT account_code,sum(debit-credit)::int amount FROM accounting_entries GROUP BY account_code ORDER BY account_code')).rows,
    [{account_code:'1000',amount:20},{account_code:'1100',amount:80},{account_code:'1200',amount:0},{account_code:'4000',amount:-100}])
  assert.deepEqual((await db.query('SELECT paid::int,dp::int,remaining::int FROM transactions')).rows,[{paid:100,dp:0,remaining:0}])
  assert.equal(Number(await scalar(db,'SELECT total_debt value FROM customers')),0)
})

test('historical initial DP is blocked until explicit owner snapshot reconciliation, then remains untouched',async t => {
  const db=await setup(t,{paid:20})
  const before=await snapshot(db)
  await assert.rejects(pay(db),{code:'22023'})
  assert.deepEqual(await snapshot(db),before)
  const saleBefore=(await db.query("SELECT * FROM accounting_entries WHERE source_type='sale' ORDER BY id")).rows
  await reconcile(db)
  await pay(db,{method:'transfer'})
  await pay(db,{method:'qris',amount:10,op:id(501)})
  assert.equal(Number(await scalar(db,'SELECT dp value FROM transactions')),20)
  assert.deepEqual((await db.query("SELECT * FROM accounting_entries WHERE source_type='sale' ORDER BY id")).rows,saleBefore)
  assert.equal(Number(await scalar(db,"SELECT sum(debit-credit) value FROM accounting_entries WHERE account_code='1000'")),20)
  assert.equal(Number(await scalar(db,"SELECT sum(debit-credit) value FROM accounting_entries WHERE account_code='1100'")),40)
})

test('reconciliation rejects stale snapshots, nonowners, missing evidence and cannot overwrite attestation',async t => {
  const db=await setup(t,{paid:20})
  for (const name of ['cashier','pic','foreign','inactive','unmapped']) await assert.rejects(reconcile(db,{name}),{code:'42501'})
  for (const expected of [null,{},expectedInitial(30),{...expectedInitial(),payment_method:'transfer'}])
    await assert.rejects(reconcile(db,{expected}),{code:'22023'})
  for (const evidence of ['',null,' '.repeat(3)]) await assert.rejects(reconcile(db,{evidence}),{code:'22023'})
  await reconcile(db)
  const before=await snapshot(db)
  await assert.rejects(reconcile(db),{code:'22023'})
  assert.deepEqual(await snapshot(db),before)
})

test('ambiguous historical installments, overwritten DP and damaged sale journals cannot be adopted',async t => {
  for (const mutate of [
    db=>db.exec('UPDATE transactions SET dp=10'),
    db=>db.exec("UPDATE accounting_entries SET entry_date='2026-08-21'"),
    db=>db.exec("UPDATE cash_movements SET method='transfer'"),
    db=>db.exec('DELETE FROM accounting_entries'),
    db=>db.exec(`INSERT INTO debt_payments(debt_id,invoice_no,amount,payment_method,deleted_at) VALUES ('${debt}','INV-A',20,'cash',now())`),
  ]) {
    const db=await setup(t,{paid:20,mutate})
    const before=await snapshot(db)
    await assert.rejects(reconcile(db),{code:'22023'})
    await assert.rejects(pay(db),{code:'22023'})
    assert.deepEqual(await snapshot(db),before)
  }
})

test('opening receipts append once without fabricating opening sales or historical paid balances',async t => {
  const db=await setup(t,{opening:true})
  await pay(db,{name:'pic',method:'transfer'})
  await pay(db,{name:'pic',method:'qris',op:id(501),amount:20})
  assert.equal(Number(await scalar(db,"SELECT count(*) value FROM accounting_entries WHERE source_type='sale'")),0)
  assert.equal(Number(await scalar(db,'SELECT sum(amount) value FROM cash_movements')),50)
  assert.equal(Number(await scalar(db,'SELECT remaining value FROM debts')),50)
  assert.equal(Number(await scalar(db,'SELECT count(*) value FROM pos_security.payment_events')),2)
  for (const opts of [{opening:true,paid:20},{opening:true,mutate:db=>db.exec('UPDATE debts SET is_opening=false')}]) {
    const damaged=await setup(t,opts)
    await assert.rejects(pay(damaged,{name:'pic'}),{code:'22023'})
  }
})

test('exact normalized actor replay returns original result without events; changed actor or request is denied',async t => {
  const db=await setup(t)
  const receipt=await pay(db,{method:' TRANSFER ',invoice:' INV-A ',notes:null})
  await pay(db,{op:id(501),amount:10})
  const before=await snapshot(db)
  assert.deepEqual(await pay(db,{method:'transfer',amount:'30.00'}),receipt)
  await assert.rejects(pay(db,{name:'pic',method:'transfer'}),{code:'42501'})
  await assert.rejects(pay(db,{method:'qris'}),{code:'22023'})
  assert.deepEqual(await snapshot(db),before)
  await db.query('UPDATE pos_security.user_access SET active=false WHERE auth_user_id=$1',[users.cashier.auth])
  await assert.rejects(pay(db,{method:'transfer'}),{code:'42501'})
})

test('every insert failure or silent trigger suppression rolls back all money, summaries and private rows',async t => {
  for (const table of ['debt_payments','accounting_entries','cash_movements','pos_security.payment_events']) {
    for (const body of ["RAISE EXCEPTION 'synthetic posting failure';",'RETURN NULL;']) {
      const db=await setup(t)
      const before=await snapshot(db)
      await db.exec(`CREATE FUNCTION public.synthetic_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${body} END $$;
        CREATE TRIGGER zz_synthetic_fail BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION public.synthetic_fail()`)
      await assert.rejects(pay(db))
      assert.deepEqual(await snapshot(db),before,`${table}: ${body}`)
    }
  }
})

test('missing order debt is created atomically and rolled back on journal failure',async t => {
  const db=await setup(t,{mutate:db=>db.exec('DELETE FROM debts')})
  await db.exec("ALTER TABLE accounting_entries ADD CONSTRAINT synthetic_fail CHECK (source_type<>'debt_payment')")
  const before=await snapshot(db)
  await assert.rejects(pay(db))
  assert.deepEqual(await snapshot(db),before)
  await db.exec('ALTER TABLE accounting_entries DROP CONSTRAINT synthetic_fail')
  await pay(db)
  assert.equal(Number(await scalar(db,'SELECT count(*) value FROM debts')),1)
})

test('legacy writers, deletions, corrections and resync fail closed after enrollment',async t => {
  const db=await setup(t)
  await pay(db)
  const before=await snapshot(db)
  for (const sql of [
    'UPDATE transactions SET total=total', 'UPDATE transactions SET paid=40,remaining=60',
    'UPDATE transactions SET dp=30',"UPDATE transactions SET payment_method='qris'",
    "UPDATE transactions SET order_status='dibatalkan'",'UPDATE transactions SET deleted_at=now()',
    'DELETE FROM transactions','UPDATE debts SET paid=40,remaining=60','DELETE FROM debts',
    'UPDATE debt_payments SET amount=1','UPDATE debt_payments SET deleted_at=now()','DELETE FROM debt_payments',
    'DELETE FROM accounting_entries','UPDATE accounting_entries SET debit=debit','DELETE FROM cash_movements',
    'UPDATE cash_movements SET amount=amount','TRUNCATE accounting_entries','TRUNCATE cash_movements',
    'SELECT public.acc_resync()',
    `INSERT INTO debt_payments(debt_id,amount) VALUES ('${debt}',1)`,
    `INSERT INTO accounting_entries(source_type,source_id,invoice_no,account_code,debit) VALUES ('other','${order}','INV-A','1000',1)`,
  ]) {
    await assert.rejects(as(db,'owner',sql),undefined,sql)
    assert.deepEqual(await snapshot(db),before,sql)
  }
  // Definer/maintenance reposts are also contained; this is not only client RLS.
  for (const sql of ['UPDATE transactions SET total=total','DELETE FROM accounting_entries','DELETE FROM cash_movements',
    'TRUNCATE accounting_entries','TRUNCATE cash_movements','TRUNCATE transactions CASCADE']) {
    await assert.rejects(db.exec(sql),undefined,sql)
    assert.deepEqual(await snapshot(db),before)
  }
})

test('paid cancellation and direct legacy receipts are blocked even before baseline adoption',async t => {
  const db=await setup(t,{paid:20})
  const before=await snapshot(db)
  for (const sql of ["UPDATE transactions SET order_status='dibatalkan'","UPDATE transactions SET status='cancelled'",
    'UPDATE transactions SET deleted_at=now()','DELETE FROM transactions','DELETE FROM debts',
    'UPDATE transactions SET paid=30,dp=30,remaining=70','UPDATE debts SET paid=30,remaining=70',
    `INSERT INTO debt_payments(debt_id,amount) VALUES ('${debt}',10)`]) await assert.rejects(as(db,'owner',sql))
  assert.deepEqual(await snapshot(db),before)
})

test('inherited default grants cannot expose private tables, internal helpers or anonymous privileged RPCs',async t => {
  const db=await setup(t)
  for (const role of ['anon','service_role','unrelated']) {
    await assert.rejects(as(db,'owner','SELECT pos_record_payment($1,$2,$3,$4,$5)',[operation,'INV-A',10,'cash',''],role),{code:'42501'})
    await assert.rejects(as(db,'owner','SELECT pos_reconcile_initial_receipt($1,$2,$3)',[order,expectedInitial(),'synthetic'],role),{code:'42501'})
  }
  await db.exec('GRANT USAGE ON SCHEMA pos_security TO anon,service_role,unrelated')
  for (const role of ['anon','authenticated','service_role','unrelated']) {
    for (const table of ['payment_baselines','payment_events','payment_write_context']) {
      for (const sql of [`SELECT * FROM pos_security.${table}`,`DELETE FROM pos_security.${table}`,
        `INSERT INTO pos_security.${table} DEFAULT VALUES`,`TRUNCATE pos_security.${table}`])
        await assert.rejects(as(db,'owner',sql,[],role),{code:'42501'})
    }
    const helpers=(await db.query(`SELECT p.oid::regprocedure::text signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='pos_security' AND p.proname LIKE 'payment_%'`)).rows
    assert.ok(helpers.length>0)
    for (const {signature} of helpers) assert.equal((await db.query('SELECT has_function_privilege($1,$2,\'EXECUTE\') value',[role,signature])).rows[0].value,false)
  }
})

test('invalid actors, sessions, requests and overpayment leave no partial state',async t => {
  const db=await setup(t)
  const before=await snapshot(db)
  for (const name of ['foreign','inactive','unmapped']) await assert.rejects(pay(db,{name}),{code:'42501'})
  for (const amount of [0,-1,0.5,'NaN','Infinity',null,101]) await assert.rejects(pay(db,{amount}),{code:'22023'})
  for (const method of [null,'hutang','card','']) await assert.rejects(pay(db,{method}),{code:'22023'})
  for (const session_id of [null,'bad',users.pic.session]) await assert.rejects(as(db,'cashier',
    'SELECT pos_record_payment($1,$2,$3,$4,$5)',[operation,'INV-A',10,'cash',''],'authenticated',{session_id}),{code:'42501'})
  assert.deepEqual(await snapshot(db),before)
})

test('PIC may pay hidden linked order while cross-book and malformed bindings remain denied',async t => {
  const db=await setup(t)
  assert.deepEqual(await as(db,'pic','SELECT id FROM transactions'),[])
  await pay(db,{name:'pic',method:'qris'})
  assert.deepEqual(await as(db,'pic','SELECT id FROM transactions'),[])
  for (const mutate of [db=>db.exec('UPDATE debts SET total_debt=101'),db=>db.exec('UPDATE debts SET transaction_id=NULL'),
    db=>db.exec(`INSERT INTO debts(invoice_no,customer_id,book_id,total_debt,paid,remaining) VALUES ('INV-A','${customer}','${book}',100,0,100)`),
    db=>db.exec('UPDATE transactions SET deleted_at=now()')]) {
    const damaged=await setup(t,{mutate})
    await assert.rejects(pay(damaged),e=>['22023','42501'].includes(e.code))
  }
})

test('queued distinct payments cannot overspend and retries append once (single-connection evidence only)',async t => {
  const db=await setup(t)
  const r=await Promise.all([pay(db),pay(db)])
  assert.deepEqual(r[0],r[1])
  const outcomes=await Promise.allSettled([pay(db,{op:id(501),amount:70,method:'qris'}),pay(db,{op:id(502),amount:70,method:'transfer'})])
  assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1)
  assert.equal(Number(await scalar(db,'SELECT count(*) value FROM debt_payments')),2)
  assert.equal(Number(await scalar(db,'SELECT sum(amount) value FROM cash_movements')),100)
})

test('silent trigger alterations to receipt, event or balance cannot commit a mismatched payment',async t => {
  for (const [table,action,body] of [
    ['debt_payments','INSERT','NEW.amount := 1;'],
    ['pos_security.payment_events','INSERT',"NEW.method := 'qris';"],
    ['transactions','UPDATE','NEW.paid := 1; NEW.remaining := 99;'],
    ['debts','UPDATE','NEW.paid := 1; NEW.remaining := 99;'],
  ]) {
    const db=await setup(t)
    const before=await snapshot(db)
    await db.exec(`CREATE FUNCTION public.synthetic_alter() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${body} RETURN NEW; END $$;
      CREATE TRIGGER zz_synthetic_alter BEFORE ${action} ON ${table} FOR EACH ROW EXECUTE FUNCTION public.synthetic_alter()`)
    await assert.rejects(pay(db),{code:'23514'},table)
    assert.deepEqual(await snapshot(db),before)
  }
})

test('a caller-settable GUC cannot authorize legacy payment writes',async t => {
  const db=await setup(t)
  await pay(db)
  const before=await snapshot(db)
  await assert.rejects(db.transaction(async tx=>{
    await tx.exec('SET LOCAL ROLE authenticated')
    await tx.query("SELECT set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:users.owner.auth,session_id:users.owner.session})])
    await tx.exec("SET LOCAL pos_security.payment_write_context='true'; UPDATE transactions SET paid=40,remaining=60")
  }),{code:'55000'})
  assert.deepEqual(await snapshot(db),before)
})

test('new sale posting errors propagate instead of swallowing the error',async t => {
  const db=await setup(t)
  await db.exec("ALTER TABLE accounting_entries ADD CONSTRAINT synthetic_sale_fail CHECK (invoice_no<>'FAIL-SALE')")
  const before=await snapshot(db)
  await assert.rejects(db.query(`INSERT INTO transactions(invoice_no,customer_id,book_id,total,paid,dp,remaining)
    VALUES ('FAIL-SALE',$1,$2,100,0,0,100)`,[customer,book]),{code:'23514'})
  assert.deepEqual(await snapshot(db),before)
})

test('009 operation replay is preserved but historical installments cannot become an initial DP baseline',async t => {
  const db=await setup(t,{paid:20,mutate:db=>db.exec(`INSERT INTO debt_payments(id,debt_id,invoice_no,customer_id,book_id,amount,payment_method)
    VALUES ('${id(600)}','${debt}','INV-A','${customer}','${book}',10,'cash')`)})
  await db.query(`INSERT INTO pos_security.payment_operations(operation_id,actor_auth_user_id,request_fingerprint,payment_id,debt_id,order_id,result,completed_at)
    VALUES ($1,$2,encode(sha256(convert_to(jsonb_build_object('invoice_no','INV-A','amount',30,'method','cash','notes','')::text,'UTF8')),'hex'),
      $3,$4,$5,'{"invoice_no":"INV-A","amount":30,"paid":20,"remaining":80,"status":"aktif"}',now())`,
  [operation,users.cashier.auth,id(600),debt,order])
  const before=await snapshot(db)
  assert.equal((await pay(db)).paid,20)
  await assert.rejects(pay(db,{op:id(501)}),{code:'22023'})
  await assert.rejects(reconcile(db),{code:'22023'})
  assert.deepEqual(await snapshot(db),before)
})

test('new sales after 010 use WIB date across UTC midnight and remain payable',async t => {
  const db=await setup(t)
  await db.exec("SET TIME ZONE 'UTC'")
  await db.query(`INSERT INTO transactions(id,invoice_no,customer_id,cashier_id,book_id,total,paid,dp,remaining,created_at)
    VALUES ($1,'MIDNIGHT',$2,$3,$4,100,0,0,100,'2026-09-11T18:00:00Z')`,[id(301),customer,users.cashier.admin,book])
  assert.deepEqual((await db.query("SELECT DISTINCT entry_date::text FROM accounting_entries WHERE invoice_no='MIDNIGHT'")).rows,
    [{entry_date:'2026-09-12'}])
  await pay(db,{invoice:'MIDNIGHT',method:'transfer'})
  assert.equal(Number(await scalar(db,"SELECT paid value FROM transactions WHERE invoice_no='MIDNIGHT'")),30)
})

test('pre-010 sale date mismatch at WIB midnight is not silently repaired',async t => {
  const db=await setup(t,{paid:20,mutate:db=>db.exec("SET TIME ZONE 'UTC'; UPDATE transactions SET created_at='2026-09-11T18:00:00Z',total=total")})
  const before=await snapshot(db)
  await assert.rejects(reconcile(db,{expected:{...expectedInitial(),created_at:'2026-09-11T18:00:00Z'}}),{code:'22023'})
  assert.deepEqual(await snapshot(db),before)
})

test('one NULL receipt journal predicate cannot be ignored by aggregate verification',async t => {
  const db=await setup(t)
  const before=await snapshot(db)
  await db.exec(`CREATE FUNCTION public.synthetic_null_cashier() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.account_code='1000' THEN NEW.cashier_id := NULL; END IF; RETURN NEW; END $$;
    CREATE TRIGGER zz_synthetic_null_cashier BEFORE INSERT ON accounting_entries FOR EACH ROW
      EXECUTE FUNCTION public.synthetic_null_cashier()`)
  await assert.rejects(pay(db),{code:'23514'})
  assert.deepEqual(await snapshot(db),before)
})

test('one NULL initial journal binding cannot be ignored by owner attestation',async t => {
  const db=await setup(t,{paid:20,mutate:db=>db.exec("UPDATE accounting_entries SET invoice_no=NULL WHERE account_code='1000'")})
  const before=await snapshot(db)
  await assert.rejects(reconcile(db),{code:'22023'})
  assert.deepEqual(await snapshot(db),before)
})
