import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'vite'
import { createServer as httpServer } from 'node:http'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

test('invoice editor preserves saved lines, DP and invoice identity without owner approval', async () => {
  const vite = await createServer({ configFile: false, envFile: false,
    cacheDir: '/private/tmp/skupy-invoice-render-test',
    server: { middlewareMode: true, hmr: { server: httpServer() }, watch: null } })
  try {
    const { default: Editor } = await vite.ssrLoadModule('/src/components/InvoiceEditor.jsx')
    const html = renderToStaticMarkup(React.createElement(Editor, {
      invoice: { id: 'one', invoiceNo: 'INV-TEST', customer: 'Pelanggan',
        items: [{ productId: 'gone', name: 'Produk lama', qty: 1, price: 150000, unit: 'pcs' }],
        discount: 0, tax: 0, paid: 200000, notes: '', dueDate: '' }, products: [],
      onClose() {}, onSave: async () => ({ ok: true }),
    }))
    assert.match(html, /INV-TEST/)
    assert.match(html, /Produk lama/)
    assert.match(html, /200\.000/)
    assert.match(html, /50\.000/)
    assert.match(html, /Kelebihan bayar/)
    assert.match(html, /Rp0<\/dd>/)
    assert.doesNotMatch(html, /ACC owner|Persetujuan owner|PIN owner/)
    assert.doesNotMatch(html, /name="paid"/)
  } finally { await vite.close() }
})

test('paid delete defaults to real cancellation, without claiming refund occurred', async () => {
  const vite = await createServer({ configFile: false, envFile: false,
    cacheDir: '/private/tmp/skupy-invoice-delete-test',
    server: { middlewareMode: true, hmr: { server: httpServer() }, watch: null } })
  try {
    const { default: Delete } = await vite.ssrLoadModule('/src/components/InvoiceDeleteDialog.jsx')
    const html = renderToStaticMarkup(React.createElement(Delete, {
      invoice: { id: 'one', invoiceNo: 'INV-TEST', total: 500000, paid: 200000, remaining: 300000 },
      onClose() {}, onConfirm: async () => ({ ok: true }),
    }))
    assert.match(html, /200\.000/)
    assert.match(html, /Perlu refund/)
    assert.match(html, /tidak mentransfer uang/)
    assert.doesNotMatch(html, /ACC owner|Persetujuan owner|PIN owner/)
  } finally { await vite.close() }
})
