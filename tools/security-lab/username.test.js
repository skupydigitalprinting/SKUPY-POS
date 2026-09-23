import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'

const sql1 = await readFile(new URL('../../supabase/security-stage2/001_identity_bridge.sql', import.meta.url), 'utf8')
const sql2 = await readFile(new URL('../../supabase/security-stage2/002_username_login.sql', import.meta.url), 'utf8')
const authId = '10000000-0000-4000-8000-000000000001'
const adminId = '20000000-0000-4000-8000-000000000001'
const keys = ['global', `ip:${'a'.repeat(64)}`, `user:${'b'.repeat(64)}`]
async function setup() {
  const db = new PGlite()
  try {
    await db.exec(`
      CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
      ALTER DEFAULT PRIVILEGES GRANT ALL ON TABLES TO PUBLIC, anon, authenticated;
      ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO PUBLIC, anon, authenticated;
      CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT null::uuid $$;
      CREATE TABLE public.admins(id uuid PRIMARY KEY, username text, name text, role text);
      INSERT INTO auth.users VALUES ('${authId}');
      INSERT INTO public.admins VALUES ('${adminId}', 'editable-legacy-name', 'Kasir Uji', 'owner');
    `)
    await db.exec(sql1); await db.exec(sql2)
    await db.exec(`INSERT INTO pos_security.user_access(auth_user_id, admin_id, role, active, login_username)
      VALUES ('${authId}', '${adminId}', 'staff', true, 'kasir')`)
    return db
  } catch (e) { await db.close(); throw e }
}
async function asRole(db, role, sql, params = []) {
  await db.exec(`BEGIN; SET LOCAL ROLE ${role};`)
  try { const result = await db.query(sql, params); await db.exec('COMMIT'); return result }
  catch (e) { await db.exec('ROLLBACK'); throw e }
}
const consume = (db, keyList = keys) => asRole(db, 'service_role', 'SELECT public.pos_consume_login_attempt($1) AS allowed', [keyList])

test('username resolution is service-only and does not trust legacy usernames', async () => {
  const db = await setup()
  try {
    for (const role of ['anon', 'authenticated']) {
      await assert.rejects(asRole(db, role, "SELECT * FROM public.pos_resolve_login('kasir')"), /permission denied/)
      await assert.rejects(asRole(db, role, 'SELECT public.pos_consume_login_attempt($1)', [keys]), /permission denied/)
      await assert.rejects(asRole(db, role, 'SELECT * FROM pos_security.login_buckets'), /permission denied/)
    }
    assert.deepEqual((await asRole(db, 'service_role', "SELECT * FROM public.pos_resolve_login('kasir')")).rows, [{ auth_user_id: authId }])
    assert.deepEqual((await asRole(db, 'service_role', "SELECT * FROM public.pos_resolve_login('editable-legacy-name')")).rows, [])
    await db.exec('UPDATE pos_security.user_access SET active = false')
    assert.deepEqual((await asRole(db, 'service_role', "SELECT * FROM public.pos_resolve_login('kasir')")).rows, [])
  } finally { await db.close() }
})

test('ten attempts allowed per username then blocked across IPs', async () => {
  const db = await setup()
  try {
    for (let i = 0; i < 10; i++) assert.equal((await consume(db)).rows[0].allowed, true)
    assert.equal((await consume(db)).rows[0].allowed, false)
    assert.equal((await consume(db, ['global', `ip:${'c'.repeat(64)}`, keys[2]])).rows[0].allowed, false)
    await db.exec("UPDATE pos_security.login_buckets SET window_start = now() - interval '16 minutes'")
    assert.equal((await consume(db)).rows[0].allowed, true)
  } finally { await db.close() }
})

test('IP and global limits prevent bypass by rotating usernames', async () => {
  const db = await setup()
  try {
    await consume(db)
    await db.query('UPDATE pos_security.login_buckets SET attempts = 60 WHERE bucket_key = $1', [keys[1]])
    assert.equal((await consume(db, ['global', keys[1], `user:${'c'.repeat(64)}`])).rows[0].allowed, false)
    await db.exec("UPDATE pos_security.login_buckets SET attempts = 1000 WHERE bucket_key = 'global'")
    assert.equal((await consume(db, ['global', `ip:${'d'.repeat(64)}`, `user:${'e'.repeat(64)}`])).rows[0].allowed, false)
  } finally { await db.close() }
})

test('rejects malformed bucket keys and cleans expired rows', async () => {
  const db = await setup()
  try {
    await assert.rejects(consume(db, ['global', 'raw-ip', 'raw-user']), /invalid login buckets/)
    await db.exec("INSERT INTO pos_security.login_buckets VALUES ('old', now() - interval '2 days', 1)")
    await consume(db)
    assert.deepEqual((await db.query("SELECT * FROM pos_security.login_buckets WHERE bucket_key = 'old'")).rows, [])
  } finally { await db.close() }
})

test('one already-blocked IP cannot consume all global admission budget', async () => {
  const db = await setup()
  try {
    for (let i = 0; i < 1001; i++) await consume(db)
    assert.equal((await consume(db, ['global', `ip:${'f'.repeat(64)}`, `user:${'e'.repeat(64)}`])).rows[0].allowed, true)
  } finally { await db.close() }
})
