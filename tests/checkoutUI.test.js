import test from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'
import { createServer as httpServer } from 'node:http'

test('checkout recovery exposes status before any exact resend and hides when idle', async () => {
  const vite = await createServer({ configFile: false, envFile: false, cacheDir: '/private/tmp/skupy-checkout-ui',
    server: { middlewareMode: true, hmr: { server: httpServer() }, watch: null } })
  try {
    const { default: Panel } = await vite.ssrLoadModule('/src/components/CheckoutRecoveryPanel.jsx')
    const workflow = { reconcile: async () => ({ ok: false }), resume: async () => ({ ok: false }) }
    assert.equal(renderToStaticMarkup(React.createElement(Panel, { workflow })), '')
    const html = renderToStaticMarkup(React.createElement(Panel, { workflow, pending: { operationId: 'synthetic' } }))
    assert.match(html, /Periksa Checkout/)
    assert.doesNotMatch(html, /Kirim Ulang/)
  } finally { await vite.close() }
})
