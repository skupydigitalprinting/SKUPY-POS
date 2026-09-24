import React, { useEffect, useRef, useState } from 'react'
import { RefreshCw, RotateCcw, X } from 'lucide-react'

export default function CheckoutRecoveryPanel({ pending, workflow }) {
  const [result, setResult] = useState(null), [busy, setBusy] = useState(false)
  const active = useRef(false), mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => { if (pending) setResult(null) }, [pending?.operationId])
  async function run(action) {
    if (active.current) return
    active.current = true; setBusy(true)
    try { const value = await action(); if (mounted.current) setResult(value) }
    catch { if (mounted.current) setResult({ ok: false, error: 'Status checkout belum dapat diperiksa.' }) }
    finally { active.current = false; if (mounted.current) setBusy(false) }
  }
  if (!workflow || (!pending && !result?.ok)) return null
  return <section aria-label="Pemulihan checkout" className="shrink-0 px-4 py-2 flex flex-wrap items-center gap-2"
    style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', minWidth: 0 }}>
    {result?.ok ? <>
      <p role="status" className="text-sm" style={{ overflowWrap: 'anywhere' }}>{result.abandoned
        ? 'Checkout tertunda dibatalkan. Tidak ada invoice yang dibuat.'
        : `Invoice ${result.data.invoiceNo} sudah tersimpan.`}</p>
      <button type="button" aria-label="Tutup pemberitahuan checkout" title="Tutup" onClick={() => setResult(null)} className="p-2"><X size={16} /></button>
    </> : <>
      <h2 className="text-sm font-semibold">Checkout belum terkonfirmasi</h2>
      <button type="button" className="btn-secondary flex items-center gap-2 px-3 py-2 text-sm" disabled={busy}
        onClick={() => run(workflow.reconcile)}><RefreshCw size={16} className={busy ? 'animate-spin' : ''} />Periksa Checkout</button>
      {result?.unknown && <button type="button" className="btn-secondary flex items-center gap-2 px-3 py-2 text-sm" disabled={busy}
        onClick={() => run(workflow.resume)}><RotateCcw size={16} />Kirim Ulang Checkout yang Sama</button>}
      {result && workflow.abandon && <button type="button" className="btn-secondary flex items-center gap-2 px-3 py-2 text-sm" disabled={busy}
        onClick={() => run(workflow.abandon)}><X size={16} />Batalkan Checkout Tertunda</button>}
      {result?.error && <p role="alert" className="w-full text-sm" style={{ overflowWrap: 'anywhere' }}>{result.error}</p>}
    </>}
  </section>
}
