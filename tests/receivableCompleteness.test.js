import test from 'node:test'
import assert from 'node:assert/strict'
import { storeFixture } from './helpers/storeFixture.js'

const ok = data => ({ data, error: null })
const recent = Array.from({ length: 500 }, (_, i) => ({ id: `recent-${i}`, customer_id: 'other', paid: 0, remaining: 1 }))
const old = { id: 'old-paid', customer_id: 'luby', paid: 170000000, remaining: 468207262, invoice_no: 'OLD' }

test('receivables refresh includes old paid notes beyond 500 and preserves book scope', async () => {
  await storeFixture(false, async (store, db) => {
    db.script.push(ok(recent), ok([old]))
    await store.refreshDebts()
    const rows = db.stateWrites.filter(x => x.name === 'debts').at(-1).value
    assert.equal(rows.length, 501)
    assert.equal(rows.find(x => x.id === 'old-paid').paid, 170000000)
    for (const request of db.requests) {
      assert.ok(request.steps.some(s => s.method === 'eq' && s.args[0] === 'book_id' && s.args[1] === 'book-a'))
      assert.ok(request.steps.some(s => s.method === 'is' && s.args[0] === 'deleted_at' && s.args[1] === null))
    }
  }, [], { observe: true, initialBookId: 'book-a' })
})

test('a failed later debt page never publishes misleading partial totals', async () => {
  await storeFixture(false, async (store, db) => {
    db.script.push(ok(recent), { data: null, error: { message: 'offline' } })
    await store.refreshDebts()
    assert.equal(db.stateWrites.filter(x => x.name === 'debts').length, 0)
  }, [], { observe: true })
})

test('batch history loads legacy allocations through debt IDs and never returns partial success', async () => {
  await storeFixture(false, async (store, db) => {
    db.script.push(ok([{ id: 'p', debt_id: 'old-paid', customer_id: null, book_id: null, amount: 170000000 }]))
    const result = await store.getReceivablePayments(['old-paid'])
    assert.equal(result.ok, true)
    assert.equal(result.data[0].amount, 170000000)
    assert.ok(db.requests[0].steps.some(s => s.method === 'in' && s.args[0] === 'debt_id' && s.args[1][0] === 'old-paid'))
    db.script.push({ ...ok(Array.from({ length: 500 }, (_, i) => ({ id: `p-${i}`, debt_id: 'old-paid' }))), count: 501 }, { error: { message: 'offline' }, data: null })
    const failed = await store.getReceivablePayments(['old-paid'])
    assert.equal(failed.ok, false)
    assert.deepEqual(failed.data, [])
  })
})
