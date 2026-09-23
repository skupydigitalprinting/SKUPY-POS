import { createReadStream } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const day = 24 * 60 * 60 * 1000
const releaseFields = ['sourceRevision', 'sourceSha256', 'buildSha256', 'productionEnvironment', 'testEnvironment', 'deploymentProject']
const commonFields = ['sourceRevision', 'sourceSha256', 'buildSha256', 'environment', 'completedAt', 'reportSha256', 'result']
const snapshotFields = ['manifestSha256', 'databaseSha256', 'storageInventorySha256', 'databaseBytes', 'storageObjects', 'storageBytes', 'buckets']
const coverage = {
  fullTests: ['unit', 'sql', 'real-local-auth'],
  businessAuthStorage: ['full-schema', 'anon-denial', 'unmapped-denial', 'inactive-denial', 'reset-denial', 'role-forgery', 'cross-staff', 'cross-book', 'credential-isolation', 'owner-only-config', 'rpc', 'triggers', 'storage'],
  workflows: ['login', 'staff-switch', 'session-cleanup', 'custom-order', 'dp', 'settlement', 'cancellation', 'invoice', 'owner-accounting', 'admin-accounting', 'storage', 'desktop', 'mobile'],
  restore: ['empty-target', 'database', 'storage', 'checksums', 'row-counts', 'object-counts', 'application-readback'],
  ownerRecovery: ['email-delivery', 'recovery-completed', 'owner-login'],
  deploymentAccess: ['repository-read', 'repository-push', 'deployment-read', 'deployment-create', 'environment-read'],
}
const gateFields = {
  fullTests: ['cases'], businessAuthStorage: ['cases'], workflows: ['cases'],
  backup: [...snapshotFields, 'provenance'],
  restore: [...snapshotFields, 'sourceEnvironment', 'target', 'cases'],
  ownerRecovery: ['ownerAuthUserId', 'email', 'verifiedAt', 'cases'],
  identityMapping: ['mappingSha256', 'approvedBy', 'approvedAt', 'mappings'],
  deploymentAccess: ['mode', 'project', 'cases'],
}
const productionGates = new Set(['backup', 'ownerRecovery', 'identityMapping', 'deploymentAccess'])
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const shape = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) && !/^0+$/.test(value)
const revision = value => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value) && !/^0+$/.test(value)
const identifier = value => typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,99}$/.test(value)
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)
const count = value => Number.isSafeInteger(value) && value >= 0

function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return NaN
  const ms = Date.parse(value)
  return Number.isFinite(ms) && new Date(ms).toISOString() === value ? ms : NaN
}

function validCases(cases, required) {
  if (!Array.isArray(cases) || !cases.length) return false
  const names = new Set()
  for (const item of cases) {
    if (!shape(item, ['name', 'passed', 'failed', 'skipped']) || !identifier(item.name) || names.has(item.name) ||
        !count(item.passed) || item.passed === 0 || item.failed !== 0 || item.skipped !== 0) return false
    names.add(item.name)
  }
  return required.every(name => names.has(name))
}

function validSnapshot(record) {
  return ['manifestSha256', 'databaseSha256', 'storageInventorySha256'].every(key => digest(record[key])) &&
    count(record.databaseBytes) && record.databaseBytes > 0 && count(record.storageObjects) && count(record.storageBytes) &&
    (record.storageObjects !== 0 || record.storageBytes === 0) &&
    Array.isArray(record.buckets) && record.buckets.length === 3 &&
    ['products', 'logos', 'invoices'].every(bucket => record.buckets.includes(bucket))
}

function validEmail(value) {
  if (typeof value !== 'string' || value.length > 254 || value.trim() !== value ||
      !/^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[A-Za-z0-9.-]+$/.test(value)) return false
  const [local, domain] = value.split('@')
  const labels = domain.split('.')
  return local.length <= 64 && labels.length > 1 && labels.every(label =>
    label.length <= 63 && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label))
}

