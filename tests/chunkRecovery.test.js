import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'vite'
import { createServer as httpServer } from 'node:http'
import { renderToStaticMarkup } from 'react-dom/server'
import { isModuleLoadError } from '../src/utils/chunkRecovery.js'

test('recognizes module load failures without confusing API network errors', () => {
  for (const message of [
    'Failed to fetch dynamically imported module: https://example.test/assets/page.js',
    'error loading dynamically imported module: https://example.test/assets/page.js',
    'Importing a module script failed.',
    'Loading chunk 42 failed.',
    'Loading CSS chunk 42 failed.',
    'Unable to preload CSS for /assets/page.css',
  ]) assert.equal(isModuleLoadError(new Error(message)), true, message)
  assert.equal(isModuleLoadError({ name: 'ChunkLoadError' }), true)
  for (const error of [null, new TypeError('Failed to fetch'), new Error('permission denied'), new Error('Cannot read properties of undefined')]) {
    assert.equal(isModuleLoadError(error), false)
  }
})

test('missing page module offers a real reload instead of retrying the rejected lazy component', async () => {
  const vite = await createServer({ configFile: false, envFile: false, cacheDir: '/private/tmp/skupy-chunk-render-test',
    server: { middlewareMode: true, hmr: { server: httpServer() }, watch: null } })
  try {
    const { default: Boundary } = await vite.ssrLoadModule('/src/components/ErrorBoundary.jsx')
    const boundary = new Boundary({ title: 'Halaman accounting gagal dimuat' })
    boundary.state = { hasError: true, error: new TypeError('Failed to fetch dynamically imported module: https://pos.skupy.id/assets/Accounting-old.js') }
    const fallback = boundary.render()
    const html = renderToStaticMarkup(fallback)
    assert.match(html, /Muat Versi Terbaru/)
    assert.doesNotMatch(html, /> Coba Lagi/)
    assert.match(html, /belum disimpan/)
    assert.match(html, /<details/)
  } finally { await vite.close() }
})

test('ordinary rendering errors keep the existing retry action', async () => {
  const vite = await createServer({ configFile: false, envFile: false, cacheDir: '/private/tmp/skupy-chunk-render-test',
    server: { middlewareMode: true, hmr: { server: httpServer() }, watch: null } })
  try {
    const { default: Boundary } = await vite.ssrLoadModule('/src/components/ErrorBoundary.jsx')
    const boundary = new Boundary({})
    boundary.state = { hasError: true, error: new Error('Cannot read properties of undefined') }
    const html = renderToStaticMarkup(boundary.render())
    assert.match(html, /Coba Lagi/)
    assert.doesNotMatch(html, /Muat Versi Terbaru/)
  } finally { await vite.close() }
})
