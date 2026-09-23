import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { businessTables, businessGroups } from './business-fixture.js'

const require = createRequire(import.meta.url)
let PGlite
try { ({ PGlite } = require('@electric-sql/pglite')) } catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error
  ;({ PGlite } = require('/private/tmp/skupy-security-stage2/tools/security-lab/node_modules/@electric-sql/pglite'))
}
const read = file => readFile(new URL(file, import.meta.url), 'utf8')
const candidate = await read('../../supabase/security-stage2/006_business_access.sql').catch(e => {
  if (e.code === 'ENOENT') return '' // RED runs the real permissive baseline.
  throw e
})
const uuid = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const names = ['owner', 'admin', 'staff', 'other', 'inactive', 'unmapped', 'empty']
const users = Object.fromEntries(names.map((name, i) => [name, { id: uuid(i + 1), auth: uuid(i + 11), session: uuid(i + 21) }]))
const book = uuid(100), otherBook = uuid(101), customer = uuid(200), otherCustomer = uuid(201)
const order = uuid(300), otherOrder = uuid(301), debt = uuid(400), otherDebt = uuid(401), product = uuid(500)
async function setup(t, apply = true, beforeCandidate) {
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(`CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS; CREATE ROLE unrelated NOLOGIN;
    ALTER DEFAULT PRIVILEGES GRANT ALL ON TABLES TO PUBLIC, anon, authenticated;
    ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO PUBLIC, anon, authenticated;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE TABLE auth.sessions(id uuid PRIMARY KEY, user_id uuid REFERENCES auth.users, created_at timestamptz);
    REVOKE ALL ON ALL TABLES IN SCHEMA auth FROM PUBLIC, anon, authenticated;
    CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS
      $$ SELECT nullif(current_setting('request.jwt.claims', true), '')::jsonb $$;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT (auth.jwt()->>'sub')::uuid $$;`)
  await db.exec(await read('business-schema.sql'))
  if (!apply) return db
  for (const file of ['001_identity_bridge.sql', '002_username_login.sql', '003_password_recovery.sql',
    '004_password_reset_status.sql', '005_staff_directory.sql']) await db.exec(await read(`../../supabase/security-stage2/${file}`))
  // Column ACLs survive a table-level REVOKE; exercise both inherited and direct ACLs.
  await db.exec(`GRANT SELECT(password), UPDATE(password), INSERT(password), REFERENCES(password) ON public.admins TO PUBLIC, anon, authenticated;
    GRANT SELECT(modal), UPDATE(modal), INSERT(modal), REFERENCES(modal) ON public.products TO PUBLIC, anon, authenticated;`)
  for (const [name, u] of Object.entries(users)) {
    await db.query('INSERT INTO auth.users VALUES ($1)', [u.auth])
    await db.query('INSERT INTO auth.sessions VALUES ($1,$2,clock_timestamp())', [u.session, u.auth])
    await db.query("INSERT INTO public.admins(id,username,password,name,role) VALUES ($1,$2,'synthetic-secret',$2,'owner')", [u.id, name])
    if (name !== 'unmapped') await db.query(`INSERT INTO pos_security.user_access(auth_user_id,admin_id,role,active,login_username)
      VALUES ($1,$2,$3,$4,$5)`, [u.auth, u.id, ['owner', 'admin'].includes(name) ? name : 'staff', name !== 'inactive', name])
  }
  await db.exec(`INSERT INTO public.accounts(code,name,type,normal)
    SELECT code,code,'asset','debit' FROM unnest(ARRAY['1000','1100','1200','1250','1300','1400','2000','2100','4000','5000','6000']) code;
    INSERT INTO public.books(id,name) VALUES ('${book}','A'),('${otherBook}','B');
    INSERT INTO public.admin_book_access(admin_id,book_id) VALUES ('${users.staff.id}','${book}'),('${users.other.id}','${otherBook}');
    INSERT INTO public.products(id,name,price,modal) VALUES ('${product}','Synthetic product',100,47);
    INSERT INTO public.customers(id,name,owner_user_id,book_id) VALUES
      ('${customer}','A','${users.staff.id}','${book}'),('${otherCustomer}','B','${users.other.id}','${otherBook}');
    INSERT INTO public.transactions(id,invoice_no,customer_id,cashier_id,book_id,total,paid,remaining)
      VALUES ('${order}','A','${customer}','${users.staff.id}','${book}',100,30,70),
             ('${otherOrder}','B','${otherCustomer}','${users.other.id}','${otherBook}',200,40,160);
    INSERT INTO public.debts(id,customer_id,transaction_id,book_id,invoice_no,total_debt,paid,remaining)
      VALUES ('${debt}','${customer}','${order}','${book}','A',100,30,70),
             ('${otherDebt}','${otherCustomer}','${otherOrder}','${otherBook}','B',200,40,160);`)
  if (beforeCandidate) await beforeCandidate(db)
  if (candidate) {
    try { await db.exec(candidate) } catch (error) {
      delete error.query // Keep the diagnostic, not a repeated full migration dump.
      throw error
    }
  }
  return db
}
async function as(db, name, sql, params = [], extra = {}, role = 'authenticated') {
  const u = users[name]
  return db.transaction(async tx => {
    await tx.exec(`SET LOCAL ROLE ${role}`)
    await tx.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: u?.auth, session_id: u?.session, ...extra })])
    return tx.query(sql, params)
  })
}
const denied = promise => assert.rejects(promise, { code: '42501' })
const ids = async (db, name, table) => (await as(db, name, `SELECT id FROM public.${table} ORDER BY id`)).rows.map(r => r.id)

