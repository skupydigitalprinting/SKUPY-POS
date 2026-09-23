// Synthetic UI-only fixture. No requests reach Supabase or any account endpoint.
import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import ManagedAccounts from '../../src/components/ManagedAccounts'
import SelfPasswordChange from '../../src/components/SelfPasswordChange'
import '../../src/index.css'

const owner = { id: '10000000-0000-4000-8000-000000000001', authUserId: '10000000-0000-4000-8000-000000000002', authSessionId: '10000000-0000-4000-8000-000000000003', role: 'owner' }
const claims = btoa(JSON.stringify({ sub: owner.authUserId, session_id: owner.authSessionId })).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
const session = { access_token: `e30.${claims}.synthetic` }
let accounts = [{ id: '10000000-0000-4000-8000-000000000004', username: 'kasir-uji', name: 'Kasir Uji', role: 'staff', active: true, pending: false, version: 1 }]
async function mockRequest(url, options) {
  const body = JSON.parse(options.body)
  const operationId = options.headers['Idempotency-Key']
  let data
  if (body.action === 'list') data = { ok: true, accounts }
  else if (body.action === 'create') {
    const account = { id: crypto.randomUUID(), username: body.username, name: body.name, role: body.role, active: true, pending: false, version: 1 }
    accounts = [...accounts, account]; data = { ok: true, operationId, account }
  } else if (body.action === 'update') {
    accounts = accounts.map(a => a.id === body.targetAdminId ? { ...a, ...body.patch, version: a.version + 1 } : a)
    data = { ok: true, operationId, account: accounts.find(a => a.id === body.targetAdminId) }
  } else if (url === '/api/auth/change-password') {
    await new Promise(resolve => setTimeout(resolve, 1500))
    data = { ok: true, operationId, reauthenticationRequired: true }
  }
  else return new Response('{}', { status: 400 })
  return new Response(JSON.stringify(data), { status: 200 })
}
function Review() {
  const [view, setView] = useState('accounts')
  const [ended, setEnded] = useState(false)
  const props = { currentUser: owner, getSession: async () => ({ data: { session } }), isCurrent: () => !ended,
    fetchImpl: mockRequest, onSessionEnd: () => setEnded(true) }
  return <main style={{ maxWidth: 720, margin: '0 auto', padding: 20, color: 'var(--text-primary)' }}>
    <p className="text-xs mb-4">SYNTHETIC UI TEST</p>
    <nav className="flex gap-4 mb-6"><button onClick={() => setView('accounts')}>Akun</button><button onClick={() => setView('password')}>Password</button></nav>
    {ended ? <p role="status">Sesi uji ditutup.</p> : view === 'accounts' ? <ManagedAccounts {...props} /> : <SelfPasswordChange {...props} />}
  </main>
}
createRoot(document.getElementById('root')).render(<Review />)
