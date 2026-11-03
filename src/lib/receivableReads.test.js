import test from 'node:test'
import assert from 'node:assert/strict'
import { readReceivables, readReceivablePayments } from './receivableReads.js'

// Model the external REST boundary, including a server cap below the requested range.
function clientFor(tables, cap = 100) {
  return { from(table) {
    let rows = [...tables[table]]
    const query = {
      select() { return query },
      is(key, value) { rows = rows.filter(r => (r[key] ?? null) === value); return query },
      eq(key, value) { rows = rows.filter(r => r[key] === value); return query },
      in(key, values) { rows = rows.filter(r => values.includes(r[key])); return query },
      order() { return query },
      async range(from, to) { return { data: rows.slice(from, Math.min(to + 1, from + cap)), count: rows.length, error: null } },
    }
    return query
  } }
}

test('complete debts survive a lower server page cap and exclude other books/deleted rows', async () => {
  const debts = Array.from({ length: 601 }, (_, i) => ({ id: `d${i}`, book_id: 'a', paid: i === 600 ? 170000000 : 0 }))
  debts.push({ id: 'other', book_id: 'b', paid: 5 }, { id: 'deleted', book_id: 'a', deleted_at: '2026-01-01', paid: 5 })
  const result = await readReceivables(clientFor({ debts }), 'a')
  assert.equal(result.error, null)
  assert.equal(result.data.length, 601)
  assert.equal(result.data.reduce((sum, row) => sum + row.paid, 0), 170000000)
})

test('payment batching spans more than 100 notes and paginates within each batch without losing legacy rows', async () => {
  const ids = Array.from({ length: 201 }, (_, i) => `d${i}`)
  const debt_payments = ids.map((debt_id, i) => ({ id: `p${i}`, debt_id, customer_id: null, book_id: null, amount: 10 }))
  debt_payments.push({ id: 'excluded', debt_id: 'other', amount: 999 }, { id: 'deleted', debt_id: 'd0', deleted_at: '2026-01-01', amount: 999 })
  const result = await readReceivablePayments(clientFor({ debt_payments }, 30), [...ids, 'd0'])
  assert.equal(result.ok, true)
  assert.equal(result.data.length, 201)
  assert.equal(result.data.reduce((sum, p) => sum + p.amount, 0), 2010)
})

test('empty history performs no query and reports an empty success', async () => {
  assert.deepEqual(await readReceivablePayments({ from() { throw new Error('unexpected query') } }, []), { ok: true, data: [] })
})

test('a changing collection fails closed instead of publishing a skipped-row total', async () => {
  let page = 0
  const client = { from() {
    const q = { select: () => q, is: () => q, order: () => q,
      range: async () => ++page === 1
        ? { data: Array.from({ length: 500 }, (_, i) => ({ id: `d${i}` })), count: 600 }
        : { data: Array.from({ length: 99 }, (_, i) => ({ id: `d${i + 501}` })), count: 599 } }
    return q
  } }
  const result = await readReceivables(client)
  assert.equal(result.data, null)
  assert.ok(result.error)
})
