import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { storeFixture } from './helpers/storeFixture.js'

test('secure receivable deletion never dispatches a legacy table deletion', async () => {
  await storeFixture(true, async (store, { calls }) => {
    const result = await store.deleteDebt('debt')
    assert.equal(result.ok, false)
    assert.equal(result.code, 'INVOICE_WORKFLOW_REQUIRED')
    assert.equal(calls.length, 0)
  })
})

test('receivables are wired to the shared invoice deletion and recovery workflow', async () => {
  const app = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8')
  const view = await readFile(new URL('../src/pages/Piutang.jsx', import.meta.url), 'utf8')
  const props = app.split('piutang: <Piutang')[1].split('/>,')[0]
  assert.match(props, /invoiceWorkflow=\{verifiedSession \? store.invoiceWorkflow : undefined\}/)
  assert.match(props, /pendingInvoiceChanges=\{store.pendingInvoiceChanges\}/)
  assert.match(view, /onClick=\{\(\) => openDelete\(d\)\}/)
  assert.match(view, /<InvoiceWorkflowDialog invoiceId=\{invoiceAction.id\}/)
  assert.match(view, /workflow=\{invoiceWorkflow\}/)
  assert.match(view, /pendingInvoiceChanges.map/)
  assert.match(view, /if \(invoiceWorkflow \|\| secureAuthEnabled\) return/)
})
