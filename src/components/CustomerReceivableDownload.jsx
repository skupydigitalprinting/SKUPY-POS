import React, { useEffect, useRef, useState } from 'react'
import { Download, Loader2 } from 'lucide-react'
import { Button } from './ui'
import { useToast } from './Toast'
import { buildCustomerReceivableReport } from '../utils/customerReceivableReport'

export default function CustomerReceivableDownload({ invoices, customer, admins, getDebtPayments, getReceivablePayments, storeInfo, bookName, accountScope }) {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const mounted = useRef(true)
  const latest = useRef(null)
  const version = JSON.stringify([invoices, customer, bookName, accountScope])
  latest.current = version
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  const download = async () => {
    if (pending.current) return
    pending.current = true; setBusy(true)
    const current = () => mounted.current && latest.current === version
    try {
      const report = await buildCustomerReceivableReport({ invoices, customer, admins, getDebtPayments, getReceivablePayments })
      if (!current()) return
      const options = { storeName: storeInfo?.name || 'SKUPY', bookName, accountScope, generatedAt: new Date() }
      const { downloadReceivablePDF, loadReceivablePdfFont } = await import('../utils/receivablePdf')
      options.fontData = await loadReceivablePdfFont(report, options)
      if (current()) downloadReceivablePDF(report, options)
    } catch (error) {
      if (current()) toast.error(error.message || 'PDF customer gagal dibuat. Silakan coba lagi.')
    } finally {
      pending.current = false
      if (mounted.current) setBusy(false)
    }
  }
  return <Button variant="secondary" onClick={download} disabled={busy || !invoices.length}
    aria-label="Unduh PDF piutang customer" title="Unduh hutang dan riwayat pembayaran customer ini" className="shrink-0">
    {busy ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
    {busy ? 'Menyiapkan PDF...' : 'Unduh PDF'}
  </Button>
}
