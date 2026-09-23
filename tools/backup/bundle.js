import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, readdir, mkdir, open, readFile, writeFile, rm, realpath } from 'node:fs/promises'
import { join, resolve, relative, dirname, basename, isAbsolute, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'

const buckets = new Set(['products', 'logos', 'invoices'])
function safePath(path) {
  if (typeof path !== 'string' || !path || path.length > 2048 || path.includes('\\') || path.includes('\0') ||
      isAbsolute(path) || path.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('Unsafe backup path')
  return path
}
async function listFiles(root, prefix = '') {
  if (!(await lstat(root)).isDirectory()) throw new Error('Expected a real directory, not a link')
  const files = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const name = safePath(prefix ? `${prefix}/${entry.name}` : entry.name)
    if (entry.isSymbolicLink()) throw new Error('Symlinks are not backup artifacts')
    if (entry.isDirectory()) files.push(...await listFiles(join(root, entry.name), name))
    else if (entry.isFile()) files.push(name)
    else throw new Error('Unsupported backup artifact')
  }
  return files.sort()
}
async function digest(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat()
    if (!before.isFile()) throw new Error('Expected a regular file')
    const hash = createHash('sha256')
    let size = 0
    for await (const part of handle.createReadStream({ autoClose: false })) { hash.update(part); size += part.length }
    const after = await handle.stat()
    if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error('Source changed during backup')
    return { size, sha256: hash.digest('hex') }
  } finally { await handle.close() }
}
async function copyVerified(source, destination, expected) {
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
  const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW)
  let output
  try {
    output = await open(destination, 'wx', 0o600)
    await pipeline(input.createReadStream(), output.createWriteStream())
  } finally { await input.close(); await output?.close() }
  const actual = await digest(destination)
  if (actual.size !== expected.size || actual.sha256 !== expected.sha256) throw new Error('Backup artifact changed')
}
function sameList(a, b) {
  return a.length === b.length && a.every((value, index) => value === b[index])
}
async function outsideSource(output, source, label) {
  const parent = await realpath(dirname(resolve(output)))
  const destination = join(parent, basename(resolve(output)))
  const inside = relative(await realpath(source), destination)
  if (!inside || (inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside))) {
    throw new Error(`Output must be outside ${label}`)
  }
  return destination
}
function privateParent(stat) {
  if (!stat.isDirectory() || typeof process.getuid !== 'function' ||
      stat.uid !== process.getuid() || (stat.mode & 0o022)) {
    throw new Error('Output parent must be owned by the current user and not group/world writable')
  }
}
function sameDirectory(actual, expected) {
  return actual.isDirectory() && actual.dev === expected.dev && actual.ino === expected.ino
}
async function withNewDirectory(path, run) {
  const parent = dirname(path)
  const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  const parentHandle = await open(parent, flags)
  let handle
  try {
    const parentIdentity = await parentHandle.stat()
    privateParent(parentIdentity)
    await mkdir(path, { mode: 0o700 })
    // Keep the inodes alive until completion; detected replacements are left untouched.
    handle = await open(path, flags)
    const identity = await handle.stat()
    const check = async () => {
      const currentParent = await lstat(parent)
      privateParent(currentParent)
      if (!sameDirectory(currentParent, parentIdentity) || !sameDirectory(await lstat(path), identity)) {
        throw new Error('Output directory or parent identity changed')
      }
    }
    try {
      await check()
      const result = await run(check)
      await check()
      return result
    } catch (error) {
      try {
        await check()
        await rm(path, { recursive: true, force: true })
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], `${error.message}; rollback refused or failed: ${cleanupError.message}`)
      }
      throw error
    }
  } finally {
    try { await handle?.close() } finally { await parentHandle.close() }
  }
}
function inventoryPaths(inventory) {
  if (!Array.isArray(inventory)) throw new Error('Storage inventory is required, including for empty buckets')
  const entries = new Map()
  for (const item of inventory) {
    if (!buckets.has(item.bucket) || !Number.isSafeInteger(item.size) || item.size < 0) throw new Error('Invalid Storage inventory')
    const path = `${item.bucket}/${safePath(item.name)}`
    if (entries.has(path)) throw new Error('Duplicate Storage object')
    entries.set(path, item.size)
  }
  return entries
}

