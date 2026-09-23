import { PGlite } from '@electric-sql/pglite'
import { readFile } from 'node:fs/promises'

export const id = n => `b1000000-0000-4000-8000-${String(n).padStart(12, '0')}`
export const actors = Object.fromEntries(['owner', 'cashier', 'foreign', 'inactive'].map((name, i) =>
  [name, { admin: id(i + 1), auth: id(i + 11), session: id(i + 21) }]))
export const book = id(100), customer = id(200), order = id(300), debt = id(400)
const read = p => readFile(new URL(p, import.meta.url), 'utf8')
export async function fixture(t, { paid = 200000, mutate, baseline = false } = {}) {
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(`CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS; CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE TABLE auth.sessions(id uuid PRIMARY KEY,user_id uuid REFERENCES auth.users,created_at timestamptz);
    CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS
      $$ SELECT nullif(current_setting('request.jwt.claims',true),'')::jsonb $$;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT (auth.jwt()->>'sub')::uuid $$;`)
  await db.exec(await read('business-schema.sql'))
  for (const file of ['001_identity_bridge.sql', '002_username_login.sql', '003_password_recovery.sql',
    '004_password_reset_status.sql', '005_staff_directory.sql']) await db.exec(await read(`../../supabase/security-stage2/${file}`))
  for (const [name, actor] of Object.entries(actors)) {
    await db.query('INSERT INTO auth.users VALUES ($1)', [actor.auth])
    await db.query('INSERT INTO auth.sessions VALUES ($1,$2,clock_timestamp())', [actor.session, actor.auth])
    await db.query("INSERT INTO admins(id,username,name,password,role) VALUES ($1,$2,$2,'synthetic','owner')", [actor.admin, name])
    await db.query(`INSERT INTO pos_security.user_access(auth_user_id,admin_id,role,active,login_username)
      VALUES ($1,$2,$3,$4,$5)`, [actor.auth, actor.admin, name === 'owner' ? 'owner' : 'staff', name !== 'inactive', name])
  }
  await db.exec(`INSERT INTO accounts(code,name,type,normal)
    SELECT code,code,'asset','debit' FROM unnest(ARRAY['1000','1100','1200','4000']) code;
    INSERT INTO accounts(code,name,type,normal) VALUES ('2195','Synthetic customer refunds','liability','credit');
    INSERT INTO books(id,name) VALUES ('${book}','Synthetic');
    INSERT INTO admin_book_access(admin_id,book_id) VALUES ('${actors.cashier.admin}','${book}');
    INSERT INTO customers(id,name,owner_user_id,book_id) VALUES ('${customer}','Synthetic','${actors.cashier.admin}','${book}');`)
  await db.query(`INSERT INTO transactions(id,invoice_no,customer_id,cashier_id,book_id,items,subtotal,total,paid,dp,remaining,payment_method,created_at)
    VALUES ($1,'INV-LIFE',$2,$3,$4,'[{"productId":"gone","name":"Saved shirt","qty":5,"price":100000,"unit":"pcs"}]',500000,500000,$5,$5,500000-$5::numeric,'cash','2026-08-20T10:00:00Z')`,
  [order, customer, actors.cashier.admin, book, paid])
  await db.query(`INSERT INTO debts(id,invoice_no,customer_id,transaction_id,cashier_id,book_id,total_debt,paid,remaining)
    VALUES ($1,'INV-LIFE',$2,$3,$4,$5,500000,$6,500000-$6::numeric)`, [debt, customer, order, actors.cashier.admin, book, paid])
  if (mutate) await mutate(db)
  for (const file of ['006_business_access.sql', '009_business_operations.sql', '010_payment_event_ledger.sql']) {
    await db.exec(await read(`../../supabase/security-stage2/${file}`))
  }
  if (!baseline) {
    await db.exec(await read('../../supabase/security-stage2/011_invoice_lifecycle.sql'))
    await db.exec("INSERT INTO pos_security.invoice_account_config(singleton,refund_account) VALUES (true,'2195')")
  }
  return db
}
export async function as(db, name, sql, params = [], role = 'authenticated') {
  const actor = actors[name]
  return db.transaction(async tx => {
    await tx.exec(`SET LOCAL ROLE ${role}; SET LOCAL TIME ZONE 'Asia/Jakarta'`)
    await tx.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: actor.auth, session_id: actor.session })])
    return (await tx.query(sql, params)).rows
  })
}
export const change = async (db, { actor = 'cashier', op = id(500), version = 0, kind = 'edit', payload = draft() } = {}) =>
  (await as(db, actor, 'SELECT pos_apply_invoice_change($1,$2,$3,$4,$5) result', [op, order, version, kind, payload]))[0].result
export const draft = (total = 400000) => ({ items: [{ productId: 'gone', name: 'Saved shirt', qty: 1, price: total, unit: 'pcs' }],
  discount: 0, customerName: 'Synthetic corrected', notes: '', due_date: null, reason: 'Synthetic correction' })
export async function snapshot(db) {
  const result = {}
  for (const table of ['transactions', 'debts', 'debt_payments', 'customers', 'accounting_entries', 'cash_movements',
    'pos_security.invoice_operations', 'pos_security.invoice_states', 'pos_security.invoice_events', 'pos_security.invoice_write_context',
    'pos_security.payment_baselines', 'pos_security.payment_events', 'pos_security.payment_operations']) {
    result[table] = (await db.query(`SELECT to_jsonb(t) row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows
  }
  return result
}
