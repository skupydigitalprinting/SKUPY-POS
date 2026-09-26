import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'vite'
import { createServer as createHttpServer } from 'node:http'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

test('invoice displays cumulative payments without changing the remaining balance', async (t) => {
  const http = createHttpServer()
  const vite = await createServer({ configFile: false, envFile: false, cacheDir: '/private/tmp/skupy-invoice-paid-test', server: { middlewareMode: true, hmr: { server: http }, watch: null } })
  try {
    const { default: Invoice } = await vite.ssrLoadModule('/src/components/Invoice.jsx')
    for (const scenario of [
      { name: 'multiple deposits', paid: 2600000, dp: 100000, expected: '2.600.000' },
      { name: 'first deposit', paid: 100000, dp: 100000, expected: '100.000' },
      { name: 'zero cumulative payment stays zero', paid: 0, dp: 100000, expected: '0' },
      { name: 'legacy deposit without cumulative field', dp: 100000, expected: '100.000' },
      { name: 'no payments', expected: '0' },
    ]) {
      await t.test(scenario.name, () => {
        const transaction = Object.freeze({ invoiceNo: 'TEST-DP', date: '2026-09-25T03:20:00Z', status: 'pending', paymentMethod: 'transfer', items: [], subtotal: 6115000, total: 6115000, remaining: 3515000, paid: scenario.paid, dp: scenario.dp })
        const html = renderToStaticMarkup(React.createElement(Invoice, { transaction, onClose() {} }))
        const paid = html.match(/DP Dibayar<\/span><span[^>]*>([^<]+)<\/span>/)?.[1]
        const remaining = html.match(/Sisa Tagihan<\/div><div[^>]*>([^<]+)<\/div>/)?.[1]
        assert.equal(paid?.replace(/\s/g, ''), `Rp${scenario.expected}`)
        assert.equal(remaining?.replace(/\s/g, ''), 'Rp3.515.000')
        assert.equal(transaction.remaining, 3515000)
      })
    }
  } finally { await vite.close() }
})
