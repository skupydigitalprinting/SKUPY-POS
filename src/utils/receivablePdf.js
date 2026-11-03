import { jsPDF } from 'jspdf'
import { autoTable } from 'jspdf-autotable'

const rp = value => `Rp ${value.toLocaleString('id-ID')}`
const date = value => {
  if (!value) return '-'
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? '-' : d.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Jakarta' })
}
const text = value => String(value || '').replace(/[\r\n\t]+/g, ' ').trim()
let unicodeFontPromise

export async function loadReceivablePdfFont(report, options) {
  if (!/[^\x20-\xff\r\n\t]/.test(JSON.stringify([report, options]))) return null
  if (!unicodeFontPromise) {
    unicodeFontPromise = fetch(new URL('../assets/fonts/NotoSansSC-Regular.ttf', import.meta.url)).then(async response => {
      if (!response.ok) throw new Error('Font PDF gagal dimuat. Silakan coba lagi.')
      const bytes = new Uint8Array(await response.arrayBuffer())
      const chunks = []
      for (let i = 0; i < bytes.length; i += 8192) chunks.push(String.fromCharCode(...bytes.subarray(i, i + 8192)))
      return btoa(chunks.join(''))
    }).catch(error => { unicodeFontPromise = null; throw error })
  }
  return unicodeFontPromise
}

