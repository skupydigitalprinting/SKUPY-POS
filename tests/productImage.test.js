import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer as httpServer } from 'node:http'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'

test('shared product thumbnail renders samples, escaped names and illustration labels', async () => {
  const vite = await createServer({
    configFile: false, envFile: false, cacheDir: '/private/tmp/skupy-product-image-test',
    server: { middlewareMode: true, hmr: { server: httpServer() }, watch: null },
  })
  try {
    const { ProductImage } = await vite.ssrLoadModule('/src/components/ui.jsx')
    const render = (props) => renderToStaticMarkup(React.createElement(ProductImage, props))
    assert.match(render({ alt: 'sampel 150k' }), />SAMPEL<\/span>/)
    const unknown = render({ alt: 'Custom <script>alert(1)</script>' })
    assert.match(unknown, /Custom &lt;script&gt;/)
    assert.doesNotMatch(unknown, /<script>/)
    assert.doesNotMatch(unknown, /<svg/)
    const embroidery = render({ alt: 'bordir 80k', fallbackSize: 80 })
    assert.match(embroidery, /src="\/product-placeholders\/bordir.png"/)
    assert.match(embroidery, />Ilustrasi<\/span>/)
    const photo = render({ src: '/uploaded.png', alt: 'sampel' })
    assert.match(photo, /src="\/uploaded.png"/)
    assert.doesNotMatch(photo, /Ilustrasi/)
  } finally {
    await vite.close()
  }
})
