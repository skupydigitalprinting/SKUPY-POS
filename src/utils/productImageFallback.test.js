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

test('unrecognized products and raw materials use their name, not a misleading garment', () => {
  for (const name of ['Banner 2x1', 'Kaos kaki', 'Jasa sablon kaos', 'Bahan jersey', 'Jersey fabric', 'Jersey printing per meter', 'Kertas', '', null]) {
    assert.deepEqual(resolveProductImage('', name), { kind: 'text', src: null, text: name || 'PRODUK' })
  }
})

test('a failed upload falls through to illustration and then stops at its name', () => {
  const upload = 'https://example.com/broken.jpg'
  const illustration = '/product-placeholders/kaos.png'
  assert.deepEqual(resolveProductImage(upload, 'Kaos', [upload]), {
    kind: 'illustration', src: illustration,
  })
  assert.deepEqual(resolveProductImage(upload, 'Kaos', [upload, illustration]), {
    kind: 'text', src: null, text: 'Kaos',
  })
})

test('recognizes embroidery, flags and scarves from the title', () => {
  for (const [name, type] of [
    ['bordir 80k', 'bordir'], ['bordir + velcro', 'bordir'],
    ['Jasa BORDIR logo', 'bordir'], ['Embroidery patch', 'bordir'],
    ['bendera 0,5m', 'bendera'], ['bendera 2,5m', 'bendera'],
    ['scarf standar', 'scarf'], ['Hijab custom', 'scarf'],
    ['jilbab segi empat', 'scarf'], ['kerudung', 'scarf'],
  ]) {
    assert.deepEqual(resolveProductImage('', name), {
      kind: 'illustration', src: `/product-placeholders/${type}.png`,
    })
  }
})

test('samples use a sample label ahead of other product keywords', () => {
  for (const name of ['sampel 150k', 'SAMPLE', 'sample bordir', 'sampel jersey']) {
    assert.deepEqual(resolveProductImage('', name), { kind: 'text', src: null, text: 'SAMPEL' })
  }
  assert.equal(resolveProductImage('uploaded.jpg', 'sample bordir').kind, 'photo')
})

test('raw fabric is not shown as a finished scarf and names do not match substrings', () => {
  for (const name of ['bahan hijab', 'kain scarf meter', 'scarfing', 'pembordiran', 'kaos kaki bordir']) {
    assert.deepEqual(resolveProductImage('', name), { kind: 'text', src: null, text: name })
  }
  assert.equal(resolveProductImage('', 'Kaos custom bordir').src, '/product-placeholders/kaos.png')
})

test('normalizes display whitespace without dropping unknown product names', () => {
  assert.deepEqual(resolveProductImage('', '  Produk\n custom   khusus '), {
    kind: 'text', src: null, text: 'Produk custom khusus',
  })
  assert.deepEqual(resolveProductImage('', '  '), { kind: 'text', src: null, text: 'PRODUK' })
})

test('new illustrations fail safely to text without retry loops', () => {
  for (const type of ['bordir', 'bendera', 'scarf']) {
    const photo = 'https://example.com/broken.jpg'
    const illustration = `/product-placeholders/${type}.png`
    assert.equal(resolveProductImage(photo, type, [photo]).src, illustration)
    assert.deepEqual(resolveProductImage(photo, type, [photo, illustration]), {
      kind: 'text', src: null, text: type,
    })
  }
})
