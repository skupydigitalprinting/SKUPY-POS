import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fixture } from '../tools/security-lab/invoice-lifecycle-fixture.js'

const migration = await readFile(new URL('../supabase/security-stage2/014_invoice_refund_account.sql', import.meta.url), 'utf8')

test('refund configuration can be initialized twice without posting money or changing invoices', async t => {
  const db = await fixture(t)
  await db.exec("DELETE FROM pos_security.invoice_account_config; DELETE FROM accounts WHERE code='2195'")
  const before = (await db.query('SELECT row_to_json(t) data FROM transactions t')).rows
  const entries = (await db.query('SELECT count(*) n FROM accounting_entries')).rows
  await db.exec(migration)
  await db.exec(migration)
  assert.deepEqual((await db.query('SELECT refund_account FROM pos_security.invoice_account_config')).rows, [{ refund_account: '2195' }])
  assert.deepEqual((await db.query('SELECT row_to_json(t) data FROM transactions t')).rows, before)
  assert.deepEqual((await db.query('SELECT count(*) n FROM accounting_entries')).rows, entries)
})

test('refund configuration refuses to reuse an unrelated account code', async t => {
  const db = await fixture(t)
  await db.exec('DELETE FROM pos_security.invoice_account_config')
  await assert.rejects(db.exec(migration), /already used for another purpose/)
  await db.exec('ROLLBACK')
  assert.deepEqual((await db.query('SELECT * FROM pos_security.invoice_account_config')).rows, [])
})
