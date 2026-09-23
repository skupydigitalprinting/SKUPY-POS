import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'vite'
import { createServer as createHttpServer } from 'node:http'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

test('self-contained account views restrict roles and expose labelled password and versioned account controls', async () => {
  const vite = await createServer({ configFile: false, envFile: false, cacheDir: '/private/tmp/skupy-account-view-test',
    server: { middlewareMode: true, hmr: { server: createHttpServer() }, watch: null } })
  try {
    const { default: ManagedAccounts } = await vite.ssrLoadModule('/src/components/ManagedAccounts.jsx')
    const { default: SelfPasswordChange } = await vite.ssrLoadModule('/src/components/SelfPasswordChange.jsx')
    const props = { currentUser: { role: 'owner', authUserId: 'user', authSessionId: 'session' }, getSession: async () => null, isCurrent: () => true }
    const accounts = renderToStaticMarkup(React.createElement(ManagedAccounts, props))
    assert.ok(accounts.includes('name="username"'))
    assert.ok(accounts.includes('value="staff"')); assert.ok(accounts.includes('value="admin"'))
    assert.equal(accounts.includes('value="owner"'), false)
    assert.ok(accounts.includes('autoComplete="new-password"'))
    assert.equal(renderToStaticMarkup(React.createElement(ManagedAccounts, { ...props, currentUser: { role: 'staff' } })), '')
    const password = renderToStaticMarkup(React.createElement(SelfPasswordChange, { ...props, currentUser: { ...props.currentUser, role: 'staff' }, onSessionEnd: async () => {} }))
    assert.equal((password.match(/type="password"/g) || []).length, 3)
    assert.equal((password.match(/<label for=/g) || []).length, 3)
    assert.ok(password.includes('autoComplete="current-password"'))
    assert.equal(renderToStaticMarkup(React.createElement(SelfPasswordChange, props)), '')
    assert.equal(renderToStaticMarkup(React.createElement(SelfPasswordChange, { ...props, currentUser: null, onSessionEnd() {} })), '')
  } finally { await vite.close() }
})
