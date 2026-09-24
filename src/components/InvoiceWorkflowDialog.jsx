import React, { useEffect, useState } from 'react'
import Modal from './Modal'
import { Button } from './ui'
import InvoiceEditor from './InvoiceEditor'
import InvoiceDeleteDialog from './InvoiceDeleteDialog'
import InvoiceRecovery from './InvoiceRecovery'

export default function InvoiceWorkflowDialog({ invoiceId, mode, workflow, products, onClose, onChanged }) {
  const [state, setState] = useState({ loading: true })
  const [revision, setRevision] = useState(0)
  const [checking, setChecking] = useState(false)
  useEffect(() => {
    let current = true
    setState({ loading: true })
    try {
      if (workflow.pending?.().some(intent => intent.invoiceId === invoiceId)) {
        setState({ recovery: { ok: false, needsReconciliation: true, error: 'Ada permintaan sebelumnya yang perlu diperiksa.' } })
        return () => { current = false }
      }
    } catch { setState({ error: 'Catatan permintaan belum dapat dibaca.' }); return }
    workflow.load(invoiceId).then(result => {
      if (current) setState(result.ok ? { invoice: result.data } : { error: result.error })
    }).catch(() => { if (current) setState({ error: 'Invoice belum dapat dimuat.' }) })
    return () => { current = false }
  }, [workflow, invoiceId, revision])

  const complete = async promise => {
    const result = await promise
    if (result?.ok || result?.committed) onChanged?.()
    return result
  }
  const refresh = async committed => {
    if (committed) {
      const result = await workflow.refresh()
      if (result?.ok) onChanged?.()
      return result
    }
    setRevision(value => value + 1)
    return { ok: false }
  }
  const recover = async action => {
    if (checking) return
    setChecking(true)
    try {
      const result = await complete(action(invoiceId))
      if (result?.ok) onClose()
      else setState({ recovery: result })
    } catch { setState({ recovery: { needsReconciliation: true, error: 'Status belum dapat diperiksa.' } }) }
    finally { setChecking(false) }
  }
  if (state.recovery) return <Modal open title="Permintaan Invoice Tertunda" onClose={onClose} lockClose={checking}>
    <p role="alert" className="mb-3">{state.recovery.error}</p>
    <InvoiceRecovery result={state.recovery} pending={checking}
      onCheck={() => recover(workflow.reconcile)} onRetry={() => recover(workflow.resume)}
      onRefresh={() => state.recovery.committed ? recover(workflow.refresh) : (setState({ loading: true }), setRevision(value => value + 1))} />
  </Modal>
  if (!state.invoice) return <Modal open title={mode === 'edit' ? 'Edit Invoice' : 'Hapus Invoice'} onClose={onClose}>
    {state.loading ? <p role="status">Memuat invoice terbaru...</p> : <>
      <p role="alert">{state.error}</p>
      <Button variant="secondary" onClick={() => setRevision(value => value + 1)}>Coba Lagi</Button>
    </>}
  </Modal>
  const invoice = state.invoice
  const common = { invoice, onClose, onReconcile: () => complete(workflow.reconcile(invoiceId)), onRefresh: refresh }
  return mode === 'edit'
    ? <InvoiceEditor key={`${invoice.id}:${invoice.version}:${revision}`} {...common} products={products}
        onSave={payload => complete(workflow.change(invoice.id, invoice.version, 'edit', payload))} />
    : <InvoiceDeleteDialog key={`${invoice.id}:${invoice.version}:${revision}`} {...common}
        onConfirm={(kind, payload) => complete(workflow.change(invoice.id, invoice.version, kind, payload))} />
}
