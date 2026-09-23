import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'

const sql = await readFile(new URL('../../supabase/security-stage2/008_storage_access.sql', import.meta.url), 'utf8').catch(e => { if (e.code === 'ENOENT') return ''; throw e })
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const users = ['owner', 'admin', 'staff', 'other', 'inactive'].map((role, i) => ({ role, auth: id(i + 1), admin: id(i + 11), session: id(i + 21) }))
async function setup(t, full = false) {
  const db = new PGlite(); t.after(() => db.close())
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth; CREATE SCHEMA storage;
    CREATE TABLE auth.users(id uuid PRIMARY KEY,email text);
    CREATE TABLE auth.sessions(id uuid PRIMARY KEY,user_id uuid,created_at timestamptz);
    CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT current_setting('request.jwt.claims',true)::jsonb $$;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT (auth.jwt()->>'sub')::uuid $$;
    ${full ? '' : 'CREATE TABLE public.admins(id uuid PRIMARY KEY,username text,name text,role text,password text); CREATE TABLE public.transactions(id uuid PRIMARY KEY,cashier_id uuid);'}
    CREATE TABLE storage.buckets(id text PRIMARY KEY,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    CREATE TABLE storage.objects(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),bucket_id text REFERENCES storage.buckets(id),name text,UNIQUE(bucket_id,name));
    INSERT INTO storage.buckets VALUES ('products',true,null,null),('logos',true,null,null),('invoices',true,null,null);
    GRANT USAGE ON SCHEMA public,storage,auth TO anon,authenticated;
    GRANT ALL ON storage.objects TO PUBLIC,anon,authenticated;
    ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
    CREATE POLICY "old-public-access" ON storage.objects FOR ALL USING(true) WITH CHECK(true);`)
  if (full) await db.exec(await readFile(new URL('business-schema.sql', import.meta.url), 'utf8'))
  await db.exec('GRANT SELECT ON public.transactions TO authenticated; ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;')
  for (const file of ['001_identity_bridge.sql','002_username_login.sql','003_password_recovery.sql','004_password_reset_status.sql','005_staff_directory.sql']) {
    await db.exec(await readFile(new URL(`../../supabase/security-stage2/${file}`, import.meta.url), 'utf8'))
  }
  await db.exec(`CREATE POLICY fixture_transaction_scope ON public.transactions FOR SELECT TO authenticated
    USING(cashier_id=(SELECT id FROM public.pos_current_profile()) OR (SELECT role FROM public.pos_current_profile()) IN ('owner','admin'));`)
  for (const u of users) {
    await db.query('INSERT INTO auth.users(id) VALUES($1)', [u.auth])
    await db.query('INSERT INTO auth.sessions VALUES($1,$2,now())', [u.session,u.auth])
    await db.query("INSERT INTO public.admins(id,username,name,role,password) VALUES($1,$2,$2,'owner','unused')", [u.admin,u.role])
    await db.query('INSERT INTO pos_security.user_access(auth_user_id,admin_id,role,active,login_username) VALUES($1,$2,$3,$4,$5)', [u.auth,u.admin,['other','inactive'].includes(u.role)?'staff':u.role,u.role!=='inactive',u.role])
  }
  if (full) {
    await db.query("INSERT INTO public.books(id,name) VALUES($1,'A'),($2,'B')", [id(81),id(82)])
    await db.query('INSERT INTO public.admin_book_access(admin_id,book_id) VALUES($1,$2),($3,$4)', [users[2].admin,id(81),users[3].admin,id(82)])
    await db.query("INSERT INTO public.transactions(id,cashier_id,invoice_no,book_id) VALUES($1,$2,'UI-A',$5),($3,$4,'UI-B',$6)", [id(41),users[2].admin,id(42),users[3].admin,id(81),id(82)])
  } else await db.query('INSERT INTO public.transactions VALUES($1,$2),($3,$4)', [id(41),users[2].admin,id(42),users[3].admin])
  await db.query("INSERT INTO storage.objects(bucket_id,name) VALUES('products','sample.png'),('logos','brand.png'),('invoices',$1),('invoices',$2),('invoices','legacy.png')", [`${id(41)}/sample.png`,`${id(42)}/sample.png`])
  if (full) for (const file of ['006_business_access.sql','007_account_lifecycle.sql']) await db.exec(await readFile(new URL(`../../supabase/security-stage2/${file}`, import.meta.url), 'utf8'))
  if (sql) await db.exec(sql)
  return db
}
async function as(db, user, query, params=[]) {
  return db.transaction(async tx => {
    await tx.exec(`SET LOCAL ROLE ${user ? 'authenticated' : 'anon'}`)
    await tx.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify(user ? {sub:user.auth,session_id:user.session}: {})])
    return tx.query(query,params)
  })
}
test('anon loses every object mutation and invoice bucket becomes private', async t => {
  const db = await setup(t)
  assert.equal((await db.query("SELECT public FROM storage.buckets WHERE id='invoices'")).rows[0].public, false)
  for (const query of ["SELECT * FROM storage.objects", "INSERT INTO storage.objects(bucket_id,name) VALUES('products','attack.png')", "UPDATE storage.objects SET name='attack.png'", 'DELETE FROM storage.objects']) await assert.rejects(as(db,null,query))
})
test('valid staff reads shared images but only own transaction invoice objects', async t => {
  const db = await setup(t)
  const result = await as(db,users[2],'SELECT bucket_id,name FROM storage.objects ORDER BY bucket_id,name')
  assert.equal(result.rows.length,3)
  assert.equal(result.rows.filter(x=>x.bucket_id==='invoices')[0].name,`${id(41)}/sample.png`)
  for (const user of users.slice(0,2)) assert.equal((await as(db,user,'SELECT * FROM storage.objects')).rows.length,5)
})
test('staff can upload product images and own invoice but cannot change logos or foreign invoices', async t => {
  const db = await setup(t)
  await as(db,users[2],"INSERT INTO storage.objects(bucket_id,name) VALUES('products','new.png'),('invoices',$1)",[`${id(41)}/new.png`])
  for (const [bucket,name] of [['logos','new.png'],['invoices',`${id(42)}/new.png`],['invoices','../escape.png'],['invoices','bad/new.png']]) await assert.rejects(as(db,users[2],'INSERT INTO storage.objects(bucket_id,name) VALUES($1,$2)',[bucket,name]))
  await assert.rejects(as(db,users[2],"UPDATE storage.objects SET name=$1 WHERE bucket_id='invoices'",[`${id(42)}/stolen.png`]))
  assert.equal((await as(db,users[2],"DELETE FROM storage.objects WHERE bucket_id='logos' RETURNING *")).rows.length,0)
  await as(db,users[0],"INSERT INTO storage.objects(bucket_id,name) VALUES('logos','owner.png')")
  await assert.rejects(as(db,users[1],"INSERT INTO storage.objects(bucket_id,name) VALUES('logos','admin.png')"))
})
test('inactive, missing, reset-pending and revoked sessions lose all Storage access', async t => {
  const db = await setup(t)
  for (const user of [users[4],{...users[2],session:id(99)}]) assert.equal((await as(db,user,'SELECT * FROM storage.objects')).rows.length,0)
  await db.query('UPDATE pos_security.user_access SET reset_operation=$1 WHERE auth_user_id=$2',[id(90),users[2].auth])
  assert.equal((await as(db,users[2],'SELECT * FROM storage.objects')).rows.length,0)
  await assert.rejects(as(db,users[2],"INSERT INTO storage.objects(bucket_id,name) VALUES('products','blocked.png')"))
})
test('combined 001-008 schema enforces book-scoped invoice reads and account session revocation', async t => {
  const db = await setup(t, true)
  assert.equal((await as(db, users[2], 'SELECT * FROM storage.objects')).rows.length, 3)
  await db.query('DELETE FROM public.admin_book_access WHERE admin_id=$1', [users[2].admin])
  assert.equal((await as(db, users[2], "SELECT * FROM storage.objects WHERE bucket_id='invoices'")).rows.length, 0)
  await db.transaction(async tx => {
    await tx.exec('SET LOCAL ROLE service_role')
    await tx.query('SELECT public.pos_account_update($1,$2,$3,$4,$5,$6,$7)', [users[0].auth,users[0].session,id(95),users[2].admin,1,{role:'admin'},'a'.repeat(64)])
  })
  assert.equal((await as(db, users[2], 'SELECT * FROM storage.objects')).rows.length, 0)
  assert.equal((await as(db, users[0], 'SELECT * FROM storage.objects')).rows.length, 5)
})
