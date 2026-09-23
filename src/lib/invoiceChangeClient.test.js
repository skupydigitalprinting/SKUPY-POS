import test from 'node:test'
import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { createInvoiceChangeClient } from './invoiceChangeClient.js'

const invoiceId = '80000000-0000-4000-8000-000000000001'
const operationId = '80000000-0000-4000-8000-000000000002'
const request = { invoiceId, expectedVersion: 0, kind: 'edit', payload: { reason: 'Synthetic correction', notes: 'Private customer note' } }
const receipt = { operationId, invoiceId, invoiceNo: 'TEST', version: 1, state: 'active', total: 400000, paid: 200000, remaining: 200000, refundDue: 0 }

function setup() {
  const values = new Map(), held = new Set(), calls = []
  let active = true, actorId = 'actor-a'
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }
  const locks = { request: async (key, options, run) => {
    if (held.has(key)) return run(null)
    held.add(key)
    try { return await run({ name: key }) } finally { held.delete(key) }
  } }
  let respond = async name => ({ data: name === 'pos_invoice_change_status' ? { state: 'unknown' } : receipt, error: null })
  const rpc = async (name, payload) => { calls.push({ name, payload }); return respond(name, payload) }
  const make = (scope = 'https://synthetic.supabase.co') => {
    const boundActor = actorId
    return createInvoiceChangeClient({ client: { rpc }, scope, actorId: boundActor, isCurrent: () => active && actorId === boundActor,
      storage, locks, crypto: { subtle: webcrypto.subtle, randomUUID: () => operationId } })
  }
  return { make, values, calls, storage, locks, respond: fn => { respond = fn }, invalidate: () => { active = false }, switchActor: () => { actorId = 'actor-b' } }
}

test('persists operation identity before sending, without customer payload or credentials', async () => {
  const h = setup()
  h.respond(async () => {
    assert.equal(h.values.size, 1)
    assert.ok([...h.values.values()][0].includes(operationId))
    assert.ok(![...h.values.values()][0].includes('Private customer'))
    return { data: receipt, error: null }
  })
  const result = await h.make().change(request)
  assert.equal(result.ok, true)
  assert.deepEqual(result.data, receipt)
  assert.equal(h.values.size, 0)
  assert.equal(h.calls[0].payload.p_operation_id, operationId)
  assert.equal('actor' in h.calls[0].payload, false)
})

test('lost response survives reload and resolves through status without a second mutation', async () => {
  const h = setup()
  h.respond(async () => { throw new Error('Network lost after commit') })
  assert.equal((await h.make().change(request)).needsReconciliation, true)
  h.respond(async () => ({ data: { state: 'complete', result: receipt }, error: null }))
  assert.equal((await h.make().reconcile(invoiceId)).ok, true)
  assert.deepEqual(h.calls.map(c => c.name), ['pos_apply_invoice_change', 'pos_invoice_change_status'])
})

test('unknown operation retries only original fingerprint and ID, despite object key order', async () => {
  const h = setup()
  h.respond(async () => { throw new Error('Offline') })
  await h.make().change(request)
  h.respond(async name => ({ data: name === 'pos_invoice_change_status' ? { state: 'unknown' } : receipt, error: null }))
  const result = await h.make().change({ ...request, payload: { notes: request.payload.notes, reason: request.payload.reason } })
  assert.equal(result.ok, true)
  assert.equal(h.calls.at(-1).payload.p_operation_id, operationId)
})

test('changed request cannot replace an unresolved operation', async () => {
  const h = setup()
  h.respond(async () => { throw new Error('Offline') })
  await h.make().change(request)
  const count = h.calls.length
  assert.equal((await h.make().change({ ...request, kind: 'cancel' })).needsReconciliation, true)
  assert.equal(h.calls.length, count)
  assert.equal(h.values.size, 1)
})

test('account change during request does not expose success or erase pending evidence', async () => {
  const h = setup(), client = h.make()
  h.respond(async () => { h.switchActor(); return { data: receipt, error: null } })
  assert.equal((await client.change(request)).ok, false)
  assert.equal(h.values.size, 1)
  const count = h.calls.length
  assert.equal((await client.change(request)).ok, false)
  assert.equal(h.calls.length, count)
  assert.equal((await h.make().reconcile(invoiceId)).pending, false)
  assert.equal(h.values.size, 1)
})

