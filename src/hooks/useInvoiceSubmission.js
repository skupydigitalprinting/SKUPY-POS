import { useRef, useState } from 'react'

export function useInvoiceSubmission({ onClose, onReconcile, onRefresh }) {
  const [pending, setPending] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')
  const active = useRef(false)
  const last = useRef(null)
  const outcome = useRef(null)
  async function run(action) {
    if (active.current || !action) return
    active.current = true; setPending(true); setError('')
    try {
      const response = await action()
      const next = response || { ok: false, needsReconciliation: true }
      outcome.current = next; setResult(next)
      if (next.ok === true) onClose?.()
      else setError(next.error || 'Hasil belum terkonfirmasi. Periksa status sebelum mengulangi.')
      return next
    } catch {
      const next = { ok: false, needsReconciliation: true }
      outcome.current = next; setResult(next)
      setError('Hasil belum terkonfirmasi. Periksa status sebelum mengulangi.')
      return next
    } finally { active.current = false; setPending(false) }
  }
  return {
    pending, result, error, setError,
    locked: pending || !!(result?.needsReconciliation || result?.needsRefresh),
    close: () => { if (!active.current) onClose?.() },
    submit: action => {
      if (active.current || outcome.current?.needsReconciliation || outcome.current?.needsRefresh) return
      last.current = action
      return run(action)
    },
    check: onReconcile ? () => run(onReconcile) : undefined,
    retry: () => outcome.current?.unknown && run(last.current),
    refresh: onRefresh ? () => run(() => onRefresh(outcome.current?.committed === true)) : undefined,
  }
}
