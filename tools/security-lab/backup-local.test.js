import test from 'node:test'
import assert from 'node:assert/strict'
import { createLocalDocker } from './localDocker.js'
import { randomBytes } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createBackupBundle, verifyBackupBundle, restoreStorageFiles, assertRestoreDatabase } from '../backup/bundle.js'

test('real local pg_dump/pg_restore and Storage-file round trip never targets production', {
  skip: process.env.SKUPY_RUN_LOCAL_BACKUP_TESTS !== '1', timeout: 60000,
}, async t => {
  const docker = createLocalDocker()
  const containerId = docker.inspect('supabase_db_skupy-auth-local')
  const id = randomBytes(8).toString('hex')
  const source = `skupy_backup_${id}`
  const destination = assertRestoreDatabase(`postgresql://postgres@127.0.0.1:54322/skupy_restore_${id}`)
  const created = []
  const root = await mkdtemp(join(tmpdir(), 'skupy-backup-roundtrip-'))
  const sql = (db, input) => docker.exec(containerId, ['psql', '-U', 'postgres', '-d', db, '-v', 'ON_ERROR_STOP=1', '-At'], { input, encoding: 'utf8', timeout: 10000 }).trim()
  try {
    for (const name of [source, destination]) {
      docker.exec(containerId, ['createdb', '-U', 'postgres', '-T', 'template0', name], { timeout: 10000 })
      created.push(name)
    }
    sql(source, "CREATE TABLE public.orders(id integer PRIMARY KEY, total numeric NOT NULL, paid numeric NOT NULL); INSERT INTO public.orders VALUES (1,100000,25000),(2,35000,35000);")
    const dump = docker.exec(containerId, ['pg_dump', '-U', 'postgres', '-Fc', '--no-owner', '--no-privileges', source], { timeout: 10000, maxBuffer: 16 * 1024 * 1024 })
    assert.equal(dump.subarray(0, 5).toString(), 'PGDMP')
    const database = join(root, 'source.dump')
    await writeFile(database, dump, { mode: 0o600 })
    const storage = join(root, 'files')
    await mkdir(join(storage, 'products'), { recursive: true, mode: 0o700 })
    const original = Buffer.from('synthetic-only-product-file')
    await writeFile(join(storage, 'products', 'sample.png'), original, { mode: 0o600 })
    const output = join(root, 'bundle')
    await createBackupBundle({ database, storage, output, projectRef: 'local-synthetic', inventory: [{ bucket: 'products', name: 'sample.png', size: original.length }] })
    await verifyBackupBundle(output)
    assert.equal(sql(destination, "SELECT count(*) FROM pg_tables WHERE schemaname='public'"), '0')
    docker.exec(containerId, ['pg_restore', '-U', 'postgres', '-d', destination, '--no-owner', '--no-privileges', '--exit-on-error'], {
      input: await readFile(join(output, 'database.dump')), timeout: 15000,
    })
    assert.equal(sql(destination, 'SELECT count(*),sum(total),sum(paid) FROM public.orders'), '2|135000|60000')
    const restored = join(root, 'restored-files')
    await restoreStorageFiles(output, restored)
    assert.deepEqual(await readFile(join(restored, 'products', 'sample.png')), original)
    t.diagnostic('Synthetic PostgreSQL dump restored into a new empty database; Storage bytes matched. No production snapshot or Storage service used.')
  } finally {
    if (created.length) docker.inspect(containerId)
    for (const name of created.reverse()) docker.exec(containerId, ['dropdb', '-U', 'postgres', name], { timeout: 10000 })
    await rm(root, { recursive: true, force: true })
  }
})