test('cross-tab lock prevents concurrent duplicate mutation', async () => {
  const h = setup()
  let finish, started
  const start = new Promise(resolve => { started = resolve })
  h.respond(() => { started(); return new Promise(resolve => { finish = resolve }) })
  const first = h.make().change(request)
  await start
  assert.equal((await h.make().change(request)).busy, true)
  assert.equal(h.calls.length, 1)
  finish({ data: receipt, error: null })
  assert.equal((await first).ok, true)
})

test('malformed, foreign or inconsistent receipts stay unresolved', async () => {
  for (const bad of [null, { ...receipt, invoiceId: 'wrong' }, { ...receipt, operationId: 'wrong' },
    { ...receipt, version: 0 }, { ...receipt, paid: -1 }, { ...receipt, remaining: 1 }, { ...receipt, refundDue: 1 }, { ...receipt, state: 'voided' }]) {
    const h = setup()
    h.respond(async () => ({ data: bad, error: null }))
    assert.equal((await h.make().change(request)).needsReconciliation, true)
    assert.equal(h.values.size, 1)
  }
})

test('storage failure or unavailable cross-tab locks prevents sending', async () => {
  const h = setup()
  h.storage.setItem = () => { throw new Error('Quota exceeded') }
  assert.equal((await h.make().change(request)).ok, false)
  assert.equal(h.calls.length, 0)
  const client = createInvoiceChangeClient({ client: { rpc: () => { throw new Error('must not call') } }, actorId: 'a', isCurrent: () => true,
    storage: h.storage, locks: null, crypto: webcrypto })
  assert.equal((await client.change(request)).ok, false)
})

test('known rollback on first submission clears intent, ambiguous errors do not', async () => {
  for (const [code, retained] of [['40001', false], ['23514', false], ['42501', false], ['22007', false], ['22008', false], ['PGRST202', true], ['503', true]]) {
    const h = setup()
    h.respond(async () => ({ data: null, error: { code } }))
    assert.equal((await h.make().change(request)).ok, false)
    assert.equal(h.values.size > 0, retained)
  }
})

test('server-confirmed stale retry clears pending intent only with matching operation evidence', async () => {
  for (const details of [operationId, 'wrong-operation']) {
    const h = setup()
    h.respond(async () => { throw new Error('Lost before server') })
    await h.make().change(request)
    h.respond(async name => name === 'pos_invoice_change_status' ? { data: { state: 'unknown' }, error: null }
      : { error: { code: '40001', hint: 'invoice_revision_conflict', details } })
    const result = await h.make().change(request)
    assert.equal(result.ok, false)
    assert.equal(h.values.size, details === operationId ? 0 : 1)
    if (details === operationId) assert.equal(result.needsRefresh, true)
  }
})

test('a denied replay keeps intent because earlier request might already have committed', async () => {
  const h = setup()
  h.respond(async () => { throw new Error('lost') })
  await h.make().change(request)
  h.respond(async name => name === 'pos_invoice_change_status'
    ? { data: { state: 'unknown' }, error: null } : { error: { code: '42501' } })
  assert.equal((await h.make().change(request)).needsReconciliation, true)
  assert.equal(h.values.size, 1)
})

test('invalid request and corrupted local intent fail closed before any network call', async () => {
  const h = setup()
  for (const bad of [{ ...request, invoiceId: '' }, { ...request, expectedVersion: NaN }, { ...request, kind: 'physical-delete' },
    { ...request, payload: { x: undefined } }, { ...request, payload: { x: Infinity } }]) {
    assert.equal((await h.make().change(bad)).ok, false)
  }
  assert.equal(h.calls.length, 0)
  h.respond(async () => { throw new Error('offline') })
  await h.make().change(request)
  for (const key of h.values.keys()) h.values.set(key, '{}')
  const count = h.calls.length
  assert.equal((await h.make().change(request)).ok, false)
  assert.equal(h.calls.length, count)
})

test('isolated preview and production never share pending operations for cloned identifiers', async () => {
  const h = setup()
  h.respond(async () => { throw new Error('Offline') })
  await h.make('https://production.supabase.co').change(request)
  const count = h.calls.length
  const result = await h.make('https://preview.supabase.co').reconcile(invoiceId)
  assert.equal(result.pending, false)
  assert.equal(h.calls.length, count)
  assert.equal(h.values.size, 1)
})
