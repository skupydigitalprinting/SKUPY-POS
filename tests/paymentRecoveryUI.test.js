import test from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'
import { createServer as httpServer } from 'node:http'

test('payment recovery names unresolved invoice, exposes status check and does not offer unverified resend', async () => {
  const vite = await createServer({ configFile: false, envFile: false, cacheDir: '/private/tmp/skupy-payment-recovery-ui',
    server: { middlewareMode: true, hmr: { server: httpServer() }, watch: null } })
  try {
    const { default: Panel } = await vite.ssrLoadModule('/src/components/PaymentRecoveryPanel.jsx')
    const workflow = { reconcile: async () => ({ ok: false, unknown: true }), resume: async () => ({ ok: true }) }
    assert.equal(renderToStaticMarkup(React.createElement(Panel, { workflow, pending: [] })), '')
    const html = renderToStaticMarkup(React.createElement(Panel, { workflow,
      pending: [{ invoiceNo: 'INV-TEST', operationId: 'op-1' }] }))
    assert.match(html, /INV-TEST/)
    assert.match(html, /Periksa Status/)
    assert.doesNotMatch(html, /Ulangi Permintaan/)
    const committed = renderToStaticMarkup(React.createElement(Panel, { workflow, pending: [], refreshRequired: true }))
    assert.match(committed, /Muat Hasil Tersimpan/)
    assert.doesNotMatch(committed, /Ulangi Permintaan/)
  } finally { await vite.close() }
})
