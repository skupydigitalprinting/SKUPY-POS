import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { webcrypto } from 'node:crypto'
import { createCheckoutClient } from '../../src/lib/checkoutClient.js'
import { fixture, as, actors, book, customer, id } from './invoice-lifecycle-fixture.js'

async function setup(t, failure) {
  const db = await fixture(t, { paid: 0 })
  await db.query("INSERT INTO products(id,name,price,stock,unit) VALUES ($1,'Custom shirt',100000,0,'pcs')", [id(990)])
  await db.exec(await readFile(new URL('../../supabase/security-stage2/013_atomic_checkout.sql', import.meta.url), 'utf8'))
  const request = { bookId: book, customerId: customer, customerName: 'Synthetic customer',
    items: [{ productId: id(990), name: 'Custom shirt', price: 100000, qty: 2, unit: 'pcs' }],
    paid: 50000, discount: 0, method: 'transfer', notes: '', dueDate: '2026-10-01' }
  const memory = () => { const data = new Map(); return { getItem: k => data.get(k) ?? null,
    setItem: (k, v) => data.set(k, v), removeItem: k => data.delete(k), clear: () => data.clear() } }
  const storage = memory(), draftStorage = memory()
  const client = { rpc: async (name, args) => {
    if (failure === 'before' && name === 'pos_checkout') { failure = null; throw new Error('Offline before dispatch') }
    const statements = {
      pos_checkout: ['SELECT pos_checkout($1,$2) result', [args.p_operation_id, args.p_request]],
      pos_checkout_status: ['SELECT pos_checkout_status($1) result', [args.p_operation_id]],
      pos_abandon_checkout: ['SELECT pos_abandon_checkout($1,$2) result', [args.p_operation_id, args.p_book_id]],
    }
    let rows
    try { rows = await as(db, 'cashier', ...statements[name]) }
    catch (error) { return { data: null, error: { code: error.code } } }
    if (failure === 'after' && name === 'pos_checkout') { failure = null; throw new Error('Lost committed response') }
    return { data: rows[0].result, error: null }
  } }
  const make = () => createCheckoutClient({ client, storage, draftStorage, actorId: actors.cashier.auth,
    scope: 'isolated-pglite', isCurrent: () => true, crypto: webcrypto,
    locks: { request: async (key, options, run) => run({ name: key }) } })
  return { db, make, request, draftStorage }
}

test('checkout client and SQL recover a lost committed response with no second invoice', async t => {
  const f = await setup(t, 'after')
  assert.equal((await f.make().submit(f.request)).needsReconciliation, true)
  f.draftStorage.clear()
  const result = await f.make().abandon()
  assert.equal(result.ok, true)
  assert.equal(result.data.paid, 50000)
  assert.equal((await f.db.query('SELECT count(*)::int n FROM transactions')).rows[0].n, 2)
  assert.equal(f.make().pending(), null)
})

test('checkout client and SQL abandon an uncommitted closed-tab draft and permit a corrected cart', async t => {
  const f = await setup(t, 'before')
  assert.equal((await f.make().submit(f.request)).needsReconciliation, true)
  f.draftStorage.clear()
  assert.deepEqual(await f.make().abandon(), { ok: true, abandoned: true })
  const result = await f.make().submit({ ...f.request, paid: 100000 })
  assert.equal(result.ok, true)
  assert.equal(result.data.paid, 100000)
  assert.equal((await f.db.query('SELECT count(*)::int n FROM transactions')).rows[0].n, 2)
})