// Packages supplied artifacts only; it cannot prove a production snapshot was complete.
export async function createBackupBundle({ database, storage, output, projectRef, inventory }) {
  if (typeof projectRef !== 'string' || !/^[a-z0-9_-]{1,64}$/.test(projectRef)) throw new Error('Invalid project reference')
  const expected = inventoryPaths(inventory)
  const actualPaths = await listFiles(storage)
  if (!sameList(actualPaths, [...expected.keys()].sort())) throw new Error('Storage files do not match inventory')
  const outputResolved = await outsideSource(output, storage, 'Storage source')
  const dbDigest = await digest(database)
  if (!dbDigest.size) throw new Error('Empty database backup')
  const files = [{ kind: 'database', path: 'database.dump', ...dbDigest }]
  for (const path of actualPaths) {
    const hash = await digest(join(storage, path))
    if (hash.size !== expected.get(path)) throw new Error('Storage size differs from inventory')
    files.push({ kind: 'storage', path: `storage/${path}`, ...hash })
  }
  return withNewDirectory(outputResolved, async check => {
    for (const file of files) {
      await check()
      await copyVerified(file.kind === 'database' ? database : join(storage, file.path.slice(8)), join(outputResolved, file.path), file)
    }
    if (!sameList(await listFiles(storage), actualPaths)) throw new Error('Storage inventory changed during backup')
    for (const file of files) {
      const hash = await digest(file.kind === 'database' ? database : join(storage, file.path.slice(8)))
      if (hash.size !== file.size || hash.sha256 !== file.sha256) throw new Error('Source changed before backup completed')
    }
    const manifest = { version: 1, projectRef, createdAt: new Date().toISOString(), scope: 'supplied-database-and-storage-artifacts', files }
    await check()
    await writeFile(join(outputResolved, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx', mode: 0o600 })
    await verifyBackupBundle(outputResolved)
    return manifest
  })
}

export async function verifyBackupBundle(root) {
  const actualPaths = await listFiles(root)
  const manifestPath = join(root, 'manifest.json')
  if ((await lstat(manifestPath)).size > 32 * 1024 * 1024) throw new Error('Manifest too large')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (manifest.version !== 1 || manifest.scope !== 'supplied-database-and-storage-artifacts' ||
      !Array.isArray(manifest.files) || !manifest.files.length) throw new Error('Invalid backup manifest')
  const paths = new Set()
  let databases = 0
  for (const file of manifest.files) {
    safePath(file.path)
    if (paths.has(file.path) || !Number.isSafeInteger(file.size) || file.size < 0 || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('Invalid manifest file')
    paths.add(file.path)
    if (file.kind === 'database' && file.path === 'database.dump' && file.size > 0) databases++
    else if (file.kind !== 'storage' || !file.path.startsWith('storage/') ||
      !buckets.has(file.path.split('/')[1]) || file.path.split('/').length < 3) throw new Error('Invalid artifact type')
    const actual = await digest(join(root, file.path))
    if (actual.size !== file.size || actual.sha256 !== file.sha256) throw new Error('Backup checksum mismatch')
  }
  if (databases !== 1 || !sameList(actualPaths, [...paths, 'manifest.json'].sort())) throw new Error('Incomplete or unexpected backup files')
  return manifest
}

export async function restoreStorageFiles(bundle, destination) {
  const output = await outsideSource(destination, bundle, 'backup bundle')
  const manifest = await verifyBackupBundle(bundle)
  return withNewDirectory(output, async check => {
    for (const file of manifest.files.filter(f => f.kind === 'storage')) {
      await check()
      await copyVerified(join(bundle, file.path), join(output, file.path.slice(8)), file)
    }
    return { files: manifest.files.filter(f => f.kind === 'storage').length }
  })
}

export function assertRestoreDatabase(value) {
  const url = new URL(value)
  const name = url.pathname.slice(1)
  if (!['postgresql:', 'postgres:'].includes(url.protocol) || url.hostname !== '127.0.0.1' ||
      url.port !== '54322' || url.search || url.hash || url.username !== 'postgres' ||
      !/^skupy_restore_[a-f0-9]{8,32}$/.test(name)) throw new Error('Restore is restricted to a named loopback test database')
  return name
}
