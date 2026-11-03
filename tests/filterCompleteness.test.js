import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { storeFixture } from './helpers/storeFixture.js'

test('transaction refresh reads older invoices past the first page before publishing', async () => {
  await storeFixture(false, async (store, transport) => {
    const first = Array.from({ length: 500 }, (_, i) => ({ id: `t${i}`, created_at: '2026-11-01T00:00:00Z', total: 100 }))
    const last = [{ id: 'oct-first', created_at: '2026-10-01T00:00:00+07:00', total: 2000000 }]
    transport.script.push({ data: first, count: 501, error: null }, { data: last, count: 501, error: null })
    await store.refreshTransactions()
    assert.equal(transport.script.length, 0, 'must read the second page, not stop at a fixed limit')
    const rows = transport.stateWrites.filter(s => s.name === 'transactions').at(-1).value
    assert.equal(rows.length, 501)
    assert.equal(rows.at(-1).total, 2000000)
    assert.equal(transport.requests.every(r => r.steps.some(s => s.method === 'eq' && s.args[0] === 'book_id' && s.args[1] === 'a')), true)
  }, [], { observe: true, initialBookId: 'a' })
})

test('failed transaction page never publishes a partial replacement', async () => {
  await storeFixture(false, async (store, transport) => {
    transport.script.push({ data: [{ id: 'new' }], count: 2, error: null }, { data: null, error: { message: 'Offline' } })
    await store.refreshTransactions()
    assert.equal(transport.stateWrites.filter(s => s.name === 'transactions').length, 0)
  }, [{ id: 'old', items: [] }], { observe: true })
})

test('a Book switch while older pages load cannot publish the previous Book', async () => {
  await storeFixture(false, async (store, transport) => {
    transport.script.push({ data: [{ id: 'first' }], count: 2, error: null },
      { then(resolve) { store.setActiveBook('b'); resolve({ data: [{ id: 'last' }], count: 2, error: null }) } })
    await store.refreshTransactions()
    assert.equal(transport.stateWrites.filter(s => s.name === 'transactions').length, 0)
  }, [], { observe: true, initialBookId: 'a' })
})

test('shared filter collections do not use hard caps', () => {
  const store = readFileSync(new URL('../src/hooks/useStore.js', import.meta.url), 'utf8')
  assert.doesNotMatch(store, /limit\(TRX_LIMIT\)/)
  const accounting = readFileSync(new URL('../src/hooks/useAccounting.js', import.meta.url), 'utf8')
  assert.doesNotMatch(accounting, /\.limit\((?:200|300|500|1000|2000|5000|10000)\)/)
})
