import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { evaluateReadiness } from './readiness.js'

const hash = value => createHash('sha256').update(value).digest('hex')
const owner = '10000000-0000-4000-8000-000000000001'
const staff = '10000000-0000-4000-8000-000000000002'
const admin = '20000000-0000-4000-8000-000000000001'
const now = '2026-09-11T12:00:00.000Z'
const completedAt = '2026-09-11T11:00:00.000Z'
const gates = ['fullTests', 'businessAuthStorage', 'workflows', 'backup', 'restore', 'ownerRecovery', 'identityMapping', 'deploymentAccess']
const coverage = {
  fullTests: ['unit', 'sql', 'real-local-auth'],
  businessAuthStorage: ['full-schema', 'anon-denial', 'unmapped-denial', 'inactive-denial', 'reset-denial', 'role-forgery', 'cross-staff', 'cross-book', 'credential-isolation', 'owner-only-config', 'rpc', 'triggers', 'storage'],
  workflows: ['login', 'staff-switch', 'session-cleanup', 'custom-order', 'dp', 'settlement', 'cancellation', 'invoice', 'owner-accounting', 'admin-accounting', 'storage', 'desktop', 'mobile'],
}

// Entirely synthetic validator inputs. These are not real release evidence.
function fixture() {
  const expected = {
    sourceRevision: '1234567890abcdef1234567890abcdef12345678',
    sourceSha256: hash('synthetic source including dirty changes'),
    buildSha256: hash('synthetic build'),
    productionEnvironment: 'synthetic-production', testEnvironment: 'synthetic-lab',
    deploymentProject: 'synthetic-project', now,
  }
  const { now: ignored, ...release } = expected
  const checks = Object.fromEntries(gates.map(gate => [gate, {
    sourceRevision: release.sourceRevision, sourceSha256: release.sourceSha256,
    buildSha256: release.buildSha256,
    environment: ['backup', 'ownerRecovery', 'identityMapping', 'deploymentAccess'].includes(gate)
      ? release.productionEnvironment : release.testEnvironment,
    completedAt, reportSha256: hash(`synthetic report ${gate}`), result: 'passed',
  }]))
  for (const gate of Object.keys(coverage)) Object.assign(checks[gate], {
    cases: coverage[gate].map(name => ({ name, passed: 1, failed: 0, skipped: 0 })),
  })
  const snapshot = {
    manifestSha256: hash('synthetic manifest'), databaseSha256: hash('synthetic dump'),
    storageInventorySha256: hash('synthetic object inventory'), databaseBytes: 512,
    storageObjects: 3, storageBytes: 128, buckets: ['products', 'logos', 'invoices'],
  }
  Object.assign(checks.backup, snapshot, { provenance: 'production-snapshot' })
  Object.assign(checks.restore, snapshot, {
    sourceEnvironment: release.productionEnvironment,
    completedAt: '2026-09-11T11:30:00.000Z',
    target: { host: '127.0.0.1', database: 'skupy_restore_12345678' },
    cases: ['empty-target', 'database', 'storage', 'checksums', 'row-counts', 'object-counts', 'application-readback']
      .map(name => ({ name, passed: 1, failed: 0, skipped: 0 })),
  })
  Object.assign(checks.identityMapping, {
    mappingSha256: hash('synthetic approved mapping'), approvedBy: owner,
    approvedAt: '2026-09-11T10:30:00.000Z',
    mappings: [{ authUserId: owner, adminId: admin, role: 'owner' },
      { authUserId: staff, adminId: '20000000-0000-4000-8000-000000000002', role: 'staff' }],
  })
  Object.assign(checks.ownerRecovery, {
    ownerAuthUserId: owner, email: 'owner@example.test',
    verifiedAt: '2026-09-11T10:45:00.000Z',
    cases: ['email-delivery', 'recovery-completed', 'owner-login']
      .map(name => ({ name, passed: 1, failed: 0, skipped: 0 })),
  })
  Object.assign(checks.deploymentAccess, {
    mode: 'read-only', project: release.deploymentProject,
    cases: ['repository-read', 'repository-push', 'deployment-read', 'deployment-create', 'environment-read']
      .map(name => ({ name, passed: 1, failed: 0, skipped: 0 })),
  })
  return { expected, evidence: { schemaVersion: 1, release, checks } }
}

