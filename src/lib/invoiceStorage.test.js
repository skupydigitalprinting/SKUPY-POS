import test from 'node:test'
import assert from 'node:assert/strict'
import { uploadPrivateInvoice } from './invoiceStorage.js'

const transactionId = '10000000-0000-4000-8000-000000000041'
const uploadId = '10000000-0000-4000-8000-000000000051'
const png = new Blob(['synthetic-png'], { type: 'image/png' })
function fixture(overrides = {}) {
  const calls = []
  const bucket = {
    async upload(...args) { calls.push(['upload', ...args]); return overrides.upload || { error: null } },
    async createSignedUrl(...args) { calls.push(['sign', ...args]); return overrides.sign || { data: { signedUrl: 'https://example.test/signed' }, error: null } },
    getPublicUrl() { throw new Error('Private invoices must never use public URLs') },
  }
  const query = {
    select(value) { calls.push(['select', value]); return this },
    eq(...args) { calls.push(['eq', ...args]); return this },
    async maybeSingle() { return overrides.transaction || { data: { id: transactionId }, error: null } },
  }
  return { calls, client: {
    from(table) { assert.equal(table, 'transactions'); return query },
    storage: { from(name) { assert.equal(name, 'invoices'); return bucket } },
  } }
}
test('private invoice path uses the visible transaction and returns only a short-lived signed URL', async () => {
  const { client, calls } = fixture()
  assert.equal(await uploadPrivateInvoice(client, png, 'INV/42', () => uploadId), 'https://example.test/signed')
  assert.deepEqual(calls[1], ['eq', 'invoice_no', 'INV/42'])
  assert.deepEqual(calls[2], ['upload', `${transactionId}/${uploadId}.png`, png, { upsert: false, contentType: 'image/png', cacheControl: '0' }])
  assert.deepEqual(calls[3], ['sign', `${transactionId}/${uploadId}.png`, 1800])
})
test('invalid image or inaccessible invoice never attempts an upload', async () => {
  for (const transaction of [{ data: null }, { error: new Error('denied') }, { data: { id: '../escape' } }]) {
    const { client, calls } = fixture({ transaction })
    await assert.rejects(uploadPrivateInvoice(client, png, 'INV/42', () => uploadId))
    assert.equal(calls.some(x => x[0] === 'upload'), false)
  }
  const { client, calls } = fixture()
  for (const blob of [null, new Blob(['x'], { type: 'text/html' }), new Blob([], { type: 'image/png' })]) await assert.rejects(uploadPrivateInvoice(client, blob, 'INV/42'))
  assert.equal(calls.length, 0)
})
test('upload and signing failures are not reported as success or downgraded to public links', async () => {
  for (const options of [{ upload: { error: new Error('denied') } }, { sign: { error: new Error('expired') } }, { sign: { data: null } }]) {
    const { client } = fixture(options)
    await assert.rejects(uploadPrivateInvoice(client, png, 'INV/42', () => uploadId))
  }
})
