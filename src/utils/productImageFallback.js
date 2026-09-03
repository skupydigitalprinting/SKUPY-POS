const GARMENTS = [
  ['jersey', /\bjersey\b/i],
  ['jaket', /\b(jaket|jacket|bomber)\b/i],
  ['kaos', /\b(kaos|oblong|t[ -]?shirt)\b/i],
]

export function resolveProductImage(src, name, failedSources = []) {
  const uploaded = typeof src === 'string' ? src.trim() : ''
  if (uploaded && uploaded !== '/skupy-logo.png' && !failedSources.includes(uploaded)) {
    return { kind: 'photo', src: uploaded }
  }

  const productName = typeof name === 'string' ? name : ''
  // Services, raw fabric and socks should not be pictured as finished clothing.
  const excluded = /\b(jasa|bahan|kain|fabric|meter|kaos\s+kaki)\b/i.test(productName)
  const garment = !excluded && GARMENTS.find(([, pattern]) => pattern.test(productName))
  const illustration = garment ? `/product-placeholders/${garment[0]}.png` : null
  if (illustration && !failedSources.includes(illustration)) {
    return { kind: 'illustration', src: illustration }
  }
  return { kind: 'empty', src: null }
}
