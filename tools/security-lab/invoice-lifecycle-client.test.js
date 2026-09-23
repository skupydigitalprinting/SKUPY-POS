import test from 'node:test'
import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { createInvoiceChangeClient } from '../../src/lib/invoiceChangeClient.js'
import { fixture, as, order, draft, actors, change, id } from './invoice-lifecycle-fixture.js'

function clientFor(db, { loseResponse = false, loseBefore = false } = {}) {
  const data = new Map(), held = new Set()
  const storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) }
  const locks = { request: async (key, options, run) => {
    if (held.has(key)) return run(null)
    held.add(key)
    try { return await run({ name: key }) } finally { held.delete(key) }
  } }
  const rpc = async (name, args) => {
    if (loseBefore && name === 'pos_apply_invoice_change') { loseBefore = false; throw new Error('Lost before server') }
    let rows
    try {
      rows = name === 'pos_invoice_change_status'
        ? await as(db, 'cashier', 'SELECT pos_invoice_change_status($1) result', [args.p_operation_id])
        : await as(db, 'cashier', 'SELECT pos_apply_invoice_change($1,$2,$3,$4,$5) result',
          [args.p_operation_id, args.p_invoice_id, args.p_expected_version, args.p_kind, args.p_payload])
    } catch (error) { return { error: { code: error.code, details: error.detail, hint: error.hint }, data: null } }
    if (loseResponse && name === 'pos_apply_invoice_change') { loseResponse = false; throw new Error('Lost committed response') }
    return { data: rows[0].result, error: null }
  }
  return () => createInvoiceChangeClient({ client: { rpc }, actorId: actors.cashier.auth,
    scope: 'isolated-pglite', isCurrent: () => true, storage, locks, crypto: webcrypto })
}

test('client and actual SQL reconcile lost committed edit after reload exactly once', async t => {
  const db = await fixture(t), make = clientFor(db, { loseResponse: true })
  const request = { invoiceId: order, expectedVersion: 0, kind: 'edit', payload: draft() }
  const lost = await make().change(request)
  assert.equal(lost.needsReconciliation, true)
  const result = await make().reconcile(order)
  assert.equal(result.ok, true)
  assert.equal(result.data.total, 400000)
  assert.equal(result.data.paid, 200000)
  assert.equal((await db.query('SELECT count(*)::int n FROM pos_security.invoice_events')).rows[0].n, 1)
})

test('client and actual SQL restate active turnover 10m to 12m to 11.5m to 10m', async t => {
  const db = await fixture(t), client = clientFor(db)()
  const change = (expectedVersion, kind, payload) => client.change({ invoiceId: order, expectedVersion, kind, payload })
  const turnover = async () => 10000000 + Number((await db.query('SELECT coalesce(sum(total),0) total FROM transactions WHERE deleted_at IS NULL')).rows[0].total)
  assert.equal((await change(0, 'edit', draft(2000000))).ok, true)
  assert.equal(await turnover(), 12000000)
  assert.equal((await change(1, 'edit', draft(1500000))).ok, true)
  assert.equal(await turnover(), 11500000)
  const cancelled = await change(2, 'cancel', { reason: 'Customer cancelled, receipt retained' })
  assert.equal(cancelled.ok, true)
  assert.equal(await turnover(), 10000000)
  assert.equal(cancelled.data.refundDue, 200000)
  assert.equal(Number((await db.query("SELECT sum(CASE WHEN direction='in' THEN amount ELSE -amount END) amount FROM cash_movements")).rows[0].amount), 200000)
})

test('client detects stale SQL revision without overwriting the newer saved invoice', async t => {
  const db = await fixture(t), client = clientFor(db)()
  const request = { invoiceId: order, expectedVersion: 0, kind: 'edit', payload: draft() }
  assert.equal((await client.change(request)).ok, true)
  const stale = await client.change({ ...request, payload: draft(300000) })
  assert.equal(stale.ok, false)
  assert.equal(stale.needsRefresh, true)
  assert.equal(Number((await db.query('SELECT total FROM transactions')).rows[0].total), 400000)
})

test('server-confirmed stale retry can recover to a fresh revision without clearing uncertain commits', async t => {
  const db = await fixture(t), make = clientFor(db, { loseBefore: true })
  const request = { invoiceId: order, expectedVersion: 0, kind: 'edit', payload: draft() }
  assert.equal((await make().change(request)).needsReconciliation, true)
  await change(db, { op: id(595) })
  const retry = await make().change(request)
  assert.equal(retry.ok, false)
  assert.equal(retry.needsRefresh, true)
  const fresh = await make().change({ ...request, expectedVersion: 1, payload: draft(300000) })
  assert.equal(fresh.ok, true)
  assert.equal(fresh.data.total, 300000)
  assert.equal(fresh.data.version, 2)
})

test('invalid SQL date rollback permits a corrected request', async t => {
  const db = await fixture(t), make = clientFor(db)
  const request = { invoiceId: order, expectedVersion: 0, kind: 'edit', payload: { ...draft(), due_date: '2026-02-31' } }
  assert.equal((await make().change(request)).ok, false)
  assert.equal((await make().change({ ...request, payload: draft() })).ok, true)
})
