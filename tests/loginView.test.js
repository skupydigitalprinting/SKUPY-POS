import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'vite'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer as createHttpServer } from 'node:http'

test('login never advertises shared default credentials and remember-me is opt-in', async () => {
  const http = createHttpServer()
  const vite = await createServer({ configFile: false, envFile: false, cacheDir: '/private/tmp/skupy-login-render-test', server: { middlewareMode: true, hmr: { server: http }, watch: null } })
  try {
    const { default: Login } = await vite.ssrLoadModule('/src/pages/Login.jsx')
    const html = renderToStaticMarkup(React.createElement(Login, { login: async () => ({ ok: false }), storeInfo: null }))
    assert.equal(html.includes('Default Login'), false)
    assert.equal(html.includes('aria-checked="false"'), true)
    assert.ok(html.includes('MASUK'))
    assert.match(html, /src="\/skupy-login-mark.png"/)
    assert.match(html, /width="104" height="128" class="max-w-full object-contain"/)
    assert.equal(html.includes('/skupy-login-logo.png'), false)
  } finally { await vite.close() }
})

test('category callbacks captured before logout cannot mutate the next session', async () => {
  const http = createHttpServer()
  const vite = await createServer({ configFile: false, envFile: false, cacheDir: '/private/tmp/skupy-category-render-test', server: { middlewareMode: true, hmr: { server: http }, watch: null } })
  try {
    const categories = await vite.ssrLoadModule('/src/hooks/useCategories.js')
    const sessions = await vite.ssrLoadModule('/src/lib/supabase.js')
    let captured
    function Probe() { captured = categories.useCategories(); return null }
    renderToStaticMarkup(React.createElement(Probe))
    const target = captured.categories[0].id
    sessions.invalidateDataSession()
    sessions.activateDataSession({ authUserId: '10000000-0000-4000-8000-000000000001', authSessionId: '20000000-0000-4000-8000-000000000001' })
    const before = categories.getCategories()
    assert.equal(captured.deleteCategory(target).ok, false)
    assert.equal(categories.getCategories(), before)
    assert.deepEqual(await captured.listAllCategories(), [])
  } finally { await vite.close() }
})
