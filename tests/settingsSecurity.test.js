import test from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'
import { createServer as httpServer } from 'node:http'

test('secure account views expose only staff/admin provisioning and a private self-password form', async () => {
  const vite = await createServer({ configFile: false, envFile: false, cacheDir: '/private/tmp/skupy-account-render-test', server: { middlewareMode: true, hmr: { server: httpServer() }, watch: null } })
  try {
    const { default: Managed } = await vite.ssrLoadModule('/src/components/ManagedAccounts.jsx')
    const { default: Password } = await vite.ssrLoadModule('/src/components/SelfPasswordChange.jsx')
    const props = { currentUser: { role: 'owner' }, onSessionEnd() {} }
    const managed = renderToStaticMarkup(React.createElement(Managed, props))
    assert.ok(managed.includes('Password owner saat ini'))
    assert.ok(managed.includes('value="staff"'))
    assert.ok(managed.includes('value="admin"'))
    assert.equal(managed.includes('value="owner"'), false)
    for (const role of ['staff', 'admin', undefined]) assert.equal(renderToStaticMarkup(React.createElement(Managed, { currentUser: { role } })), '')
    for (const role of ['owner', 'admin', 'staff']) {
      const html = renderToStaticMarkup(React.createElement(Password, { ...props, currentUser: { role } }))
      assert.equal((html.match(/type="password"/g) || []).length, 3)
      assert.match(html, /autocomplete="current-password"/i)
      assert.match(html, /autocomplete="new-password"/i)
    }
    assert.equal(renderToStaticMarkup(React.createElement(Password, { currentUser: { role: 'staff' } })), '')
    const { default: Sidebar } = await vite.ssrLoadModule('/src/components/Sidebar.jsx')
    for (const role of ['staff', 'admin']) {
      const html = renderToStaticMarkup(React.createElement(Sidebar, { currentUser: { role, username: 'uji' }, onOpenPassword() {} }))
      assert.ok(html.includes('Ubah Password'))
      assert.equal(html.includes('>Pengaturan<'), false)
    }
    const { default: BookAccess } = await vite.ssrLoadModule('/src/components/StaffBookAccess.jsx')
    assert.ok(renderToStaticMarkup(React.createElement(BookAccess, { currentUser: { role: 'owner' } })).includes('Akses Book Staf'))
    for (const role of ['staff', 'admin']) assert.equal(renderToStaticMarkup(React.createElement(BookAccess, { currentUser: { role } })), '')
  } finally { await vite.close() }
})