// Pure validation of JSON data. No hashing of artifacts, I/O, clock reads or release authorization.
export function evaluateReadiness(evidence, expected) {
  const blockers = []
  const block = (gate, reason) => blockers.push(`${gate}: ${reason}`)
  const result = () => ({ evidenceValid: blockers.length === 0, blockers })
  if (!shape(expected, [...releaseFields, 'now']) || !revision(expected.sourceRevision) ||
      !digest(expected.sourceSha256) || !digest(expected.buildSha256) ||
      !['productionEnvironment', 'testEnvironment', 'deploymentProject'].every(key => identifier(expected[key])) ||
      expected.productionEnvironment === expected.testEnvironment || !Number.isFinite(timestamp(expected.now))) {
    block('expected', 'provide exact source revision, source/build SHA-256, distinct environments, deployment project and UTC clock')
    return result()
  }
  const now = timestamp(expected.now)
  const fresh = value => timestamp(value) <= now && timestamp(value) >= now - day
  if (!shape(evidence, ['schemaVersion', 'release', 'checks']) || evidence.schemaVersion !== 1) {
    block('evidence', 'require schemaVersion 1, release and checks only')
    return result()
  }
  if (!shape(evidence.release, releaseFields) || releaseFields.some(key => evidence.release[key] !== expected[key])) {
    block('release', 'source, build, environments and deployment project must exactly match independent expectations')
  }
  if (!object(evidence.checks) || Object.keys(evidence.checks).some(key => !Object.hasOwn(gateFields, key))) {
    block('checks', 'require named evidence records; unknown gates or overrides are not accepted')
  }
  const checks = object(evidence.checks) ? evidence.checks : {}
  for (const [gate, fields] of Object.entries(gateFields)) {
    const record = checks[gate]
    if (!shape(record, [...commonFields, ...fields])) {
      block(gate, 'missing evidence or invalid fields; require the complete record, not an approval boolean')
      continue
    }
    if (['sourceRevision', 'sourceSha256', 'buildSha256'].some(key => record[key] !== expected[key]) ||
        record.environment !== expected[productionGates.has(gate) ? 'productionEnvironment' : 'testEnvironment']) {
      block(gate, 'source/build or environment mismatch')
    }
    if (!fresh(record.completedAt)) block(gate, 'completedAt must be a valid UTC timestamp within the past 24 hours, never future')
    if (record.result !== 'passed' || !digest(record.reportSha256)) block(gate, 'require passed result and report SHA-256')
    if (coverage[gate] && !validCases(record.cases, coverage[gate])) {
      block(gate, 'all required cases need positive executed counts, zero failures/skips and unique names')
    }
    if (gate === 'backup' || gate === 'restore') {
      if (!validSnapshot(record)) block(gate, 'require database and complete Storage digests, counts and all three buckets')
    }
    if (gate === 'backup' && record.provenance !== 'production-snapshot') {
      block(gate, 'require production-snapshot provenance; synthetic or supplied-artifact-only evidence is insufficient')
    }
    if (gate === 'restore') {
      if (record.sourceEnvironment !== expected.productionEnvironment ||
          !shape(record.target, ['host', 'database']) || record.target.host !== '127.0.0.1' ||
          typeof record.target.database !== 'string' || !/^skupy_restore_[a-f0-9]{8,32}$/.test(record.target.database)) {
        block(gate, 'require the expected production source and named loopback restore lab')
      }
      if (!object(checks.backup) || snapshotFields.filter(key => key !== 'buckets').some(key => record[key] !== checks.backup[key]) ||
          !(timestamp(record.completedAt) >= timestamp(checks.backup.completedAt))) {
        block(gate, 'restore must follow and match the exact backup manifest, database and Storage inventory/counts')
      }
    }
    if (gate === 'identityMapping') {
      const mappings = record.mappings
      const valid = Array.isArray(mappings) && mappings.length > 0 && mappings.every(mapping =>
        shape(mapping, ['authUserId', 'adminId', 'role']) && uuid(mapping.authUserId) && uuid(mapping.adminId) &&
        ['owner', 'admin', 'staff'].includes(mapping.role))
      if (!valid || new Set(mappings.map(m => m.authUserId)).size !== mappings.length ||
          new Set(mappings.map(m => m.adminId)).size !== mappings.length ||
          !mappings.some(m => m.authUserId === record.approvedBy && m.role === 'owner') ||
          !digest(record.mappingSha256) || !fresh(record.approvedAt) ||
          !(timestamp(record.approvedAt) <= timestamp(record.completedAt))) {
        block(gate, 'require unique UUID mappings, valid roles, mapping SHA-256 and fresh mapped-owner approval')
      }
    }
    if (gate === 'ownerRecovery') {
      if (!validEmail(record.email) || !uuid(record.ownerAuthUserId) || !fresh(record.verifiedAt) ||
          !(timestamp(record.verifiedAt) <= timestamp(record.completedAt)) ||
          !Array.isArray(checks.identityMapping?.mappings) ||
          !checks.identityMapping.mappings.some(m => object(m) && m.authUserId === record.ownerAuthUserId && m.role === 'owner') ||
          checks.identityMapping.approvedBy !== record.ownerAuthUserId) {
        block(gate, 'require owner email, fresh completed recovery and the same owner as the approved identity mapping')
      }
    }
    if (gate === 'deploymentAccess' && (record.mode !== 'read-only' || record.project !== expected.deploymentProject)) {
      block(gate, 'require read-only access evidence for the exact deployment project')
    }
  }
  return result()
}

async function main(args) {
  const flags = {
    '--evidence': 'evidence', '--source-revision': 'sourceRevision', '--source-sha256': 'sourceSha256',
    '--build-sha256': 'buildSha256', '--production-environment': 'productionEnvironment',
    '--test-environment': 'testEnvironment', '--deployment-project': 'deploymentProject',
  }
  let result
  try {
    const options = {}
    for (let i = 0; i < args.length; i += 2) {
      const name = flags[args[i]]
      if (!Object.hasOwn(flags, args[i]) || Object.hasOwn(options, name) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error()
      options[name] = args[i + 1]
    }
    if (Object.keys(options).length !== Object.keys(flags).length) throw new Error()
    const { evidence: path, ...expected } = options
    const input = path === '-' ? process.stdin : createReadStream(path)
    const chunks = []
    let bytes = 0
    for await (const chunk of input) {
      bytes += chunk.length
      if (bytes > 1024 * 1024) throw new Error()
      chunks.push(chunk)
    }
    const evidence = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    result = evaluateReadiness(evidence, { ...expected, now: new Date().toISOString() })
  } catch {
    // Never echo input, paths or parser errors: private evidence may contain personal data.
    result = { evidenceValid: false, blockers: ['input: require all documented flags and readable valid JSON of at most 1 MiB; no overrides or duplicate flags'] }
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  process.exitCode = result.evidenceValid ? 0 : 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main(process.argv.slice(2))
}