function denied(change, blocker) {
  const { expected, evidence } = fixture()
  change(evidence, expected)
  const result = evaluateReadiness(evidence, expected)
  assert.equal(result.evidenceValid, false)
  assert.ok(result.blockers.some(value => value.startsWith(blocker)), JSON.stringify(result))
}

test('complete synthetic records validate consistently without asserting production readiness', () => {
  const { evidence, expected } = fixture()
  const before = JSON.stringify({ evidence, expected })
  assert.deepEqual(evaluateReadiness(evidence, expected), { evidenceValid: true, blockers: [] })
  assert.equal(JSON.stringify({ evidence, expected }), before)
})

for (const value of [undefined, null, true, [], {}, 'passed']) {
  test(`malformed evidence fails closed: ${JSON.stringify(value)}`, () => {
    assert.equal(evaluateReadiness(value, fixture().expected).evidenceValid, false)
  })
}

for (const gate of gates) {
  test(`${gate}: absence, boolean, failed result and missing report cannot pass`, () => {
    denied(e => { delete e.checks[gate] }, gate)
    denied(e => { e.checks[gate] = true }, gate)
    denied(e => { e.checks[gate].result = 'failed' }, gate)
    denied(e => { delete e.checks[gate].reportSha256 }, gate)
  })
  test(`${gate}: every record must match the exact source, build and environment`, () => {
    for (const field of ['sourceRevision', 'sourceSha256', 'buildSha256', 'environment']) {
      denied(e => { e.checks[gate][field] = field === 'sourceRevision' ? 'f'.repeat(40) : hash('other') }, gate)
    }
  })
  test(`${gate}: missing, impossible, stale and future timestamps are denied`, () => {
    for (const timestamp of [null, '2026-09-11', '2026-02-30T11:00:00.000Z',
      '2026-09-10T11:59:59.999Z', '2026-09-11T12:00:00.001Z']) {
      denied(e => { e.checks[gate].completedAt = timestamp }, gate)
    }
  })
}

test('schema versions, unknown fields and manual override flags fail closed', () => {
  denied(e => { e.schemaVersion = 2 }, 'evidence')
  denied(e => { e.productionReady = true }, 'evidence')
  denied(e => { e.checks.override = true }, 'checks')
  denied(e => { e.checks.backup.verified = true }, 'backup')
})

test('independent expected context is mandatory, not inferred from supplied records', () => {
  for (const field of Object.keys(fixture().expected)) {
    denied((e, expected) => { delete expected[field] }, 'expected')
  }
  denied((e, expected) => { expected.testEnvironment = expected.productionEnvironment }, 'expected')
  denied((e, expected) => { expected.now = 'yesterday' }, 'expected')
  denied(e => { e.release.buildSha256 = hash('different release') }, 'release')
})

test('abbreviated, malformed and all-zero hashes are rejected', () => {
  for (const value of ['abc123', '0'.repeat(64), 'G'.repeat(64), true]) {
    denied((e, expected) => { expected.buildSha256 = value; e.release.buildSha256 = value }, 'expected')
  }
  denied((e, expected) => { expected.sourceRevision = '1234567'; e.release.sourceRevision = '1234567' }, 'expected')
  denied(e => { e.checks.backup.manifestSha256 = '0'.repeat(64) }, 'backup')
})

test('trailing newlines cannot disguise invalid hashes, IDs or environment names', () => {
  for (const field of ['sourceRevision', 'sourceSha256', 'buildSha256', 'productionEnvironment', 'testEnvironment', 'deploymentProject']) {
    denied((e, expected) => {
      expected[field] += '\n'
      e.release[field] = expected[field]
      for (const record of Object.values(e.checks)) {
        if (Object.hasOwn(record, field)) record[field] = expected[field]
      }
    }, 'expected')
  }
  denied(e => { e.checks.backup.manifestSha256 += '\n' }, 'backup')
  denied(e => { e.checks.identityMapping.mappings[1].adminId += '\n' }, 'identityMapping')
  denied(e => { e.checks.restore.target.database += '\n' }, 'restore')
})

