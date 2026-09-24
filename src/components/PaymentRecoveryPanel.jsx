import React, { useEffect, useRef, useState } from 'react'
import { RefreshCw, RotateCcw } from 'lucide-react'

function PaymentRecoveryItem({ item, workflow }) {
  const [result, setResult] = useState(null)
  const [busy, setBusy] = useState(false)
  const active = useRef(false), mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  async function run(action) {
    if (active.current) return
    active.current = true; setBusy(true)
    try {
      const value = await action()
      if (mounted.current) setResult(value)
    } catch {
      if (mounted.current) setResult({ ok: false, error: 'Status pembayaran belum dapat diperiksa.' })
    } finally { active.current = false; if (mounted.current) setBusy(false) }
  }
  if (result?.ok) return null
  return <div className="flex flex-wrap items-center gap-2 py-2" style={{ borderBottom: '1px solid var(--border)' }}>
    <span className="text-sm font-semibold" style={{ overflowWrap: 'anywhere', minWidth: 0 }}>{item.invoiceNo}</span>
    <button type="button" className="btn-secondary flex items-center gap-2 px-3 py-2 text-sm" disabled={busy}
      onClick={() => run(() => workflow.reconcile(item.invoiceNo))}>
      <RefreshCw size={16} className={busy ? 'animate-spin' : ''} />Periksa Status
    </button>
    {result?.unknown && <button type="button" className="btn-secondary flex items-center gap-2 px-3 py-2 text-sm" disabled={busy}
      onClick={() => run(() => workflow.resume(item.invoiceNo))}>
      <RotateCcw size={16} />Ulangi Permintaan yang Sama
    </button>}
    {result?.needsRefresh && <button type="button" className="btn-secondary flex items-center gap-2 px-3 py-2 text-sm" disabled={busy}
      onClick={() => run(() => workflow.refresh())}><RefreshCw size={16} />Muat Hasil Tersimpan</button>}
    {result?.error && <p role="alert" className="w-full text-sm" style={{ overflowWrap: 'anywhere' }}>{result.error}</p>}
  </div>
}

export default function PaymentRecoveryPanel({ pending = [], workflow, refreshRequired = false }) {
  if (!workflow || (!pending.length && !refreshRequired)) return null
  return <section aria-label="Pembayaran belum terkonfirmasi" className="shrink-0 px-4 py-2"
    style={{ color: 'var(--text-primary)', background: 'var(--bg-secondary)', maxHeight: '30vh', overflowY: 'auto', minWidth: 0 }}>
    <h2 className="text-sm font-semibold">Pembayaran belum terkonfirmasi</h2>
    {refreshRequired && <button type="button" className="btn-secondary flex items-center gap-2 px-3 py-2 text-sm"
      onClick={() => workflow.refresh()}><RefreshCw size={16} />Muat Hasil Tersimpan</button>}
    {pending.map(item => <PaymentRecoveryItem key={item.operationId} item={item} workflow={workflow} />)}
  </section>
}
