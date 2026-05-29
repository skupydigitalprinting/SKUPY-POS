import * as XLSX from 'xlsx'
import { CATEGORIES } from '../data/dummyData'

const PAYMENT_LABEL = {
  cash: 'Cash', transfer: 'Transfer', qris: 'QRIS', hutang: 'Hutang/Tempo',
}
const STATUS_LABEL = {
  pending: 'Pending', proses: 'Proses', selesai: 'Selesai', lunas: 'Lunas',
}
const catLabel = (id) => CATEGORIES.find(c => c.id === id)?.label || id || '-'

/**
 * Professional Excel export of transactions.
 *
 * @param {Array} transactions  list of trx (already filtered)
 * @param {Object} storeInfo    store info for header
 * @param {Object} options      { products, periodLabel, filename }
 */
export function exportTransactionsXLSX(transactions, storeInfo = {}, options = {}) {
  const products = options.products || []
  const periodLabel = options.periodLabel || ''

  // Build flat rows (one row per transaction item, for line-level detail)
  const flatRows = []
  transactions.forEach(t => {
    if (!t.items?.length) {
      flatRows.push({ t, item: null })
      return
    }
    t.items.forEach((it) => flatRows.push({ t, item: it }))
  })

  // Resolve category from product list
  const catFor = (productId) => {
    if (!productId) return '-'
    const p = products.find(x => x.id === productId)
    return catLabel(p?.category)
  }

  // ====== Build AOA (Array of Arrays) with header rows ======
  const aoa = []

  // Title rows
  aoa.push([`${storeInfo.name || 'Skupy Printing'} — LAPORAN TRANSAKSI`])
  if (storeInfo.tagline) aoa.push([storeInfo.tagline])
  if (storeInfo.address) aoa.push([storeInfo.address])
  if (storeInfo.phone) aoa.push([`Telp: ${storeInfo.phone}`])
  aoa.push([])
  if (periodLabel) aoa.push([`Periode: ${periodLabel}`])
  aoa.push([`Total Transaksi: ${transactions.length}`])
  const totalOmzet = transactions.reduce((s, t) => s + (Number(t.total) || 0), 0)
  aoa.push([`Total Omzet: Rp ${totalOmzet.toLocaleString('id-ID')}`])
  aoa.push([])

  // Column headers (row index ~ header)
  const HEADERS = [
    'No', 'No Invoice', 'Tanggal', 'Jam', 'Customer',
    'Produk', 'Kategori', 'Qty', 'Harga',
    'Subtotal Item', 'Subtotal Trx', 'Diskon', 'Pajak', 'Total',
    'Metode', 'Status', 'Kasir',
  ]
  const headerRowIdx = aoa.length
  aoa.push(HEADERS)

  // Data rows
  let no = 0
  flatRows.forEach(({ t, item }) => {
    no += 1
    const dt = new Date(t.date)
    aoa.push([
      no,
      t.invoiceNo || '',
      dt.toLocaleDateString('id-ID', { day: '2-digit', month: '2-digit', year: 'numeric' }),
      dt.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }),
      t.customer || 'Umum',
      item?.name || '-',
      catFor(item?.productId),
      item?.qty || 0,
      Number(item?.price) || 0,
      (Number(item?.qty || 0) * Number(item?.price || 0)),
      Number(t.subtotal) || 0,
      Number(t.discount) || 0,
      Number(t.tax) || 0,
      Number(t.total) || 0,
      PAYMENT_LABEL[t.paymentMethod] || t.paymentMethod || '',
      STATUS_LABEL[t.status] || t.status || '',
      t.cashier || '-',
    ])
  })

  // Totals row
  const totalsRowIdx = aoa.length
  aoa.push([
    '', '', '', '', '', '', 'TOTAL',
    '', '',
    flatRows.reduce((s, r) => s + (Number(r.item?.qty || 0) * Number(r.item?.price || 0)), 0),
    transactions.reduce((s, t) => s + (Number(t.subtotal) || 0), 0),
    transactions.reduce((s, t) => s + (Number(t.discount) || 0), 0),
    transactions.reduce((s, t) => s + (Number(t.tax) || 0), 0),
    totalOmzet,
    '', '', '',
  ])

  // ====== Convert to worksheet ======
  const ws = XLSX.utils.aoa_to_sheet(aoa)

  // ----- Merges for title rows -----
  const merges = []
  // Merge title rows across all columns
  for (let r = 0; r < headerRowIdx; r++) {
    if (aoa[r].length === 1) {
      merges.push({ s: { r, c: 0 }, e: { r, c: HEADERS.length - 1 } })
    }
  }
  ws['!merges'] = merges

  // ----- Column widths (auto-ish based on header + max content length) -----
  const widths = HEADERS.map((h, ci) => {
    let max = String(h).length
    for (let ri = headerRowIdx + 1; ri < aoa.length; ri++) {
      const cell = aoa[ri]?.[ci]
      if (cell == null) continue
      const len = String(cell).length
      if (len > max) max = len
    }
    return { wch: Math.min(40, Math.max(8, max + 2)) }
  })
  ws['!cols'] = widths

  // ----- Cell styling -----
  // Note: SheetJS community edition doesn't support full styles. To keep cross-version compatibility,
  // we apply number formats only (which xlsx-style would handle, but here xlsx does support number formats).
  const colA = (ci) => XLSX.utils.encode_col(ci)

  // Apply currency / number formats to relevant columns (Harga..Total)
  const currencyCols = [8, 9, 10, 11, 12, 13] // Harga..Total in HEADERS
  const qtyCol = 7

  const fmtRupiah = '"Rp" #,##0;[Red]-"Rp" #,##0'
  for (let ri = headerRowIdx + 1; ri <= totalsRowIdx; ri++) {
    currencyCols.forEach(ci => {
      const addr = `${colA(ci)}${ri + 1}`
      if (ws[addr] && ws[addr].t === 'n') ws[addr].z = fmtRupiah
    })
    const addrQty = `${colA(qtyCol)}${ri + 1}`
    if (ws[addrQty] && ws[addrQty].t === 'n') ws[addrQty].z = '#,##0'
  }

  // Mark header & totals rows bold (best effort; SheetJS community may strip but harmless)
  const boldStyle = { font: { bold: true } }
  HEADERS.forEach((_, ci) => {
    const addr = `${colA(ci)}${headerRowIdx + 1}`
    if (ws[addr]) ws[addr].s = { font: { bold: true, color: { rgb: 'FFFFFF' } }, fill: { fgColor: { rgb: '6366F1' } }, alignment: { horizontal: 'center', vertical: 'center' } }
    const totalAddr = `${colA(ci)}${totalsRowIdx + 1}`
    if (ws[totalAddr]) ws[totalAddr].s = { font: { bold: true }, fill: { fgColor: { rgb: 'F5F5F8' } } }
  })

  // Title styling
  const titleAddr = 'A1'
  if (ws[titleAddr]) ws[titleAddr].s = { font: { bold: true, sz: 14, color: { rgb: '6366F1' } }, alignment: { horizontal: 'center' } }

  // Freeze header
  ws['!freeze'] = { xSplit: 0, ySplit: headerRowIdx + 1 }

  // ====== Build workbook ======
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Transaksi')

  // Summary by date sheet
  const dailyMap = new Map()
  transactions.forEach(t => {
    const d = new Date(t.date).toLocaleDateString('id-ID', { day: '2-digit', month: '2-digit', year: 'numeric' })
    const cur = dailyMap.get(d) || { date: d, count: 0, total: 0, lunas: 0, pending: 0 }
    cur.count += 1
    cur.total += Number(t.total) || 0
    if (t.status === 'lunas') cur.lunas += Number(t.total) || 0
    else cur.pending += Number(t.remaining) || 0
    dailyMap.set(d, cur)
  })
  const daily = [...dailyMap.values()]
  const dailyAoa = [
    ['REKAP HARIAN'], [],
    ['Tanggal', 'Jumlah Trx', 'Omzet Lunas', 'Piutang', 'Total'],
    ...daily.map(d => [d.date, d.count, d.lunas, d.pending, d.total]),
  ]
  if (daily.length === 0) dailyAoa.push(['—', 0, 0, 0, 0])
  const ws2 = XLSX.utils.aoa_to_sheet(dailyAoa)
  ws2['!cols'] = [{ wch: 14 }, { wch: 12 }, { wch: 18 }, { wch: 18 }, { wch: 18 }]
  ws2['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 4 } }]
  XLSX.utils.book_append_sheet(wb, ws2, 'Rekap Harian')

  // ====== Write ======
  const filename = options.filename || `Laporan_${(storeInfo.name || 'Skupy').replace(/\s+/g, '_')}_${Date.now()}.xlsx`
  XLSX.writeFile(wb, filename)
  return { ok: true, filename, count: transactions.length, total: totalOmzet }
}

/**
 * Export customer transaction history.
 */
export function exportCustomerTransactionsXLSX(customer, transactions, storeInfo = {}) {
  const periodLabel = `Customer: ${customer.name}`
  const filename = `Histori_${customer.name.replace(/\s+/g, '_')}_${Date.now()}.xlsx`
  return exportTransactionsXLSX(transactions, storeInfo, { periodLabel, filename })
}
