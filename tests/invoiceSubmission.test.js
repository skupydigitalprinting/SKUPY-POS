import test from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'
import { createServer as httpServer } from 'node:http'

async function fixture(options, run) {
  const vite = await createServer({ configFile: false, envFile: false, cacheDir: '/private/tmp/skupy-invoice-submit-tests',
    server: { middlewareMode: true, hmr: { server: httpServer() }, watch: null } })
  try {
    const { useInvoiceSubmission } = await vite.ssrLoadModule('/src/hooks/useInvoiceSubmission.js')
    let submission, closed = 0
    function Capture() { submission = useInvoiceSubmission({ onClose: () => closed++, ...options }); return null }
    renderToStaticMarkup(React.createElement(Capture))
    await run(submission, () => closed)
  } finally { await vite.close() }
}

test('rapid form submit and close cannot duplicate or dismiss an in-flight invoice change', async () => fixture({}, async (form, closed) => {
  let finish, writes = 0
  const action = () => { writes++; return new Promise(resolve => { finish = resolve }) }
  const first = form.submit(action)
  await form.submit(action)
  form.close()
  assert.equal(writes, 1)
  assert.equal(closed(), 0)
  finish({ ok: true })
  await first
  assert.equal(closed(), 1)
}))

test('ambiguous result blocks new payload and only retries original action after unknown status', async () => fixture({
  onReconcile: async () => ({ ok: false, needsReconciliation: true, unknown: true }),
}, async (form, closed) => {
  let original = 0, changed = 0
  await form.submit(async () => ++original === 1 ? { ok: false, needsReconciliation: true } : { ok: true })
  await form.submit(async () => { changed++; return { ok: true } })
  await form.retry()
  assert.equal(original, 1)
  assert.equal(changed, 0)
  assert.equal(closed(), 0)
  await form.check()
  await form.retry()
  assert.equal(original, 2)
  assert.equal(changed, 0)
  assert.equal(closed(), 1)
}))

test('committed refresh failure permits refresh only, never another save', async () => {
  const reloads = []
  await fixture({ onRefresh: async committed => { reloads.push(committed); return { ok: true } } }, async (form, closed) => {
    let writes = 0
    const action = async () => { writes++; return { ok: false, committed: true, needsRefresh: true } }
    await form.submit(action)
    await form.submit(action)
    await form.retry()
    assert.equal(writes, 1)
    await form.refresh()
    assert.deepEqual(reloads, [true])
    assert.equal(closed(), 1)
  })
})

test('thrown mutation locks form until status confirms success', async () => fixture({ onReconcile: async () => ({ ok: true }) }, async (form, closed) => {
  let writes = 0
  await form.submit(async () => { writes++; throw new Error('Lost network response') })
  await form.submit(async () => { writes++; return { ok: true } })
  assert.equal(writes, 1)
  assert.equal(closed(), 0)
  await form.check()
  assert.equal(closed(), 1)
}))
