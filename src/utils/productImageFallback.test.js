import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveProductImage } from './productImageFallback.js'

test('matches supported garment names without randomizing', () => {
  for (const [name, type] of [
    ['Kaos Oblong + Sablon 3 Titik', 'kaos'],
    ['T-SHIRT custom', 'kaos'],
    ['jaket custom 145k', 'jaket'],
    ['Kaos Jersey Printing', 'jersey'],
  ]) {
    const expected = { kind: 'illustration', src: `/product-placeholders/${type}.png` }
    assert.deepEqual(resolveProductImage('', name), expected)
    assert.deepEqual(resolveProductImage('', name), expected)
  }
})

test('keeps uploaded photos ahead of illustrations', () => {
  assert.deepEqual(resolveProductImage('https://example.com/photo.jpg', 'Kaos'), {
    kind: 'photo', src: 'https://example.com/photo.jpg',
  })
})

test('blank sources and the old default logo use an illustration', () => {
  for (const src of [null, undefined, '', '   ', '/skupy-logo.png']) {
    assert.equal(resolveProductImage(src, 'Jaket').src, '/product-placeholders/jaket.png')
  }
})

test('unrecognized products use a neutral fallback, not a misleading garment', () => {
  for (const name of ['Banner 2x1', 'Kaos kaki', 'Jasa sablon kaos', 'Bahan jersey', 'Jersey fabric', 'Jersey printing per meter', 'Kertas', '', null]) {
    assert.deepEqual(resolveProductImage('', name), { kind: 'empty', src: null })
  }
})

test('a failed upload falls through to illustration and then stops at neutral', () => {
  const upload = 'https://example.com/broken.jpg'
  const illustration = '/product-placeholders/kaos.png'
  assert.deepEqual(resolveProductImage(upload, 'Kaos', [upload]), {
    kind: 'illustration', src: illustration,
  })
  assert.deepEqual(resolveProductImage(upload, 'Kaos', [upload, illustration]), {
    kind: 'empty', src: null,
  })
})
