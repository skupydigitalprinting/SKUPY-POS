import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
let PGlite
try { ({ PGlite } = require('@electric-sql/pglite')) } catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error
  ;({ PGlite } = require('/private/tmp/skupy-security-stage2/tools/security-lab/node_modules/@electric-sql/pglite'))
}
const read = path => readFile(new URL(path, import.meta.url), 'utf8')
const candidate = await read('../../supabase/security-stage2/009_business_operations.sql').catch(e => {
  if (e.code === 'ENOENT') return ''
  throw e
})
const id = n => `90000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const users = Object.fromEntries(['owner', 'admin', 'cashier', 'pic', 'foreign', 'inactive', 'unmapped'].map((n, i) =>
  [n, { admin: id(i + 1), auth: id(i + 11), session: id(i + 21) }]))
const book = id(100), bookB = id(101), customer = id(200), order = id(300), debt = id(400), operation = id(500)
const paymentSql = 'SELECT public.pos_record_payment($1,$2,$3,$4,$5) result'
const booksSql = 'SELECT public.pos_set_admin_books($1,$2,$3) result'
const readBooksSql = 'SELECT public.pos_admin_book_access($1) result'
async function setup(t, seedLegacyDamage) {
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
    '004_password_reset_status.sql','005_staff_directory.sql']) {
    await db.exec(await read(`../../supabase/security-stage2/${file}`))
  }
  for (const [name, u] of Object.entries(users)) {
    await db.query('INSERT INTO auth.users VALUES ($1)', [u.auth])
    await db.query('INSERT INTO auth.sessions VALUES ($1,$2,clock_timestamp())', [u.session, u.auth])
    await db.query("INSERT INTO public.admins(id,username,name,password,role) VALUES ($1,$2,$2,'synthetic-secret','owner')", [u.admin, name])
    if (name !== 'unmapped') await db.query(`INSERT INTO pos_security.user_access(auth_user_id,admin_id,role,active,login_username)
      VALUES ($1,$2,$3,$4,$5)`, [u.auth,u.admin,['owner','admin'].includes(name) ? name : 'staff',name !== 'inactive',name])
  }
  await db.exec(`INSERT INTO public.accounts(code,name,type,normal)
      SELECT code,code,'asset','debit' FROM unnest(ARRAY['1000','1100','1200','4000']) code;
    INSERT INTO public.books(id,name) VALUES ('${book}','A'),('${bookB}','B');
    INSERT INTO public.admin_book_access(admin_id,book_id) VALUES
      ('${users.cashier.admin}','${book}'),('${users.pic.admin}','${book}'),('${users.foreign.admin}','${bookB}');
    INSERT INTO public.customers(id,name,owner_user_id,book_id) VALUES ('${customer}','Customer','${users.pic.admin}','${book}');
    INSERT INTO public.transactions(id,invoice_no,customer_id,cashier_id,book_id,total,paid,dp,remaining,status)
      VALUES ('${order}','INV-A','${customer}','${users.cashier.admin}','${book}',100,20,20,80,'pending');
    INSERT INTO public.debts(id,invoice_no,customer_id,transaction_id,cashier_id,book_id,total_debt,paid,remaining)
      VALUES ('${debt}','INV-A','${customer}','${order}','${users.cashier.admin}','${book}',100,20,80);`)
  // Historical corruption predates the new guards. Never disable guards during RPC tests.
  if (seedLegacyDamage) await seedLegacyDamage(db)
  await db.exec(await read('../../supabase/security-stage2/006_business_access.sql'))
  await db.query('SELECT public.recalculate_customer_summary($1)',[customer])
  await db.exec(`ALTER DEFAULT PRIVILEGES GRANT ALL ON TABLES TO PUBLIC,anon,authenticated,service_role;
    ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO PUBLIC,anon,authenticated,service_role;
    GRANT INSERT(admin_id,book_id),UPDATE(admin_id,book_id) ON public.admin_book_access TO PUBLIC,anon,authenticated;`)
  if (candidate) {
    try { await db.exec(candidate) } catch (e) { delete e.query; throw e }
  }
  return db
}
async function as(db, name, sql, params = [], extra = {}, role = 'authenticated') {
  const u = users[name]
  return db.transaction(async tx => {
    await tx.exec(`SET LOCAL ROLE ${role}`)
    await tx.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub:u?.auth,session_id:u?.session,...extra })])
    return (await tx.query(sql,params)).rows
  })
}
const pay = async (db, name = 'cashier', op = operation, amount = 30, invoice = 'INV-A', method = 'cash', notes = '') =>
  (await as(db,name,paymentSql,[op,invoice,amount,method,notes]))[0].result
const setBooks = async (db, name = 'owner', target = users.cashier.admin, books = [bookB], version = 0) =>
  (await as(db,name,booksSql,[target,books,version]))[0].result
const readBooks = async (db, name = 'owner', target = users.cashier.admin) =>
  (await as(db,name,readBooksSql,[target]))[0].result
const deny = value => assert.rejects(value,{code:'42501'})
const balances = async db => (await db.query(`SELECT t.paid::int tp,t.remaining::int tr,d.paid::int dp,d.remaining::int dr,
    c.total_debt::int cd FROM public.transactions t JOIN public.debts d ON d.transaction_id=t.id
    JOIN public.customers c ON c.id=t.customer_id WHERE t.id=$1`,[order])).rows[0]
const count = async (db,table) => (await db.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n

test('atomic own-cashier payment updates order, debt, payment, summary and durable minimal receipt', async t => {
  const db = await setup(t)
  assert.deepEqual(await pay(db),{invoice_no:'INV-A',amount:30,paid:50,remaining:50,status:'aktif'})
  assert.deepEqual(await balances(db),{tp:50,tr:50,dp:50,dr:50,cd:50})
  const {rows:[p]} = await db.query('SELECT cashier_id,cashier,cashier_name,invoice_no,amount::int,book_id,customer_id FROM public.debt_payments')
  assert.deepEqual(p,{cashier_id:users.cashier.admin,cashier:'cashier',cashier_name:'cashier',invoice_no:'INV-A',amount:30,book_id:book,customer_id:customer})
  assert.equal(await count(db,'pos_security.payment_operations'),1)
  assert.equal((await db.query("SELECT sum(amount)::int n FROM public.cash_movements WHERE source_type='sale'")).rows[0].n,50)
})

test('PIC can atomically pay another cashiers RLS-hidden order without changing attribution or exposing it', async t => {
  const db = await setup(t)
  assert.deepEqual(await as(db,'pic','SELECT id FROM public.transactions'),[])
  await pay(db,'pic')
  assert.deepEqual(await balances(db),{tp:50,tr:50,dp:50,dr:50,cd:50})
  assert.deepEqual(await as(db,'pic','SELECT id FROM public.transactions'),[])
  assert.equal((await db.query('SELECT cashier_id FROM public.transactions')).rows[0].cashier_id,users.cashier.admin)
  assert.equal((await db.query('SELECT cashier_id FROM public.debt_payments')).rows[0].cashier_id,users.pic.admin)
})

test('current owner/admin can pay all books; foreign staff cannot use private legacy owner role', async t => {
  const db = await setup(t)
  await deny(pay(db,'foreign'))
  await pay(db,'admin',id(501),10)
  await pay(db,'owner',id(502),10)
  assert.equal((await balances(db)).tp,40)
  await db.query('DELETE FROM public.admin_book_access WHERE admin_id=$1',[users.cashier.admin])
  await deny(pay(db,'cashier'))
})

test('payment idempotency binds global operation to actor and normalized payload, returning original receipt', async t => {
  const db = await setup(t)
  const receipt = await pay(db)
  await pay(db,'cashier',id(501),10)
  assert.deepEqual(await pay(db),receipt)
  assert.equal(await count(db,'public.debt_payments'),2)
  assert.equal((await balances(db)).tp,60)
  await deny(pay(db,'pic'))
  for (const args of [[operation,31],[operation,30,'OTHER'],[operation,30,'INV-A','transfer'],[operation,30,'INV-A','cash','changed']]) {
    await assert.rejects(pay(db,'cashier',...args),{code:'22023'})
  }
  assert.equal(await count(db,'pos_security.payment_operations'),2)
})

test('invalid amounts, methods and parameters fail without durable operations or partial writes', async t => {
  const db = await setup(t)
  for (const amount of [0,-1,0.5,81,'NaN','Infinity',null]) await assert.rejects(pay(db,'cashier',operation,amount),{code:'22023'})
  for (const method of ['hutang','unknown',null]) await assert.rejects(pay(db,'cashier',operation,1,'INV-A',method),{code:'22023'})
  await assert.rejects(pay(db,'cashier',null),{code:'22023'})
  await assert.rejects(pay(db,'cashier',operation,1,''),{code:'22023'})
  assert.deepEqual(await balances(db),{tp:20,tr:80,dp:20,dr:80,cd:80})
  assert.equal(await count(db,'pos_security.payment_operations'),0)
})

test('overpayment after a successful payment rejects while the exact completed operation remains replayable', async t => {
  const db = await setup(t)
  const receipt = await pay(db,'cashier',operation,80)
  assert.deepEqual(receipt,{invoice_no:'INV-A',amount:80,paid:100,remaining:0,status:'lunas'})
  await assert.rejects(pay(db,'cashier',id(501),1),{code:'22023'})
  assert.deepEqual(await pay(db,'cashier',operation,80),receipt)
  assert.equal(await count(db,'public.debt_payments'),1)
})

test('cancelled, deleted and inconsistent debt/order links or money fail closed', async t => {
  for (const mutation of [
    "UPDATE public.transactions SET order_status='dibatalkan'", "UPDATE public.transactions SET deleted_at=now()",
    "UPDATE public.debts SET deleted_at=now()", "UPDATE public.debts SET transaction_id=NULL",
    "UPDATE public.debts SET total_debt=101", "UPDATE public.debts SET paid=21,remaining=79",
    "UPDATE public.debts SET remaining=79", "UPDATE public.transactions SET remaining=79",
    `UPDATE public.debts SET book_id='${bookB}'`, "UPDATE public.debts SET invoice_no='OTHER'",
  ]) {
    const db = await setup(t,db => db.exec(mutation))
    await assert.rejects(pay(db),e => ['22023','42501'].includes(e.code),mutation)
    assert.equal(await count(db,'public.debt_payments'),0)
  }
})

test('NULL-linked debt-only opening balance is valid and posts one receipt, never a hidden linked order fallback', async t => {
  const db = await setup(t)
  await db.query(`INSERT INTO public.debts(id,invoice_no,customer_id,book_id,total_debt,paid,remaining,is_opening)
    VALUES ($1,'OPEN',$2,$3,60,0,60,true)`,[id(401),customer,book])
  assert.deepEqual(await pay(db,'pic',operation,20,'OPEN','transfer'),{invoice_no:'OPEN',amount:20,paid:20,remaining:40,status:'aktif'})
  assert.equal((await balances(db)).tp,20)
  const p = (await db.query("SELECT id FROM public.debt_payments WHERE invoice_no='OPEN'")).rows[0]
  assert.equal((await db.query('SELECT sum(amount)::int n FROM public.cash_movements WHERE source_id=$1',[p.id])).rows[0].n,20)
  assert.deepEqual((await db.query('SELECT account_code,debit::int,credit::int FROM public.accounting_entries WHERE source_id=$1 ORDER BY account_code',[p.id])).rows,
    [{account_code:'1100',debit:20,credit:0},{account_code:'1200',debit:0,credit:20}])
  const damaged = await setup(t,db => db.query(`INSERT INTO public.debts(invoice_no,transaction_id,customer_id,book_id,total_debt,remaining)
    VALUES ('OPEN',$1,$2,$3,60,60)`,[order,customer,book]))
  await assert.rejects(pay(damaged,'pic',id(501),10,'OPEN'),{code:'22023'})
})

test('order without debt creates one from locked canonical balances only with an existing valid customer', async t => {
  const db = await setup(t)
  await db.query('DELETE FROM public.debts WHERE id=$1',[debt])
  await pay(db,'cashier')
  assert.equal(await count(db,'public.debts'),1)
  assert.deepEqual(await balances(db),{tp:50,tr:50,dp:50,dr:50,cd:50})
  await db.query('DELETE FROM public.debts WHERE transaction_id=$1',[order])
  await db.query('UPDATE public.transactions SET customer_id=NULL WHERE id=$1',[order])
  await assert.rejects(pay(db,'cashier',id(501),10),{code:'22023'})
  assert.equal(await count(db,'public.debts'),0)
})

test('ambiguous invoice/debt cardinality is refused without selecting an arbitrary debt', async t => {
  const db = await setup(t,db => db.query(`INSERT INTO public.debts(invoice_no,customer_id,book_id,total_debt,remaining)
    VALUES ('INV-A',$1,$2,100,100)`,[customer,book]))
  await assert.rejects(pay(db),{code:'22023'})
  assert.equal(await count(db,'public.debt_payments'),0)
})

test('payment insertion or swallowed journal failures roll back balances, summaries and operation reservation', async t => {
  const db = await setup(t)
  await db.exec(`CREATE FUNCTION public.synthetic_payment_fail() RETURNS trigger LANGUAGE plpgsql AS
    $$ BEGIN RAISE EXCEPTION 'synthetic failure'; END $$;
    CREATE TRIGGER synthetic_fail BEFORE INSERT ON public.debt_payments FOR EACH ROW EXECUTE FUNCTION public.synthetic_payment_fail()`)
  await assert.rejects(pay(db))
  assert.deepEqual(await balances(db),{tp:20,tr:80,dp:20,dr:80,cd:80})
  assert.equal(await count(db,'pos_security.payment_operations'),0)
  await db.exec(`DROP TRIGGER synthetic_fail ON public.debt_payments;
    CREATE TRIGGER synthetic_fail BEFORE INSERT ON public.accounting_entries FOR EACH ROW EXECUTE FUNCTION public.synthetic_payment_fail()`)
  await assert.rejects(pay(db),{code:'23514'})
  assert.deepEqual(await balances(db),{tp:20,tr:80,dp:20,dr:80,cd:80})
  assert.equal(await count(db,'public.debt_payments'),0)
  assert.equal(await count(db,'pos_security.payment_operations'),0)
})

test('RPCs and private operation ledger deny inherited grants, invalid sessions and invalid actors', async t => {
  const db = await setup(t)
  for (const role of ['anon','service_role','unrelated']) {
    await deny(as(db,'owner',paymentSql,[operation,'INV-A',1,'cash',''],{},role))
    await deny(as(db,'owner',booksSql,[users.cashier.admin,[book],0],{},role))
  }
  for (const name of ['inactive','unmapped']) await deny(pay(db,name))
  for (const session_id of [null,'bad',users.admin.session]) await deny(as(db,'cashier',paymentSql,[operation,'INV-A',1,'cash',''],{session_id}))
  for (const update of [`reset_operation='${id(990)}'`,'reset_operation=NULL,sessions_valid_after=clock_timestamp()']) {
    await db.exec(`UPDATE pos_security.user_access SET ${update} WHERE auth_user_id='${users.cashier.auth}'`)
    await deny(pay(db))
  }
  await db.exec('GRANT USAGE ON SCHEMA pos_security TO anon,authenticated,service_role,unrelated')
  for (const role of ['anon','authenticated','service_role','unrelated']) for (const sql of [
    'SELECT * FROM pos_security.payment_operations', 'DELETE FROM pos_security.payment_operations',
    'INSERT INTO pos_security.payment_operations DEFAULT VALUES', 'TRUNCATE pos_security.payment_operations']) await deny(as(db,'owner',sql,[],{},role))
  assert.equal((await db.query("SELECT relrowsecurity FROM pg_class WHERE oid='pos_security.payment_operations'::regclass")).rows[0].relrowsecurity,true)
})

test('book replacement validates mapped staff, deduplicates active books, clears atomically and changes RLS', async t => {
  const db = await setup(t)
  assert.deepEqual(await setBooks(db,'owner',users.cashier.admin,[bookB,book,bookB]),{admin_id:users.cashier.admin,book_ids:[book,bookB],version:1})
  assert.deepEqual(await as(db,'cashier','SELECT id FROM public.books ORDER BY id'),[{id:book},{id:bookB}])
  assert.deepEqual(await setBooks(db,'owner',users.cashier.admin,[],1),{admin_id:users.cashier.admin,book_ids:[],version:2})
  assert.deepEqual(await as(db,'cashier','SELECT id FROM public.books'),[])
  await deny(pay(db))
})

test('invalid book replacement and non-owner or invalid target attempts preserve original memberships', async t => {
  const db = await setup(t)
  for (const name of ['admin','cashier','pic','inactive','unmapped']) await deny(setBooks(db,name))
  for (const target of [users.owner.admin,users.admin.admin,users.inactive.admin,users.unmapped.admin,id(999),null]) await deny(setBooks(db,'owner',target))
  for (const books of [null,[null],[book,id(999)]]) await assert.rejects(setBooks(db,'owner',users.cashier.admin,books),{code:'22023'})
  for (const update of ['is_active=false','is_active=true,deleted_at=now()']) {
    await db.exec(`UPDATE public.books SET ${update} WHERE id='${bookB}'`)
    await assert.rejects(setBooks(db),{code:'22023'})
  }
  assert.deepEqual(await as(db,'cashier','SELECT book_id FROM public.admin_book_access'),[{book_id:book}])
})

test('book replacement rolls back delete when insertion fails and rechecks current owner session', async t => {
  const db = await setup(t)
  await db.exec(`ALTER TABLE public.admin_book_access ADD CONSTRAINT synthetic_book_failure CHECK (admin_id<>'${users.cashier.admin}' OR book_id<>'${bookB}')`)
  await assert.rejects(setBooks(db),{code:'23514'})
  assert.deepEqual(await as(db,'cashier','SELECT book_id FROM public.admin_book_access'),[{book_id:book}])
  await db.query('UPDATE pos_security.user_access SET active=false WHERE auth_user_id=$1',[users.owner.auth])
  await deny(setBooks(db))
})

test('normalized replay preserves original receipt after book removal but never after session revocation', async t => {
  const db = await setup(t)
  const receipt = await pay(db,'cashier',operation,30,' INV-A ',' CASH ',null)
  await setBooks(db,'owner',users.cashier.admin,[])
  assert.deepEqual(await pay(db,'cashier',operation,'30.00','INV-A','cash',''),receipt)
  await deny(pay(db,'cashier',id(501)))
  await db.query('UPDATE pos_security.user_access SET sessions_valid_after=clock_timestamp() WHERE auth_user_id=$1',[users.cashier.auth])
  await deny(pay(db))
})

test('queued retries append once; queued distinct operations cannot both spend the last balance (not multi-connection proof)', async t => {
  const db = await setup(t)
  const results = await Promise.all([pay(db),pay(db)])
  assert.deepEqual(results[0],results[1])
  assert.equal(await count(db,'public.debt_payments'),1)
  const settlements = await Promise.allSettled([pay(db,'cashier',id(501),50),pay(db,'pic',id(502),50)])
  assert.equal(settlements.filter(r => r.status==='fulfilled').length,1)
  assert.equal(settlements.find(r => r.status==='rejected').reason.code,'22023')
  assert.equal((await balances(db)).tr,0)
  assert.equal(await count(db,'public.debt_payments'),2)
})

test('opening invoice cannot impersonate an existing foreign-book order', async t => {
  const db = await setup(t,async db => {
    await db.query(`INSERT INTO public.transactions(invoice_no,cashier_id,book_id,total,paid,remaining)
      VALUES ('FOREIGN',$1,$2,60,0,60)`,[users.foreign.admin,bookB])
    await db.query(`INSERT INTO public.debts(invoice_no,customer_id,book_id,total_debt,remaining)
      VALUES ('FOREIGN',$1,$2,60,60)`,[customer,book])
  })
  await deny(pay(db,'pic',operation,10,'FOREIGN'))
  assert.equal(await count(db,'public.debt_payments'),0)
})

test('operation journal contains only identities, fingerprint and receipt, not notes or credential fields', async t => {
  const db = await setup(t)
  await db.exec("UPDATE public.transactions SET payment_method='qris'")
  await pay(db,'cashier',operation,10,'INV-A','qris','private receipt memo')
  const {rows:[row]} = await db.query('SELECT * FROM pos_security.payment_operations')
  assert.deepEqual(Object.keys(row).sort(),['operation_id','actor_auth_user_id','request_fingerprint','payment_id','debt_id','order_id','result','created_at','completed_at'].sort())
  assert.match(row.request_fingerprint,/^[0-9a-f]{64}$/)
  assert.equal(row.actor_auth_user_id,users.cashier.auth)
  assert.ok(!JSON.stringify(row).includes('private receipt memo'))
  assert.ok(!JSON.stringify(row).includes('synthetic-secret'))
  const funcs = await db.query(`SELECT proname,prosecdef,proconfig FROM pg_proc WHERE proname IN ('pos_record_payment','pos_set_admin_books') ORDER BY proname`)
  assert.deepEqual(funcs.rows,[{proname:'pos_record_payment',prosecdef:true,proconfig:['search_path=""']},{proname:'pos_set_admin_books',prosecdef:true,proconfig:['search_path=""']}])
})

test('linked mixed cash/bank tender rejects before any balances, payment or operation can commit', async t => {
  const db = await setup(t)
  for (const [original,requested] of [['cash','transfer'],['cash','qris'],['hutang','transfer'],['hutang','qris'],['transfer','cash'],['qris','cash']]) {
    await db.query('UPDATE public.transactions SET payment_method=$1',[original])
    await assert.rejects(pay(db,'cashier',operation,10,'INV-A',requested),{code:'22023'},`${original} -> ${requested}`)
    assert.deepEqual(await balances(db),{tp:20,tr:80,dp:20,dr:80,cd:80})
    assert.equal(await count(db,'public.debt_payments'),0)
    assert.equal(await count(db,'pos_security.payment_operations'),0)
  }
})

test('same cash-code tender posts exactly to its supported account; hutang supports cash only', async t => {
  for (const [original,requested,account] of [['hutang','cash','1000'],['cash','cash','1000'],['transfer','transfer','1100'],['qris','qris','1100'],['qris','transfer','1100']]) {
    const db = await setup(t)
    await db.query('UPDATE public.transactions SET payment_method=$1',[original])
    await pay(db,'pic',operation,30,'INV-A',requested)
    assert.equal((await db.query('SELECT debit::int amount FROM public.accounting_entries WHERE source_id=$1 AND account_code=$2',[order,account])).rows[0].amount,50)
    assert.equal((await db.query('SELECT payment_method FROM public.debt_payments')).rows[0].payment_method,requested)
    assert.equal((await db.query('SELECT payment_method FROM public.transactions')).rows[0].payment_method,original)
  }
})

test('book CAS rejects delayed grant A after confirmed clear B, including unchanged clear', async t => {
  const db = await setup(t)
  // Both requests originated from revision zero. B is confirmed before delayed A arrives.
  assert.deepEqual(await readBooks(db),{admin_id:users.cashier.admin,book_ids:[book],version:0})
  assert.deepEqual(await setBooks(db,'owner',users.cashier.admin,[],0),{admin_id:users.cashier.admin,book_ids:[],version:1})
  await assert.rejects(setBooks(db,'owner',users.cashier.admin,[bookB],0),{code:'40001'})
  assert.deepEqual(await readBooks(db),{admin_id:users.cashier.admin,book_ids:[],version:1})
  // A successful no-op is still a sequencing barrier against older requests.
  assert.deepEqual(await setBooks(db,'owner',users.cashier.admin,[],1),{admin_id:users.cashier.admin,book_ids:[],version:2})
  await assert.rejects(setBooks(db,'owner',users.cashier.admin,[bookB],1),{code:'40001'})
  assert.deepEqual(await as(db,'cashier','SELECT id FROM public.books'),[])
})

test('book read reports actual stored assignments and revision without hiding inactive books or mutating state', async t => {
  const db = await setup(t)
  assert.equal(await count(db,'pos_security.admin_book_revisions'),0)
  await db.query('UPDATE public.books SET is_active=false WHERE id=$1',[book])
  for (let i=0;i<2;i++) assert.deepEqual(await readBooks(db),{admin_id:users.cashier.admin,book_ids:[book],version:0})
  assert.equal(await count(db,'pos_security.admin_book_revisions'),0)
  await setBooks(db,'owner',users.cashier.admin,[bookB],0)
  assert.deepEqual(await readBooks(db),{admin_id:users.cashier.admin,book_ids:[bookB],version:1})
  assert.deepEqual(await readBooks(db,'owner',users.pic.admin),{admin_id:users.pic.admin,book_ids:[book],version:0})
})

test('book revisions and direct memberships deny client writes despite inherited column grants', async t => {
  const db = await setup(t)
  for (const name of ['owner','admin','cashier']) for (const sql of [
    `INSERT INTO public.admin_book_access(admin_id,book_id) VALUES ('${users.cashier.admin}','${bookB}')`,
    `UPDATE public.admin_book_access SET book_id='${bookB}' WHERE admin_id='${users.cashier.admin}'`,
    `DELETE FROM public.admin_book_access WHERE admin_id='${users.cashier.admin}'`,
    'TRUNCATE public.admin_book_access',
    'SELECT * FROM pos_security.admin_book_revisions',
    'INSERT INTO pos_security.admin_book_revisions DEFAULT VALUES',
    'UPDATE pos_security.admin_book_revisions SET version=0',
    'DELETE FROM pos_security.admin_book_revisions',
  ]) await deny(as(db,name,sql))
  assert.equal((await db.query("SELECT relrowsecurity FROM pg_class WHERE oid='pos_security.admin_book_revisions'::regclass")).rows[0].relrowsecurity,true)
  assert.equal((await db.query("SELECT to_regprocedure('public.pos_set_admin_books(uuid,uuid[])') old")).rows[0].old,null)
  assert.deepEqual(await as(db,'cashier','SELECT book_id FROM public.admin_book_access'),[{book_id:book}])
})

test('book read is owner-only and both RPCs deny invalid session, invalid target and raw service access', async t => {
  const db = await setup(t)
  for (const name of ['admin','cashier','pic','inactive','unmapped']) await deny(readBooks(db,name))
  for (const target of [users.owner.admin,users.admin.admin,users.inactive.admin,users.unmapped.admin,id(999),null]) await deny(readBooks(db,'owner',target))
  for (const role of ['anon','service_role','unrelated']) await deny(as(db,'owner',readBooksSql,[users.cashier.admin],{},role))
  await db.exec('GRANT USAGE ON SCHEMA pos_security TO anon,service_role,unrelated')
  for (const role of ['anon','service_role','unrelated']) await deny(as(db,'owner','SELECT * FROM pos_security.admin_book_revisions',[],{},role))
  for (const session_id of [null,'bad',users.cashier.session]) {
    await deny(as(db,'owner',readBooksSql,[users.cashier.admin],{session_id}))
    await deny(as(db,'owner',booksSql,[users.cashier.admin,[],0],{session_id}))
  }
})

test('invalid versions or failed replacements do not advance the revision or consume a valid expectation', async t => {
  const db = await setup(t)
  for (const version of [null,-1]) await assert.rejects(setBooks(db,'owner',users.cashier.admin,[],version),{code:'22023'})
  await assert.rejects(setBooks(db,'owner',users.cashier.admin,[],1),{code:'40001'})
  await db.exec(`ALTER TABLE public.admin_book_access ADD CONSTRAINT synthetic_cas_failure CHECK (admin_id<>'${users.cashier.admin}' OR book_id<>'${bookB}')`)
  await assert.rejects(setBooks(db,'owner',users.cashier.admin,[bookB],0),{code:'23514'})
  assert.deepEqual(await readBooks(db),{admin_id:users.cashier.admin,book_ids:[book],version:0})
  assert.deepEqual(await setBooks(db,'owner',users.cashier.admin,[],0),{admin_id:users.cashier.admin,book_ids:[],version:1})
})

test('lost grant response is reconciled by read, then a newer clear cannot be undone by grant replay', async t => {
  const db = await setup(t)
  await setBooks(db,'owner',users.cashier.admin,[bookB],0) // Discard committed response A.
  const observed = await readBooks(db)
  assert.deepEqual(observed,{admin_id:users.cashier.admin,book_ids:[bookB],version:1})
  await setBooks(db,'owner',users.cashier.admin,[],observed.version)
  await assert.rejects(setBooks(db,'owner',users.cashier.admin,[bookB],0),{code:'40001'})
  assert.deepEqual(await readBooks(db),{admin_id:users.cashier.admin,book_ids:[],version:2})
})

test('queued book CAS requests with the same expectation have one winner, not two acknowledgements', async t => {
  const db = await setup(t)
  const results = await Promise.allSettled([
    setBooks(db,'owner',users.cashier.admin,[bookB],0),
    setBooks(db,'owner',users.cashier.admin,[],0),
  ])
  const winner = results.find(r => r.status==='fulfilled')
  assert.equal(results.filter(r => r.status==='fulfilled').length,1)
  assert.equal(results.find(r => r.status==='rejected').reason.code,'40001')
  assert.deepEqual(await readBooks(db),winner.value)
  // PGlite queues one connection: this does not prove multi-connection locking.
})

test('book snapshot isolation is rejected and successful no-op cannot overflow the JSON-safe version', async t => {
  const db = await setup(t)
  for (const sql of [readBooksSql,booksSql]) {
    await assert.rejects(db.transaction(async tx => {
      await tx.exec('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ; SET LOCAL ROLE authenticated')
      await tx.query("SELECT set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:users.owner.auth,session_id:users.owner.session})])
      await tx.query(sql,sql===readBooksSql ? [users.cashier.admin] : [users.cashier.admin,[],0])
    }),{code:'25000'})
  }
  await db.query('INSERT INTO pos_security.admin_book_revisions(admin_id,version) VALUES ($1,9007199254740991)',[users.cashier.admin])
  await assert.rejects(setBooks(db,'owner',users.cashier.admin,[book],9007199254740991),{code:'22023'})
  assert.deepEqual(await readBooks(db),{admin_id:users.cashier.admin,book_ids:[book],version:9007199254740991})
})