test('malformed nested records yield blockers without throwing', () => {
  for (const value of [null, false, 0, '', [], {}]) {
    for (const gate of gates) denied(e => { e.checks[gate] = value }, gate)
    denied(e => { e.checks.identityMapping.mappings = [value] }, 'identityMapping')
    denied(e => { e.checks.fullTests.cases = [value] }, 'fullTests')
  }
})

test('freshness includes the exact 24-hour boundary without renewing older approvals', () => {
  const { evidence, expected } = fixture()
  evidence.checks.fullTests.completedAt = '2026-09-10T12:00:00.000Z'
  assert.equal(evaluateReadiness(evidence, expected).evidenceValid, true)
  denied(e => { e.checks.identityMapping.approvedAt = '2026-09-10T11:59:59.999Z' }, 'identityMapping')
  denied(e => { e.checks.ownerRecovery.verifiedAt = '2026-09-10T11:59:59.999Z' }, 'ownerRecovery')
})

for (const gate of ['fullTests', 'businessAuthStorage', 'workflows', 'restore', 'ownerRecovery', 'deploymentAccess']) {
  test(`${gate}: every required case needs executed passing tests and no failures or skips`, () => {
    const names = fixture().evidence.checks[gate].cases.map(c => c.name)
    for (const name of names) denied(e => {
      e.checks[gate].cases = e.checks[gate].cases.filter(c => c.name !== name)
    }, gate)
    for (const [key, value] of [['passed', 0], ['passed', true], ['passed', 1.2], ['failed', 1], ['failed', -1], ['skipped', 1]]) {
      denied(e => { e.checks[gate].cases[0][key] = value }, gate)
    }
    denied(e => { e.checks[gate].cases.push(e.checks[gate].cases[0]) }, gate)
    denied(e => { e.checks[gate].cases.push({ name: 'extra-failure', passed: 1, failed: 1, skipped: 0 }) }, gate)
  })
}

test('synthetic or database-only backup evidence cannot satisfy production backup', () => {
  denied(e => { e.checks.backup.provenance = 'synthetic' }, 'backup')
  denied(e => { delete e.checks.backup.storageInventorySha256 }, 'backup')
  denied(e => { e.checks.backup.buckets = ['products'] }, 'backup')
  denied(e => { e.checks.backup.databaseBytes = 0 }, 'backup')
  denied(e => { e.checks.backup.storageObjects = -1 }, 'backup')
  denied(e => { e.checks.backup.storageObjects = 0 }, 'backup')
})

test('empty Storage requires an explicit inventory, all buckets, and zero bytes', () => {
  const { evidence, expected } = fixture()
  for (const gate of ['backup', 'restore']) Object.assign(evidence.checks[gate], { storageObjects: 0, storageBytes: 0 })
  assert.equal(evaluateReadiness(evidence, expected).evidenceValid, true)
})

test('restore must match every backup digest and inventory counter', () => {
  for (const field of ['manifestSha256', 'databaseSha256', 'storageInventorySha256']) {
    denied(e => { e.checks.restore[field] = hash('different backup') }, 'restore')
  }
  for (const field of ['databaseBytes', 'storageObjects', 'storageBytes']) {
    denied(e => { e.checks.restore[field] += 1 }, 'restore')
  }
  denied(e => { e.checks.restore.sourceEnvironment = 'another-production' }, 'restore')
  denied(e => { e.checks.restore.completedAt = '2026-09-11T10:00:00.000Z' }, 'restore')
})

test('restore evidence must name an isolated loopback target', () => {
  denied(e => { e.checks.restore.target.host = 'database.example.test' }, 'restore')
  denied(e => { e.checks.restore.target.database = 'postgres' }, 'restore')
  denied(e => { e.checks.restore.target.database = 'skupy_restore_12345678/other' }, 'restore')
})

