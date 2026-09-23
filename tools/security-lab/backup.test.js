import test from 'node:test'
import assert from 'node:assert/strict'
import fs, { mkdtemp, mkdir, writeFile, readFile, rm, symlink, rename, lstat, chmod } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createBackupBundle, verifyBackupBundle, restoreStorageFiles, assertRestoreDatabase } from '../backup/bundle.js'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'skupy-backup-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const storage = join(root, 'source')
  await mkdir(join(storage, 'products'), { recursive: true })
  await mkdir(join(storage, 'invoices'), { recursive: true })
  await writeFile(join(storage, 'products', 'kaos.png'), Buffer.from([0, 1, 2, 255]))
  await writeFile(join(storage, 'invoices', 'sample.png'), 'synthetic-invoice')
  const database = join(root, 'source.dump')
  await writeFile(database, 'PGDMP-synthetic-test-not-a-real-dump')
  const output = join(root, 'bundle')
  const options = { database, storage, output, projectRef: 'local-synthetic',
    inventory: [{ bucket: 'products', name: 'kaos.png', size: 4 }, { bucket: 'invoices', name: 'sample.png', size: 17 }] }
  return { root, output, options }
}

test('backup includes database and all listed files and restores exact Storage bytes', async t => {
  const f = await fixture(t)
  const manifest = await createBackupBundle(f.options)
  assert.equal(manifest.files.length, 3)
  assert.equal(manifest.projectRef, 'local-synthetic')
  assert.equal((await verifyBackupBundle(f.output)).files.length, 3)
  const destination = join(f.root, 'restore')
  await restoreStorageFiles(f.output, destination)
  assert.deepEqual(await readFile(join(destination, 'products', 'kaos.png')), Buffer.from([0, 1, 2, 255]))
  assert.equal(await readFile(join(destination, 'invoices', 'sample.png'), 'utf8'), 'synthetic-invoice')
})

test('backup rejects incomplete inventory and missing or extra source files', async t => {
  for (const mutate of [
    f => { f.options.inventory.pop() },
    f => { f.options.inventory.push({ bucket: 'logos', name: 'missing.png', size: 2 }) },
    f => { f.options.inventory[0].size = 99 },
  ]) {
    const f = await fixture(t); mutate(f)
    await assert.rejects(createBackupBundle(f.options))
  }
})

test('backup rejects symlinks, traversal, duplicate names and existing destinations', async t => {
  const f = await fixture(t)
  for (const name of ['../escape', '/absolute', 'a/../b', 'a\\b', 'a//b']) {
    await assert.rejects(createBackupBundle({ ...f.options, inventory: [{ bucket: 'products', name, size: 1 }] }))
  }
  await assert.rejects(createBackupBundle({ ...f.options, inventory: [...f.options.inventory, f.options.inventory[0]] }))
  await symlink(f.options.database, join(f.options.storage, 'products', 'linked'))
  await assert.rejects(createBackupBundle(f.options))
  await rm(join(f.options.storage, 'products', 'linked'))
  await mkdir(f.output)
  await assert.rejects(createBackupBundle(f.options))
})

test('verification rejects missing, changed, unexpected and malicious manifest files before restore', async t => {
  for (const mutate of [
    f => rm(join(f.output, 'database.dump')),
    f => writeFile(join(f.output, 'storage', 'products', 'kaos.png'), 'changed'),
    f => writeFile(join(f.output, 'unexpected'), 'extra'),
    async f => {
      const path = join(f.output, 'manifest.json')
      const m = JSON.parse(await readFile(path, 'utf8'))
      m.files[0].path = '../escape'
      await writeFile(path, JSON.stringify(m))
    },
    async f => {
      const path = join(f.output, 'manifest.json')
      const m = JSON.parse(await readFile(path, 'utf8'))
      m.files.push(m.files[0])
      await writeFile(path, JSON.stringify(m))
    },
  ]) {
    const f = await fixture(t); await createBackupBundle(f.options); await mutate(f)
    await assert.rejects(verifyBackupBundle(f.output))
    await assert.rejects(restoreStorageFiles(f.output, join(f.root, 'restore')))
  }
})

