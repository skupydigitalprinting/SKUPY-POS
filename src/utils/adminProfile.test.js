import test from 'node:test'
import assert from 'node:assert/strict'
import { ADMIN_PROFILE_COLUMNS, adminProfileFromDB } from './adminProfile.js'

test('admin profiles omit credentials and unexpected database fields', () => {
  const profile = adminProfileFromDB({
    id: 'test-admin', username: 'kasir', name: 'Kasir', role: 'staff',
    password: 'synthetic-test-only', password_hash: 'synthetic-hash',
    reset_token: 'synthetic-token', future_private_field: 'private',
  })
  assert.deepEqual(profile, { id: 'test-admin', username: 'kasir', name: 'Kasir', role: 'staff' })
  assert.deepEqual(ADMIN_PROFILE_COLUMNS.split(','), Object.keys(profile))
})

test('legacy profiles retain their display and permission defaults', () => {
  assert.deepEqual(adminProfileFromDB({ id: 'test-admin', username: 'kasir', name: '', role: null }), {
    id: 'test-admin', username: 'kasir', name: 'kasir', role: 'staff',
  })
})
