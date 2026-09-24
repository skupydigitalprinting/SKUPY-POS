import React from 'react'
import { RefreshCw } from 'lucide-react'
import { Button } from './ui'

export default function InvoiceRecovery({ result, pending, onCheck, onRetry, onRefresh }) {
  if (!result) return null
  return <div className="flex gap-2 flex-wrap">
    {result.needsReconciliation && onCheck && <Button type="button" variant="secondary" disabled={pending} onClick={onCheck}>
      <RefreshCw size={16} />Periksa Status
    </Button>}
    {result.unknown && onRetry && <Button type="button" variant="secondary" disabled={pending} onClick={onRetry}>Ulangi Permintaan yang Sama</Button>}
    {result.needsRefresh && onRefresh && <Button type="button" variant="secondary" disabled={pending} onClick={onRefresh}>
      <RefreshCw size={16} />{result.committed ? 'Muat Hasil Tersimpan' : 'Muat Invoice Terbaru'}
    </Button>}
  </div>
}
