import test from 'node:test'
import assert from 'node:assert/strict'
import { validNewPassword } from './passwordRules.js'

test('new passwords require 12 Unicode characters and fit Auth 72-byte limit', () => {
  assert.equal(validNewPassword('a'.repeat(11)), false)
  assert.equal(validNewPassword('a'.repeat(12)), true)
  assert.equal(validNewPassword('a'.repeat(72)), true)
  assert.equal(validNewPassword('a'.repeat(73)), false)
  assert.equal(validNewPassword('\u{1f511}'.repeat(12)), true)
  assert.equal(validNewPassword('\u{1f511}'.repeat(19)), false)
  assert.equal(validNewPassword('\u{1f511}'.repeat(6)), false)
  assert.equal(validNewPassword('\u00e9'.repeat(36)), true)
  assert.equal(validNewPassword('\u00e9'.repeat(37)), false)
})
