import { parseArgs } from 'node:util'
import { readFile } from 'node:fs/promises'
import { createBackupBundle, verifyBackupBundle, restoreStorageFiles } from './bundle.js'

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  database: { type: 'string' }, storage: { type: 'string' }, inventory: { type: 'string' },
  output: { type: 'string' }, project: { type: 'string' },
} })
try {
  const [command, bundle] = positionals
  if (command === 'pack' && values.database && values.storage && values.inventory && values.output && values.project) {
    const manifest = await createBackupBundle({ database: values.database, storage: values.storage,
      output: values.output, projectRef: values.project, inventory: JSON.parse(await readFile(values.inventory, 'utf8')) })
    console.log(`Bundle verified: ${manifest.files.length} supplied artifacts. Production completeness is not certified.`)
  } else if (command === 'verify' && bundle) {
    const manifest = await verifyBackupBundle(bundle)
    console.log(`Checksums verified: ${manifest.files.length} artifacts.`)
  } else if (command === 'restore-files' && bundle && values.output) {
    const result = await restoreStorageFiles(bundle, values.output)
    console.log(`Restored and verified ${result.files} Storage files into a new directory.`)
  } else {
    throw new Error('Use pack --database FILE --storage DIR --inventory JSON --output NEW_DIR --project REF; verify BUNDLE; or restore-files BUNDLE --output NEW_DIR')
  }
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