test('fixture preserves 41 empty tables, exact columns/defaults/constraints and 17 original triggers', async t => {
  const db = await setup(t, false)
  const manifest = JSON.parse(await read('business-manifest.json'))
  assert.deepEqual((await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows.map(r => r.tablename), businessTables)
  for (const table of manifest.tables) {
    assert.equal((await db.query(`SELECT count(*)::int n FROM public.${table.name}`)).rows[0].n, 0)
    const actual = (await db.query(`SELECT a.attname name,format_type(a.atttypid,a.atttypmod) type,
      pg_get_expr(d.adbin,d.adrelid) AS "default", a.attnotnull AS notnull FROM pg_attribute a
      LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE a.attrelid=$1::regclass AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`, [`public.${table.name}`])).rows
    assert.deepEqual(actual, table.columns.map(({ name, type, default: def, notnull }) => ({ name, type, default: def, notnull })))
    assert.deepEqual((await db.query(`SELECT conname name,contype type,pg_get_constraintdef(oid) definition
      FROM pg_constraint WHERE conrelid=$1::regclass ORDER BY conname`, [`public.${table.name}`])).rows,
    [...table.constraints].sort((a, b) => a.name.localeCompare(b.name)))
  }
  assert.equal((await db.query("SELECT count(*)::int n FROM pg_trigger WHERE NOT tgisinternal")).rows[0].n, 17)
  assert.deepEqual((await db.query(`SELECT t.tgname name,c.relname AS "table",pg_get_triggerdef(t.oid) definition
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE NOT t.tgisinternal ORDER BY c.relname,t.tgname`)).rows,
  [...manifest.triggers].sort((a, b) => `${a.table}/${a.name}`.localeCompare(`${b.table}/${b.name}`)))
  assert.deepEqual((await db.query("SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY indexname")).rows,
  manifest.indexes.map(({ indexname, indexdef }) => ({ indexname, indexdef })).sort((a, b) => a.indexname.localeCompare(b.indexname)))
  for (const fn of manifest.functions) {
    const { rows: [actual] } = await db.query("SELECT prosrc,prosecdef FROM pg_proc WHERE oid=$1::regprocedure", [`public.${fn.name}(${fn.identity.split(',').map(s => s.trim().split(' ').at(-1)).filter(Boolean).join(',')})`])
    assert.ok(fn.definition.includes(actual.prosrc))
    assert.equal(actual.prosecdef, fn.definition.includes('SECURITY DEFINER'))
  }
})

test('anon loses every business table and inherited credential/cost column ACL', async t => {
  const db = await setup(t)
  for (const table of businessTables) await denied(as(db, 'owner', `SELECT * FROM public.${table}`, [], {}, 'anon'))
  for (const name of ['owner', 'admin', 'staff']) for (const sql of [
    'SELECT password FROM public.admins', "SELECT id FROM public.admins WHERE password='synthetic-secret'",
    "UPDATE public.admins SET password='changed'", "INSERT INTO public.admins(username,password) VALUES ('x','x')",
    'SELECT modal FROM public.products', 'SELECT to_jsonb(p) FROM public.products p',
    'UPDATE public.products SET modal=0', "INSERT INTO public.products(name,modal) VALUES ('x',0)",
    'SELECT * FROM pos_security.user_access', 'TRUNCATE public.products',
  ]) await denied(as(db, name, sql))
  for (const [table, column] of [['admins', 'password'], ['products', 'modal']]) {
    assert.ok([null, '{}'].includes((await db.query(`SELECT attacl FROM pg_attribute WHERE attrelid=$1::regclass AND attname=$2`, [`public.${table}`, column])).rows[0].attacl))
  }
})

test('unmapped, inactive, reset-pending and stale/malformed sessions fail closed', async t => {
  const db = await setup(t)
  for (const name of ['unmapped', 'inactive']) {
    assert.deepEqual(await ids(db, name, 'products'), [])
    await denied(as(db, name, "INSERT INTO public.product_categories(id,label) VALUES ('x','x')"))
  }
  for (const session_id of [null, 'malformed', users.admin.session, uuid(9999)]) assert.deepEqual((await as(db, 'owner', 'SELECT id FROM public.products', [], { session_id })).rows, [])
  for (const change of [`reset_operation='${uuid(800)}'`, 'reset_operation=NULL,sessions_valid_after=clock_timestamp()']) {
    await db.exec(`UPDATE pos_security.user_access SET ${change} WHERE admin_id='${users.owner.id}'`)
    assert.deepEqual(await ids(db, 'owner', 'transactions'), [])
    await denied(as(db, 'owner', "SELECT public.acc_dashboard(current_date,current_date)", [], { iat: 9999999999 }))
  }
})

test('trusted roles, explicit books, own orders and customer PIC control reads without orphan fallback', async t => {
  const db = await setup(t)
  for (const name of ['owner', 'admin']) {
    assert.deepEqual(await ids(db, name, 'transactions'), [order, otherOrder])
    assert.deepEqual(await ids(db, name, 'customers'), [customer, otherCustomer])
  }
  assert.deepEqual(await ids(db, 'staff', 'transactions'), [order])
  assert.deepEqual(await ids(db, 'staff', 'customers'), [customer])
  assert.deepEqual(await ids(db, 'staff', 'debts'), [debt])
  assert.deepEqual(await ids(db, 'empty', 'books'), [])
  assert.deepEqual(await ids(db, 'staff', 'books'), [book])
  await db.exec(`UPDATE public.customers SET owner_user_id=NULL WHERE id='${customer}'`)
  assert.deepEqual(await ids(db, 'staff', 'customers'), [])
  assert.deepEqual(await ids(db, 'staff', 'debts'), [])
  // Leave no linked debt before testing an orphan transaction's read scope.
  await db.exec(`DELETE FROM public.debts WHERE id='${debt}'; UPDATE public.transactions SET book_id=NULL WHERE id='${order}'`)
  assert.deepEqual(await ids(db, 'staff', 'transactions'), [])
})

test('cross-staff/cross-book writes, self-provisioning, relinking and identity edits deny', async t => {
  const db = await setup(t)
  assert.equal((await as(db, 'staff', 'UPDATE public.transactions SET notes=$1 WHERE id=$2 RETURNING id', ['x', otherOrder])).rows.length, 0)
  for (const sql of [
    `INSERT INTO public.transactions(invoice_no,cashier_id,book_id) VALUES ('forged','${users.other.id}','${book}')`,
    `INSERT INTO public.transactions(invoice_no,cashier_id,book_id) VALUES ('crossbook','${users.staff.id}','${otherBook}')`,
    `INSERT INTO public.admin_book_access(admin_id,book_id) VALUES ('${users.staff.id}','${otherBook}')`,
    `UPDATE public.transactions SET cashier_id='${users.other.id}' WHERE id='${order}'`,
    `UPDATE public.transactions SET customer_id='${otherCustomer}' WHERE id='${order}'`,
    `UPDATE public.customers SET owner_user_id='${users.other.id}' WHERE id='${customer}'`,
  ]) await denied(as(db, 'staff', sql))
  await denied(as(db, 'staff', `UPDATE public.customers SET total_spent=999 WHERE id='${customer}'`))
  await denied(as(db, 'owner', `UPDATE public.debts SET customer_id='${otherCustomer}' WHERE id='${debt}'`))
  await denied(as(db, 'staff', `INSERT INTO public.debt_payments(debt_id,amount,book_id) VALUES ('${otherDebt}',1,'${book}')`))
})

test('shared product/category CRUD preserves cost privacy and omitted values through save RPC', async t => {
  const db = await setup(t)
  for (const name of ['owner', 'admin', 'staff']) {
    const { rows: [{ saved }] } = await as(db, name, 'SELECT public.pos_save_product(NULL,$1) saved', [{ name, price: 5, category: 'test' }])
    assert.ok(saved.id)
    assert.equal(Object.hasOwn(saved, 'modal'), name === 'owner')
    await as(db, name, 'SELECT public.pos_save_product($1,$2)', [saved.id, { description: 'edit' }])
    await as(db, name, 'UPDATE public.products SET is_favorite=true WHERE id=$1', [saved.id])
    await as(db, name, 'DELETE FROM public.products WHERE id=$1', [saved.id])
    await as(db, name, 'INSERT INTO public.product_categories(id,label) VALUES ($1,$1)', [name])
    await as(db, name, 'UPDATE public.product_categories SET label=$1 WHERE id=$1', [name])
    await as(db, name, 'DELETE FROM public.product_categories WHERE id=$1', [name])
  }
  await as(db, 'owner', 'SELECT public.pos_save_product($1,$2)', [product, { modal: 81 }])
  await as(db, 'staff', 'SELECT public.pos_save_product($1,$2)', [product, { price: 101 }])
  assert.deepEqual((await as(db, 'owner', 'SELECT * FROM public.pos_product_costs()')).rows, [{ id: product, modal: '81' }])
  for (const name of ['admin', 'staff', 'unmapped']) {
    await denied(as(db, name, 'SELECT * FROM public.pos_product_costs()'))
    await denied(as(db, name, 'SELECT public.pos_save_product($1,$2)', [product, { modal: null }]))
  }
  for (const value of [{ id: uuid(800) }, { created_at: '2000-01-01' }, { password: 'x' }, [], null]) {
    await assert.rejects(as(db, 'owner', 'SELECT public.pos_save_product($1,$2)', [product, value]))
  }
  assert.equal(Number((await db.query('SELECT modal FROM public.products WHERE id=$1', [product])).rows[0].modal), 81)
})

test('owner configuration and owner/admin accounting matrix exclude forged legacy owner staff', async t => {
  const db = await setup(t)
  for (const name of ['owner', 'admin']) for (const table of businessGroups.accounting) await as(db, name, `SELECT * FROM public.${table}`)
  for (const table of businessGroups.accounting) assert.deepEqual((await as(db, 'staff', `SELECT * FROM public.${table}`)).rows, [])
  for (const name of ['admin', 'staff']) {
    await denied(as(db, name, "INSERT INTO public.books(name) VALUES ('forbidden')"))
    await denied(as(db, name, "INSERT INTO public.settings(name) VALUES ('x')"))
  }
  await as(db, 'owner', "INSERT INTO public.books(name) VALUES ('allowed')")
  await as(db, 'admin', "INSERT INTO public.expenses(amount,note) VALUES (12,'admin allowed')")
  await denied(as(db, 'staff', "INSERT INTO public.expenses(amount,note) VALUES (12,'staff denied')"))
})

test('direct business RPC bypasses and historical bootstrap cannot reopen grants or policies', async t => {
  const db = await setup(t)
  const internal = ["acc_cash_code('cash')", `acc_recalc_bank_loan('${uuid(700)}')`, `acc_repost_asset_purchase('${uuid(700)}')`, `recalculate_customer_summary('${customer}')`, 'acc_bootstrap_migration_details()']
  const exposed = ['acc_dashboard(current_date,current_date)', 'acc_summary(current_date,current_date)',
    'acc_recap_admin(current_date,current_date)', `acc_delete_supplier_debt('${uuid(700)}')`,
    `acc_delete_employee_advance('${uuid(700)}')`, 'acc_resync()']
  for (const call of internal) for (const name of ['owner', 'admin', 'staff']) await denied(as(db, name, `SELECT public.${call}`))
  for (const call of [...internal, ...exposed]) await denied(as(db, 'owner', `SELECT public.${call}`, [], {}, 'anon'))
  for (const call of exposed) await denied(as(db, 'staff', `SELECT public.${call}`))
  for (const name of ['owner', 'admin']) for (const call of exposed.slice(0, 4)) await as(db, name, `SELECT public.${call}`)
  await denied(as(db, 'admin', 'SELECT public.acc_resync()'))
  // Even privileged accidental execution is inert: its old DDL body is gone.
  await denied(db.query('SELECT public.acc_bootstrap_migration_details()'))
  assert.equal((await db.query("SELECT count(*)::int n FROM pg_policies WHERE schemaname='public' AND roles @> ARRAY['public']::name[]")).rows[0].n, 0)
})

test('raw ledger/cash mutation denied while cashier DP, payment, cancellation and summaries post', async t => {
  const db = await setup(t)
  for (const name of ['owner', 'admin', 'staff']) for (const table of ['accounting_entries', 'cash_movements']) {
    for (const sql of [`INSERT INTO public.${table} DEFAULT VALUES`, `DELETE FROM public.${table}`, `UPDATE public.${table} SET source_id='${uuid(800)}'`]) await denied(as(db, name, sql))
  }
  const id = uuid(302)
  await as(db, 'staff', `INSERT INTO public.transactions(id,invoice_no,customer_id,cashier_id,book_id,total,paid,remaining)
    VALUES ($1,'DP',$2,$3,$4,100,25,75)`, [id, customer, users.staff.id, book])
  let rows = (await db.query('SELECT account_code,debit,credit FROM public.accounting_entries WHERE source_id=$1 ORDER BY account_code', [id])).rows
  assert.deepEqual(rows, [{ account_code: '1000', debit: '25', credit: '0' }, { account_code: '1200', debit: '75', credit: '0' }, { account_code: '4000', debit: '0', credit: '100' }])
  await as(db, 'staff', 'UPDATE public.transactions SET paid=100,remaining=0 WHERE id=$1', [id])
  await as(db, 'staff', 'INSERT INTO public.debt_payments(debt_id,amount,cashier_id) VALUES ($1,70,$2)', [debt, users.staff.id])
  assert.deepEqual((await ids(db, 'staff', 'debt_payments')).length, 1)
  assert.equal((await db.query('SELECT sum(amount)::int n FROM public.cash_movements WHERE source_id=$1', [id])).rows[0].n, 100)
  await as(db, 'staff', "UPDATE public.transactions SET order_status='dibatalkan' WHERE id=$1", [id])
  assert.equal((await db.query('SELECT count(*)::int n FROM public.accounting_entries WHERE source_id=$1', [id])).rows[0].n, 0)
  assert.ok((await as(db, 'admin', "SELECT public.acc_summary('2000-01-01','2100-01-01') summary")).rows[0].summary)
  await denied(as(db, 'staff', `UPDATE public.transactions SET total=1 WHERE id='${order}'`))
})

test('Accounting source triggers retain privilege to post and update parent balances; parent IDs immutable', async t => {
  const db = await setup(t)
  const loan = uuid(601), supplier = uuid(602), advance = uuid(603), asset = uuid(604)
  await as(db, 'admin', "INSERT INTO public.purchases(amount,is_credit) VALUES (20,false)")
  await as(db, 'admin', "INSERT INTO public.expenses(amount) VALUES (15)")
  await as(db, 'admin', 'INSERT INTO public.supplier_debts(id,total) VALUES ($1,100)', [supplier])
  await as(db, 'admin', 'INSERT INTO public.supplier_debt_payments(supplier_debt_id,amount) VALUES ($1,20)', [supplier])
  await as(db, 'admin', "INSERT INTO public.bank_loans(id,nama_bank,pokok_awal,sisa_pokok) VALUES ($1,'Synthetic bank',100,100)", [loan])
  await as(db, 'admin', 'INSERT INTO public.bank_loan_payments(loan_id,amount) VALUES ($1,25)', [loan])
  await as(db, 'admin', "INSERT INTO public.employee_cash_advances(id,employee_name,amount) VALUES ($1,'Synthetic employee',100)", [advance])
  await as(db, 'admin', 'INSERT INTO public.employee_cash_advance_payments(cash_advance_id,amount) VALUES ($1,30)', [advance])
  await as(db, 'admin', "INSERT INTO public.assets(id,name,purchase_price,purchase_date,payment_tracking) VALUES ($1,'Synthetic asset',100,current_date,true)", [asset])
  await as(db, 'admin', "INSERT INTO public.asset_purchase_payments(asset_id,amount) VALUES ($1,40)", [asset])
  for (const [table, field, id, expected] of [['supplier_debts', 'remaining', supplier, 80], ['bank_loans', 'sisa_pokok', loan, 75], ['employee_cash_advances', 'remaining', advance, 70]]) {
    assert.equal(Number((await db.query(`SELECT ${field} value FROM public.${table} WHERE id=$1`, [id])).rows[0].value), expected)
  }
  for (const source of ['purchase', 'expense', 'supplier_debt', 'supplier_payment', 'bank_payment', 'employee_advance', 'employee_advance_payment', 'asset_purchase', 'asset_purchase_payment']) {
    assert.ok((await db.query('SELECT count(*)::int n FROM public.accounting_entries WHERE source_type=$1', [source])).rows[0].n > 0, source)
  }
  for (const [table, parent] of [['supplier_debt_payments', 'supplier_debt_id'], ['bank_loan_payments', 'loan_id'], ['employee_cash_advance_payments', 'cash_advance_id'], ['asset_purchase_payments', 'asset_id']]) {
    await denied(as(db, 'owner', `UPDATE public.${table} SET ${parent}='${uuid(999)}'`))
  }
  await as(db, 'admin', 'SELECT public.acc_delete_supplier_debt($1)', [supplier])
  assert.equal((await db.query('SELECT count(*)::int n FROM public.accounting_entries WHERE source_id=$1', [supplier])).rows[0].n, 0)
})

test('product save errors never disclose the existing hidden cost and failed creates roll back', async t => {
  const db = await setup(t)
  await as(db, 'owner', 'SELECT public.pos_save_product($1,$2)', [product, { modal: 912345.67 }])
  for (const values of [{ name: null }, { price: 'not-numeric' }, { is_favorite: 'not-boolean' }]) {
    await assert.rejects(as(db, 'staff', 'SELECT public.pos_save_product($1,$2)', [product, values]), error => {
      assert.ok(!JSON.stringify(error).includes('912345.67'), 'hidden cost leaked in error detail')
      return true
    })
  }
  await assert.rejects(as(db, 'staff', 'SELECT public.pos_save_product(NULL,$1)', [{ name: 'rollback', price: 'bad' }]))
  await assert.rejects(as(db, 'staff', 'UPDATE public.products SET name=NULL WHERE id=$1', [product]), error => {
    assert.ok(!JSON.stringify(error).includes('912345.67'), 'direct-column error leaked hidden cost')
    return true
  })
  assert.deepEqual(await ids(db, 'staff', 'products'), [product])
})

test('every actual original RPC/trigger has hardened privileges and fixed search path', async t => {
  const db = await setup(t)
  const manifest = JSON.parse(await read('business-manifest.json'))
  const moved = new Set(['acc_dashboard', 'acc_summary', 'acc_recap_admin', 'acc_delete_supplier_debt', 'acc_delete_employee_advance', 'acc_resync'])
  for (const fn of manifest.functions) {
    const args = fn.identity.split(',').map(s => s.trim().split(' ').at(-1)).filter(Boolean).join(',')
    const sig = `${moved.has(fn.name) ? 'pos_security' : 'public'}.${fn.name}(${args})`
    const { rows: [actual] } = await db.query(`SELECT proconfig,
      has_function_privilege('anon',oid,'EXECUTE') anon,
      has_function_privilege('authenticated',oid,'EXECUTE') authenticated,
      has_function_privilege('service_role',oid,'EXECUTE') service FROM pg_proc WHERE oid=$1::regprocedure`, [sig])
    assert.deepEqual(actual, { proconfig: ['search_path=""'], anon: false, authenticated: false, service: false }, sig)
  }
  for (const call of ['pos_security.acc_resync()', "pos_security.acc_delete_supplier_debt(NULL)",
    'pos_security.business_require()', 'pos_security.business_guard()']) await denied(as(db, 'owner', `SELECT ${call}`))
  for (const call of ['public.pos_product_costs()', "public.pos_save_product(NULL,'{\"name\":\"x\"}')"]) {
    for (const role of ['anon', 'service_role', 'unrelated']) await denied(as(db, 'owner', `SELECT ${call}`, [], {}, role))
  }
})

test('inactive/deleted books and empty memberships deny staff even with matching PIC/cashier', async t => {
  const db = await setup(t)
  for (const update of ['is_active=false', 'is_active=true,deleted_at=now()']) {
    await db.exec(`UPDATE public.books SET ${update} WHERE id='${book}'`)
    for (const table of ['books', 'customers', 'transactions', 'debts']) assert.deepEqual(await ids(db, 'staff', table), [])
    assert.equal((await ids(db, 'owner', 'transactions')).length, 2)
    assert.equal((await ids(db, 'admin', 'transactions')).length, 2)
  }
  await db.exec(`UPDATE public.books SET is_active=true,deleted_at=NULL WHERE id='${book}'; DELETE FROM public.admin_book_access WHERE admin_id='${users.staff.id}'`)
  for (const table of ['books', 'customers', 'transactions', 'debts']) assert.deepEqual(await ids(db, 'staff', table), [])
  await denied(as(db, 'staff', `INSERT INTO public.customers(name,owner_user_id,book_id) VALUES ('no membership','${users.staff.id}','${book}')`))
})

test('invalid sessions see no rows in all 41 business tables; owner JWT does not authorize anon', async t => {
  const db = await setup(t)
  for (const table of businessTables) {
    const col = table === 'accounts' ? 'code' : 'id'
    for (const name of ['inactive', 'unmapped']) assert.deepEqual((await as(db, name, `SELECT ${col} FROM public.${table}`)).rows, [], table)
    assert.deepEqual((await as(db, 'owner', `SELECT ${col} FROM public.${table}`, [], { session_id: 'bad' })).rows, [], table)
  }
  await denied(as(db, 'owner', `INSERT INTO public.products(name) VALUES ('no session')`, [], { session_id: null }))
})

test('customer PIC can read assigned debt but cannot acquire another cashiers order or reparent records', async t => {
  const db = await setup(t)
  await db.exec(`UPDATE public.transactions SET cashier_id='${users.other.id}' WHERE id='${order}'`)
  assert.deepEqual(await ids(db, 'staff', 'transactions'), [])
  assert.deepEqual(await ids(db, 'staff', 'debts'), [debt])
  await as(db, 'staff', 'INSERT INTO public.debt_payments(debt_id,amount) VALUES ($1,10)', [debt])
  const payment = (await ids(db, 'staff', 'debt_payments'))[0]
  assert.ok(payment)
  assert.deepEqual(await ids(db, 'other', 'debt_payments'), [])
  await denied(as(db, 'owner', 'UPDATE public.debt_payments SET debt_id=$1 WHERE id=$2', [otherDebt, payment]))
  for (const table of ['order_customer_changes', 'customer_owner_changes', 'receivable_customer_changes']) {
    await denied(as(db, 'owner', `INSERT INTO public.${table} DEFAULT VALUES`))
  }
})

test('owner-only config writes across all config tables; authenticated cannot regain DDL authority', async t => {
  const db = await setup(t)
  for (const table of businessGroups.ownerconfig.filter(t => t !== 'admins')) {
    assert.equal((await db.query(`SELECT count(*)::int n FROM pg_policies WHERE schemaname='public' AND tablename=$1
      AND cmd IN ('INSERT','UPDATE','DELETE') AND coalesce(qual,with_check) LIKE '%business_owner%'`, [table])).rows[0].n, 3, table)
  }
  for (const sql of ['CREATE TABLE public.attack(id int)', 'ALTER TABLE public.transactions DISABLE ROW LEVEL SECURITY',
    'GRANT SELECT ON public.admins TO anon', 'CREATE FUNCTION public.acc_bootstrap_migration_details(int) RETURNS int LANGUAGE sql AS $$ SELECT 1 $$']) {
    await denied(as(db, 'owner', sql))
  }
  await db.exec('CREATE TABLE public.business_future_table(id uuid); CREATE FUNCTION public.business_future_fn() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$')
  await denied(as(db, 'owner', 'SELECT * FROM public.business_future_table'))
  await denied(as(db, 'owner', 'SELECT public.business_future_fn()'))
})

test('canonical trigger summaries cover own-cashier debt creation, payment updates and deletion without client aggregate writes', async t => {
  const db = await setup(t)
  const id = uuid(810), debtId = uuid(811)
  const summary = async () => (await db.query(`SELECT total_transactions,total_spent::int,total_debt::int FROM public.customers WHERE id=$1`, [customer])).rows[0]
  await as(db, 'staff', `INSERT INTO public.transactions(id,invoice_no,customer_id,cashier_id,book_id,total,paid,remaining)
    VALUES ($1,'summary',$2,$3,$4,100,20,80)`, [id, customer, users.staff.id, book])
  await as(db, 'staff', `INSERT INTO public.debts(id,customer_id,transaction_id,book_id,total_debt,paid,remaining,status)
    VALUES ($1,$2,$3,$4,100,20,80,'aktif')`, [debtId, customer, id, book])
  assert.deepEqual(await summary(), { total_transactions: 2, total_spent: 200, total_debt: 150 })
  await as(db, 'staff', 'UPDATE public.transactions SET paid=50,remaining=50 WHERE id=$1', [id])
  await as(db, 'staff', 'UPDATE public.debts SET paid=50,remaining=50 WHERE id=$1', [debtId])
  assert.deepEqual(await summary(), { total_transactions: 2, total_spent: 200, total_debt: 120 })
  await as(db, 'staff', "UPDATE public.debts SET paid=100,remaining=0,status='lunas' WHERE id=$1", [debtId])
  assert.deepEqual(await summary(), { total_transactions: 2, total_spent: 200, total_debt: 70 })
  await as(db, 'owner', 'DELETE FROM public.transactions WHERE id=$1', [id])
  assert.deepEqual(await summary(), { total_transactions: 1, total_spent: 100, total_debt: 70 })
  assert.deepEqual(await ids(db, 'other', 'customers'), [otherCustomer])
  await denied(as(db, 'owner', 'SELECT public.recalculate_customer_summary($1)', [customer]))
  await denied(as(db, 'staff', 'UPDATE public.customers SET total_debt=0 WHERE id=$1', [customer]))
  await denied(as(db, 'owner', 'SELECT pos_security.business_customer_summary_changed()'))
  // A failed derived write must roll back its source mutation, never warn/succeed.
  await db.exec(`ALTER TABLE public.customers ADD CONSTRAINT business_synthetic_summary_failure
    CHECK (id<>'${customer}' OR total_debt<80)`)
  await assert.rejects(as(db, 'staff', `INSERT INTO public.debts(id,customer_id,book_id,total_debt,remaining,status)
    VALUES ($1,$2,$3,50,50,'aktif')`, [debtId, customer, book]), { code: '23514' })
  assert.deepEqual((await db.query('SELECT id FROM public.debts WHERE id=$1', [debtId])).rows, [])
  assert.deepEqual(await summary(), { total_transactions: 1, total_spent: 100, total_debt: 70 })
})

test('canonical trigger retains the reviewed summary semantics, including historical cancelled/deleted rows', async t => {
  const db = await setup(t)
  // Deliberately retain the original helper's count/sum and status-only debt filter.
  await as(db, 'owner', "UPDATE public.transactions SET order_status='dibatalkan',deleted_at=now() WHERE id=$1", [order])
  await as(db, 'owner', 'UPDATE public.debts SET deleted_at=now(),remaining=12 WHERE id=$1', [debt])
  assert.deepEqual((await db.query('SELECT total_transactions,total_spent::int,total_debt::int FROM public.customers WHERE id=$1', [customer])).rows,
    [{ total_transactions: 1, total_spent: 100, total_debt: 12 }])
})

test('linked debt and payment invoices derive from the actual transaction when omitted', async t => {
  const db = await setup(t)
  const tx = uuid(850), d = uuid(851)
  await as(db, 'staff', `INSERT INTO public.transactions(id,invoice_no,customer_id,book_id,total)
    VALUES ($1,'CANONICAL',$2,$3,100)`, [tx, customer, book])
  await as(db, 'staff', `INSERT INTO public.debts(id,customer_id,transaction_id,book_id,total_debt)
    VALUES ($1,$2,$3,$4,100)`, [d, customer, tx, book])
  assert.deepEqual((await as(db, 'staff', 'SELECT invoice_no FROM public.debts WHERE id=$1', [d])).rows,
    [{ invoice_no: 'CANONICAL' }])
  assert.deepEqual((await as(db, 'staff', `INSERT INTO public.debt_payments(debt_id,amount)
    VALUES ($1,5) RETURNING invoice_no,customer_id,book_id`, [d])).rows,
  [{ invoice_no: 'CANONICAL', customer_id: customer, book_id: book }])
})

test('linked debt cannot claim another book invoice; failed forgery leaves dashboard unchanged', async t => {
  const db = await setup(t)
  const tx = uuid(852)
  await as(db, 'staff', `INSERT INTO public.transactions(id,invoice_no,customer_id,book_id,total)
    VALUES ($1,'LOCAL',$2,$3,100)`, [tx, customer, book])
  const dashboard = () => as(db, 'owner', "SELECT public.acc_dashboard('2000-01-01','2100-01-01') result")
  const before = (await dashboard()).rows
  await denied(as(db, 'staff', `INSERT INTO public.debts(customer_id,transaction_id,book_id,invoice_no,total_debt)
    VALUES ($1,$2,$3,'B',100)`, [customer, tx, book]))
  assert.deepEqual((await dashboard()).rows, before)
  assert.deepEqual(await ids(db, 'staff', 'debts'), [debt])
})

test('unlinked opening invoices cannot spoof any transaction; distinct labels and null remain usable', async t => {
  const db = await setup(t)
  for (const invoice of ['A', 'B']) await denied(as(db, 'staff', `INSERT INTO public.debts
    (customer_id,book_id,invoice_no,is_opening,total_debt) VALUES ($1,$2,$3,true,10)`, [customer, book, invoice]))
  for (const [i, invoice] of ['OPENING-ONLY', null].entries()) {
    const id = uuid(860 + i)
    await as(db, 'staff', `INSERT INTO public.debts
      (customer_id,book_id,invoice_no,is_opening,total_debt,id) VALUES ($1,$2,$3,true,10,$4)`, [customer, book, invoice, id])
    assert.deepEqual((await as(db, 'staff', `INSERT INTO public.debt_payments(debt_id,amount)
      VALUES ($1,1) RETURNING invoice_no`, [id])).rows, [{ invoice_no: invoice }])
  }
})

test('later transaction insertion cannot capture an opening invoice, even as table owner', async t => {
  const db = await setup(t)
  await as(db, 'staff', `INSERT INTO public.debts(customer_id,book_id,invoice_no,is_opening,total_debt)
    VALUES ($1,$2,'RESERVED-OPENING',true,10)`, [customer, book])
  const sql = `INSERT INTO public.transactions(invoice_no,customer_id,book_id,cashier_id)
    VALUES ('RESERVED-OPENING',$1,$2,$3)`
  const params = [otherCustomer, otherBook, users.other.id]
  await denied(as(db, 'other', sql, params))
  await denied(db.query(sql, params))
  assert.deepEqual((await db.query("SELECT id FROM public.transactions WHERE invoice_no='RESERVED-OPENING'")).rows, [])
})

test('duplicate linked debts and duplicate opening labels are rejected instead of guessed', async t => {
  const db = await setup(t)
  await denied(as(db, 'staff', `INSERT INTO public.debts(customer_id,transaction_id,book_id,invoice_no)
    VALUES ($1,$2,$3,'A')`, [customer, order, book]))
  await as(db, 'staff', `INSERT INTO public.debts(customer_id,book_id,invoice_no,is_opening)
    VALUES ($1,$2,'ONE-OPENING',true)`, [customer, book])
  await denied(as(db, 'other', `INSERT INTO public.debts(customer_id,book_id,invoice_no,is_opening)
    VALUES ($1,$2,'ONE-OPENING',true)`, [otherCustomer, otherBook]))
})

test('inconsistent legacy debt/payment references block payment and mutation without silent repair', async t => {
  const cases = [
    ['missing linked invoice', `UPDATE public.debts SET invoice_no=NULL WHERE id='${debt}'`],
    ['foreign linked invoice', `UPDATE public.debts SET invoice_no='B' WHERE id='${debt}'`],
    ['foreign transaction link', `UPDATE public.debts SET transaction_id='${otherOrder}' WHERE id='${debt}'`],
    ['unlinked invoice collision', `UPDATE public.debts SET transaction_id=NULL,invoice_no='B',is_opening=true WHERE id='${debt}'`],
    ['duplicate link', `INSERT INTO public.debts(customer_id,transaction_id,book_id,invoice_no)
      VALUES ('${customer}','${order}','${book}','A')`],
    ['inconsistent old payment', `INSERT INTO public.debt_payments(debt_id,amount,invoice_no,customer_id,book_id)
      VALUES ('${debt}',1,'B','${customer}','${book}')`],
  ]
  for (const [name, corrupt] of cases) await t.test(name, async sub => {
    const db = await setup(sub, true, db => db.exec(corrupt))
    const before = (await db.query('SELECT * FROM public.debts WHERE id=$1', [debt])).rows
    const payment = `INSERT INTO public.debt_payments(id,debt_id,amount) VALUES ($1,$2,5)`
    await denied(as(db, 'staff', payment, [uuid(853), debt]))
    // The future definer payment RPC must not bypass these integrity checks.
    await denied(db.query(payment, [uuid(853), debt]))
    await denied(as(db, 'owner', 'UPDATE public.debts SET notes=$1 WHERE id=$2', ['do not repair', debt]))
    assert.deepEqual((await db.query('SELECT * FROM public.debts WHERE id=$1', [debt])).rows, before)
    assert.deepEqual((await db.query('SELECT id FROM public.debt_payments WHERE id=$1', [uuid(853)])).rows, [])
  })
})

test('invoice-integrity trigger helper has no client, public or service execute grant', async t => {
  const db = await setup(t)
  assert.deepEqual((await db.query(`SELECT has_function_privilege('anon',oid,'EXECUTE') anon,
    has_function_privilege('authenticated',oid,'EXECUTE') authenticated,
    has_function_privilege('service_role',oid,'EXECUTE') service,
    has_function_privilege('unrelated',oid,'EXECUTE') unrelated
    FROM pg_proc WHERE oid=to_regprocedure('pos_security.business_invoice_guard()')`)).rows,
  [{ anon: false, authenticated: false, service: false, unrelated: false }])
})

test('invoice writes reject snapshot isolation that cannot refresh after the reference lock', async t => {
  const db = await setup(t)
  for (const isolation of ['REPEATABLE READ', 'SERIALIZABLE']) {
    await assert.rejects(db.transaction(async tx => {
      await tx.exec(`SET TRANSACTION ISOLATION LEVEL ${isolation}`)
      await tx.query("INSERT INTO public.transactions(invoice_no) VALUES ('UNSUPPORTED-ISOLATION')")
    }), { code: '25000' })
  }
  assert.deepEqual((await db.query("SELECT id FROM public.transactions WHERE invoice_no='UNSUPPORTED-ISOLATION'")).rows, [])
})