export function createReceivablePDF(report, { storeName = 'SKUPY', bookName = 'Semua Book', accountScope = 'Seluruh PIC sesuai akses akun', generatedAt = new Date(), fontData = null } = {}) {
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4', putOnlyUsedFonts: true })
  const bodyFont = fontData ? 'NotoSansSC' : 'helvetica'
  if (fontData) {
    doc.addFileToVFS('NotoSansSC-Regular.ttf', fontData)
    doc.addFont('NotoSansSC-Regular.ttf', bodyFont, 'normal')
    doc.addFont('NotoSansSC-Regular.ttf', bodyFont, 'bold')
  }
  const width = doc.internal.pageSize.getWidth(), height = doc.internal.pageSize.getHeight()
  const margin = 14, contentWidth = width - 2 * margin
  const stamp = generatedAt.toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Jakarta' }) + ' WIB'
  doc.setProperties({ title: 'Laporan Piutang Pelanggan', author: text(storeName), subject: text(bookName) })
  doc.setFont('helvetica', 'bold'); doc.setFontSize(20); doc.setTextColor(25, 29, 38)
  doc.text('LAPORAN PIUTANG', margin, 22)
  doc.setFont(bodyFont, 'normal'); doc.setFontSize(10); doc.setTextColor(75, 82, 94)
  const metadata = doc.splitTextToSize(`${text(storeName)} | ${text(bookName)} | ${text(accountScope)}`, contentWidth)
  if (metadata.length > 3) { metadata.length = 3; metadata[2] = metadata[2].slice(0, -3) + '...' }
  doc.text(metadata, margin, 30)
  let y = 30 + metadata.length * 5
  doc.setFontSize(9); doc.text(`Posisi saat diunduh: ${stamp}`, margin, y)
  y += 9
  const t = report.totals
  const totals = [['TOTAL TAGIHAN', t.total], ['SUDAH DIBAYAR', t.paid], ['SISA PIUTANG', t.remaining]]
  const colWidth = contentWidth / 3
  doc.setFillColor(243, 245, 248); doc.rect(margin, y, contentWidth, 24, 'F')
  totals.forEach(([label, amount], i) => {
    const x = margin + i * colWidth + 5
    doc.setFontSize(8); doc.setFont('helvetica', 'normal'); doc.setTextColor(75, 82, 94); doc.text(label, x, y + 7)
    doc.setFontSize(15); doc.setFont('helvetica', 'bold'); doc.setTextColor(...(i === 2 ? [158, 46, 46] : [25, 29, 38])); doc.text(rp(amount), x, y + 17)
  })
  y += 31
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(75, 82, 94)
  doc.text(`${t.customers} pelanggan | ${t.invoices} nota | ${t.activeInvoices} nota belum lunas`, margin, y)
  doc.text('Seluruh nota dalam cakupan akses, termasuk lunas. Pencarian dan filter daftar tidak membatasi laporan.', margin, y + 6)
  const base = {
    theme: 'striped', margin: { top: 23, bottom: 17, left: margin, right: margin },
    styles: { font: bodyFont, fontSize: 8, cellPadding: 2.4, overflow: 'linebreak', textColor: [32, 38, 48], lineColor: [225, 229, 235] },
    headStyles: { fillColor: [38, 53, 65], textColor: 255, fontStyle: 'bold' },
    footStyles: { fillColor: [232, 238, 241], textColor: [25, 29, 38], fontStyle: 'bold' },
    alternateRowStyles: { fillColor: [246, 248, 250] },
    showHead: 'everyPage', showFoot: 'lastPage', rowPageBreak: 'avoid',
  }
  if (!t.invoices) {
    doc.text('Tidak ada catatan piutang dalam cakupan ini.', margin, y + 18)
  } else {
    doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(25, 29, 38)
    doc.text('REKAP PER PELANGGAN', margin, y + 17)
    autoTable(doc, { ...base, startY: y + 21,
      head: [['Pelanggan', 'PIC', 'Nota', 'Total tagihan', 'Sudah dibayar', 'Sisa piutang']],
      body: report.customers.map(c => [text(c.name), text(c.pic), c.invoices, rp(c.total), rp(c.paid), rp(c.remaining)]),
      foot: [['TOTAL', '', t.invoices, rp(t.total), rp(t.paid), rp(t.remaining)]],
      columnStyles: { 0: { cellWidth: 72 }, 1: { cellWidth: 45 }, 2: { cellWidth: 14, halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right' }, 5: { halign: 'right', fontStyle: 'bold' } },
    })
    doc.addPage()
    doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.setTextColor(25, 29, 38)
    doc.text('RINCIAN SELURUH NOTA', margin, 28)
    autoTable(doc, { ...base, startY: 33,
      head: [['Pelanggan / PIC', 'Invoice', 'Tanggal / Tempo', 'Tagihan', 'Dibayar', 'Sisa', 'Status']],
      body: report.invoices.map(d => [`${text(d.customer)}\n${text(d.pic)}`, text(d.invoice), `${date(d.date)}\n${date(d.dueDate)}`, rp(d.total), rp(d.paid), rp(d.remaining), d.status]),
      foot: [['TOTAL', `${t.invoices} nota`, '', rp(t.total), rp(t.paid), rp(t.remaining), '']],
      columnStyles: { 0: { cellWidth: 52 }, 1: { cellWidth: 57 }, 2: { cellWidth: 29 }, 3: { halign: 'right' }, 4: { halign: 'right' }, 5: { halign: 'right', fontStyle: 'bold' }, 6: { cellWidth: 18 } },
    })
  }
  const pages = doc.getNumberOfPages()
  for (let page = 1; page <= pages; page++) {
    doc.setPage(page); doc.setFont(bodyFont, 'normal'); doc.setFontSize(8); doc.setTextColor(100, 108, 118)
    if (page > 1) {
      doc.text('LAPORAN PIUTANG', margin, 12)
      doc.text(doc.splitTextToSize(text(bookName), contentWidth / 2)[0], width - margin, 12, { align: 'right' })
      doc.setDrawColor(220, 225, 231); doc.line(margin, 16, width - margin, 16)
    }
    doc.setDrawColor(220, 225, 231); doc.line(margin, height - 13, width - margin, height - 13)
    doc.text(`SKUPY POS | ${stamp}`, margin, height - 8)
    doc.text(`Halaman ${page} / ${pages}`, width - margin, height - 8, { align: 'right' })
  }
  return doc
}

export function downloadReceivablePDF(report, options = {}) {
  const generatedAt = options.generatedAt || new Date()
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit' }).format(generatedAt)
  const name = text(options.bookName || 'Semua-Book').replace(/[^\w-]+/g, '-').slice(0, 60)
  createReceivablePDF(report, { ...options, generatedAt }).save(`Piutang-${name}-${day}.pdf`)
}
