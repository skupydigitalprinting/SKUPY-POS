import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'

const authId = '10000000-0000-4000-8000-000000000001'
const adminId = '20000000-0000-4000-8000-000000000001'
const stranger = '10000000-0000-4000-8000-000000000002'
const sql = await readFile(new URL('../../supabase/security-stage2/001_identity_bridge.sql', import.meta.url), 'utf8')

async function setup() {
  // Real PostgreSQL permissions; auth.uid is simulated, not a GoTrue/JWT test.
  const db = new PGlite()
  try {
    await db.exec(`
      CREATE ROLE anon NOLOGIN;
      CREATE ROLE authenticated NOLOGIN;
      ALTER DEFAULT PRIVILEGES GRANT ALL ON TABLES TO anon, authenticated;
      ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO anon, authenticated;
      CREATE SCHEMA auth;
      CREATE TABLE auth.users (id uuid PRIMARY KEY);
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
        $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      CREATE TABLE public.admins (
        id uuid PRIMARY KEY, username text NOT NULL, name text, role text, password text
      );
      INSERT INTO auth.users VALUES ('${authId}'), ('${stranger}');
      INSERT INTO public.admins VALUES ('${adminId}', 'kasir-uji', 'Kasir Uji', 'owner', 'dummy-never-return');
    `)
    await db.exec(sql)
    await db.exec(`INSERT INTO pos_security.user_access (auth_user_id, admin_id, role, active)
      VALUES ('${authId}', '${adminId}', 'staff', true)`)
    return db
  } catch (error) { await db.close(); throw error }
}

async function asRole(db, role, userId, query) {
  await db.exec(`BEGIN; SET LOCAL ROLE ${role};`)
  try {
    await db.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [userId || ''])
    return await db.query(query)
  } finally { await db.exec('ROLLBACK') }
}

test('anonymous cannot execute profile RPC or read access mapping', async () => {
  const db = await setup()
  try {
    await assert.rejects(asRole(db, 'anon', null, 'SELECT * FROM public.pos_current_profile()'), /permission denied/)
    await assert.rejects(asRole(db, 'anon', null, 'SELECT * FROM pos_security.user_access'), /permission denied/)
  } finally { await db.close() }
})

test('verified mapping returns legacy ID and trusted role without password', async () => {
  const db = await setup()
  try {
    const { rows } = await asRole(db, 'authenticated', authId, 'SELECT * FROM public.pos_current_profile()')
    assert.deepEqual(rows, [{ id: adminId, username: 'kasir-uji', name: 'Kasir Uji', role: 'staff', auth_user_id: authId }])
  } finally { await db.close() }
})

test('unmapped and missing identity return no profile', async () => {
  const db = await setup()
  try {
    for (const id of [stranger, null]) {
      assert.deepEqual((await asRole(db, 'authenticated', id, 'SELECT * FROM public.pos_current_profile()')).rows, [])
    }
  } finally { await db.close() }
})

test('disabled mapping is denied', async () => {
  const db = await setup()
  try {
    await db.exec('UPDATE pos_security.user_access SET active = false')
    assert.deepEqual((await asRole(db, 'authenticated', authId, 'SELECT * FROM public.pos_current_profile()')).rows, [])
  } finally { await db.close() }
})

test('authenticated users cannot read or promote their access mapping', async () => {
  const db = await setup()
  try {
    for (const query of [
      'SELECT * FROM pos_security.user_access',
      "UPDATE pos_security.user_access SET role = 'owner'",
      'DELETE FROM pos_security.user_access',
      `INSERT INTO pos_security.user_access VALUES ('${stranger}', '${adminId}', 'owner', true)`,
    ]) await assert.rejects(asRole(db, 'authenticated', authId, query), /permission denied/)
  } finally { await db.close() }
})

test('one legacy admin cannot be mapped to two Auth users', async () => {
  const db = await setup()
  try {
    await assert.rejects(db.exec(`INSERT INTO pos_security.user_access (auth_user_id, admin_id, role)
      VALUES ('${stranger}', '${adminId}', 'owner')`), /unique constraint/)
  } finally { await db.close() }
})

test('SQL cannot silently replace an existing mapping table', async () => {
  const db = await setup()
  try {
    await assert.rejects(db.exec(sql), /already exists/)
    await db.exec('ROLLBACK')
    assert.equal((await db.query('SELECT count(*)::int AS n FROM pos_security.user_access')).rows[0].n, 1)
  } finally { await db.close() }
})
