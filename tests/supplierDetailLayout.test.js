import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/pages/Accounting.jsx', import.meta.url), 'utf8')
test('supplier detail has separate panels and a sticky summary with tabs', () => {
  assert.match(source, /aria-label="Detail hutang supplier"/)
  assert.match(source, /hidden=\{supDetailTab !== 'notes'\}/)
  assert.match(source, /hidden=\{supDetailTab !== 'payments'\}/)
  assert.match(source, /sticky -top-5 z-10/)
  assert.match(source, /setSupDetailTab\('notes'\); setSupDetailName\(name\)/)
})