test('restore never overwrites an existing directory or accepts a production database target', async t => {
  const f = await fixture(t); await createBackupBundle(f.options)
  const destination = join(f.root, 'existing')
  await mkdir(destination); await writeFile(join(destination, 'keep'), 'untouched')
  await assert.rejects(restoreStorageFiles(f.output, destination))
  assert.equal(await readFile(join(destination, 'keep'), 'utf8'), 'untouched')
  assert.equal(assertRestoreDatabase('postgresql://postgres@127.0.0.1:54322/skupy_restore_12345678'), 'skupy_restore_12345678')
  for (const url of ['postgresql://postgres@db.ejqfttivgovhqhzkrncx.supabase.co/postgres',
    'postgresql://postgres@127.0.0.1:54322/postgres', 'postgresql://postgres@localhost:54322/skupy_restore_12345678',
    'postgresql://postgres@127.0.0.1:54322/skupy_restore_12345678?host=remote',
    'postgresql://postgres@127.0.0.1:5432/skupy_restore_12345678']) assert.throws(() => assertRestoreDatabase(url))
})

test('restore rejects destinations within the source bundle, including symlink aliases', async t => {
  const f = await fixture(t)
  await createBackupBundle(f.options)
  const alias = join(f.root, 'bundle-alias')
  await symlink(f.output, alias)
  for (const [bundle, destination] of [
    [f.output, join(f.output, 'restored')],
    [f.output, join(alias, 'restored')],
    [alias, join(f.output, '..restored')],
  ]) {
    await assert.rejects(restoreStorageFiles(bundle, destination), /outside.*bundle/i)
    await assert.rejects(lstat(destination), { code: 'ENOENT' })
    assert.equal((await verifyBackupBundle(f.output)).files.length, 3)
  }
})

// Inject a failure after one real file copy, without timing-dependent filesystem polling.
function failSecondCopy(t, beforeFailure = async () => {}) {
  const originalOpen = fs.open
  let writes = 0
  t.mock.method(fs, 'open', async (path, flags, ...args) => {
    if (flags === 'wx' && ++writes === 2) {
      await beforeFailure()
      throw new Error('Injected copy failure')
    }
    return originalOpen(path, flags, ...args)
  })
  syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
}

for (const operation of ['pack', 'restore']) {
  async function prepare(t) {
    const f = await fixture(t)
    if (operation === 'restore') await createBackupBundle(f.options)
    const destination = operation === 'pack' ? f.output : join(f.root, 'restored')
    const run = () => operation === 'pack' ? createBackupBundle(f.options) : restoreStorageFiles(f.output, destination)
    return { ...f, destination, run }
  }

  test(`${operation} rolls back its own partial directory after a copy failure`, async t => {
    const f = await prepare(t)
    failSecondCopy(t)
    await assert.rejects(f.run(), /Injected copy failure/)
    await assert.rejects(lstat(f.destination), { code: 'ENOENT' })
    assert.equal(await readFile(f.options.database, 'utf8'), 'PGDMP-synthetic-test-not-a-real-dump')
  })

  for (const replacement of ['directory', 'symlink']) {
    test(`${operation} rollback preserves a replacement ${replacement} and its contents`, async t => {
      const f = await prepare(t)
      const moved = join(f.root, 'original-partial')
      const unrelated = join(f.root, 'unrelated')
      await mkdir(unrelated)
      await writeFile(join(unrelated, 'keep'), 'untouched')
      failSecondCopy(t, async () => {
        await rename(f.destination, moved)
        if (replacement === 'directory') {
          await mkdir(f.destination)
          await writeFile(join(f.destination, 'keep'), 'replacement')
        } else {
          await symlink(unrelated, f.destination)
        }
      })
      await assert.rejects(f.run(), /Injected copy failure/)
      assert.equal(await readFile(join(f.destination, 'keep'), 'utf8'), replacement === 'directory' ? 'replacement' : 'untouched')
      assert.equal((await lstat(f.destination)).isSymbolicLink(), replacement === 'symlink')
      assert.equal(await readFile(join(unrelated, 'keep'), 'utf8'), 'untouched')
      assert.ok((await lstat(moved)).isDirectory())
    })
  }

  test(`${operation} rejects a group-writable output parent before creating output`, async t => {
    const f = await prepare(t)
    await chmod(f.root, 0o770)
    await assert.rejects(f.run(), /parent.*private|parent.*writable/i)
    await assert.rejects(lstat(f.destination), { code: 'ENOENT' })
  })
}
