const GARMENTS = [
  ['jersey', /\bjersey\b/i],
  ['jaket', /\b(jaket|jacket|bomber)\b/i],
  ['kaos', /\b(kaos|oblong|t[ -]?shirt)\b/i],
]
const PRODUCTS = [
  ['bendera', /\b(bendera|flag)\b/i],
  ['scarf', /\b(scarf|hijab|jilbab|kerudung|pashmina)\b/i],
  ...GARMENTS,
  ['bordir', /\b(bordir|embroidery)\b/i],
]

export function resolveProductImage(src, name, failedSources = []) {
  const uploaded = typeof src === 'string' ? src.trim() : ''
  if (uploaded && uploaded !== '/skupy-logo.png' && !failedSources.includes(uploaded)) {
    return { kind: 'photo', src: uploaded }
  }

  const productName = typeof name === 'string' ? name.replace(/\s+/g, ' ').trim() : ''
  const sample = /\b(sampel|sample)\b/i.test(productName)
  const text = sample ? 'SAMPEL' : productName || 'PRODUK'
  // Raw materials and clothing services must not look like finished garments.
  const rawMaterial = /\b(bahan|kain|fabric|meter|kaos\s+kaki)\b/i.test(productName)
  const service = /\bjasa\b/i.test(productName)
  const product = !sample && !rawMaterial && PRODUCTS.find(([type, pattern]) => (
    pattern.test(productName) && (!service || type === 'bordir')
  ))
  const illustration = product ? `/product-placeholders/${product[0]}.png` : null
  if (illustration && !failedSources.includes(illustration)) {
    return { kind: 'illustration', src: illustration }
  }
  return { kind: 'text', src: null, text }
}