test('missing owner email, recovery proof or mapped owner remains blocked', () => {
  for (const email of [undefined, '', 'owner', 'owner@', 'owner@example.test\n',
    '.owner@example.test', 'owner.@example.test', 'owner..name@example.test',
    `${'o'.repeat(65)}@example.test`, `owner@${'d'.repeat(64)}.test`]) {
    denied(e => { e.checks.ownerRecovery.email = email }, 'ownerRecovery')
  }
  denied(e => { e.checks.ownerRecovery.ownerAuthUserId = staff }, 'ownerRecovery')
  denied(e => { delete e.checks.ownerRecovery.verifiedAt }, 'ownerRecovery')
  denied(e => { e.checks.ownerRecovery.verifiedAt = '2026-09-11T11:01:00.000Z' }, 'ownerRecovery')
})

test('identity mappings require unique immutable IDs, valid roles and owner approval', () => {
  denied(e => { e.checks.identityMapping.mappings = [] }, 'identityMapping')
  denied(e => { e.checks.identityMapping.mappings[0].role = 'admin' }, 'identityMapping')
  denied(e => { e.checks.identityMapping.mappings[1].authUserId = owner }, 'identityMapping')
  denied(e => { e.checks.identityMapping.mappings[1].adminId = admin }, 'identityMapping')
  denied(e => { e.checks.identityMapping.mappings[1].role = 'superadmin' }, 'identityMapping')
  denied(e => { e.checks.identityMapping.mappings[0].adminId = 'legacy-name' }, 'identityMapping')
  denied(e => { e.checks.identityMapping.approvedBy = staff }, 'identityMapping')
  denied(e => { e.checks.identityMapping.approvedAt = '2026-09-12T10:00:00.000Z' }, 'identityMapping')
})

test('deployment access must be read-only evidence for the expected project', () => {
  denied(e => { e.checks.deploymentAccess.mode = 'deployed' }, 'deploymentAccess')
  denied(e => { e.checks.deploymentAccess.project = 'other-project' }, 'deploymentAccess')
})

const cli = fileURLToPath(new URL('./readiness.js', import.meta.url))
function runCli(input, flags = [], evidencePath = '-') {
  const { expected } = fixture()
  const args = ['--evidence', evidencePath]
  for (const [key, flag] of Object.entries({ sourceRevision: 'source-revision', sourceSha256: 'source-sha256',
    buildSha256: 'build-sha256', productionEnvironment: 'production-environment',
    testEnvironment: 'test-environment', deploymentProject: 'deployment-project' })) args.push(`--${flag}`, expected[key])
  return spawnSync(process.execPath, [cli, ...args, ...flags], { input, encoding: 'utf8', timeout: 5000 })
}

test('CLI returns nonzero blockers for malformed, missing and oversized evidence without echoing secrets', () => {
  for (const input of ['{private-value', '{}', ' '.repeat(1024 * 1024 + 1)]) {
    const result = runCli(input)
    assert.equal(result.status, 1)
    assert.equal(JSON.parse(result.stdout).evidenceValid, false)
    assert.equal(result.stdout.includes('private-value'), false)
  }
  const missing = spawnSync(process.execPath, [cli], { encoding: 'utf8', timeout: 5000 })
  assert.equal(missing.status, 1)
})

test('CLI rejects duplicate, unknown and clock override flags', () => {
  for (const flags of [['--evidence', '-'], ['--force', 'true'], ['--now', now]]) {
    assert.equal(runCli('{}', flags).status, 1)
  }
})

test('CLI reads only the supplied file and blocks unreadable or non-JSON files', () => {
  for (const path of [fileURLToPath(import.meta.url), `${cli}/missing.json`]) {
    const result = runCli('', [], path)
    assert.equal(result.status, 1)
    assert.equal(JSON.parse(result.stdout).evidenceValid, false)
    assert.equal(result.stdout.includes(path), false)
  }
})

test('CLI accepts fresh synthetic evidence on stdin without claiming deployment readiness', () => {
  const { evidence } = fixture()
  const timestamp = new Date(Date.now() - 60_000).toISOString()
  for (const record of Object.values(evidence.checks)) record.completedAt = timestamp
  evidence.checks.ownerRecovery.verifiedAt = timestamp
  evidence.checks.identityMapping.approvedAt = timestamp
  const result = runCli(JSON.stringify(evidence))
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), { evidenceValid: true, blockers: [] })
})
