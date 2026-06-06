import React, { createContext, useCallback, useContext, useRef, useState } from 'react'
import { AlertTriangle, X } from 'lucide-react'

const ConfirmContext = createContext(null)

// Provider konfirmasi global berbasis Promise.
//   const confirm = useConfirm()
//   if (await confirm({ title, message, confirmLabel })) { ...hapus... }
export function ConfirmProvider({ children }) {
  const [state, setState] = useState(null) // { title, message, confirmLabel, cancelLabel, danger }
  const resolver = useRef(null)

  const confirm = useCallback((opts = {}) => {
    return new Promise((resolve) => {
      resolver.current = resolve
      setState({
        title: opts.title || 'Yakin ingin menghapus data ini?',
        message: opts.message || 'Data akan disembunyikan dari laporan dan tidak dihitung lagi. Tindakan ini bisa memengaruhi dashboard.',
        confirmLabel: opts.confirmLabel || 'Ya, Hapus',
        cancelLabel: opts.cancelLabel || 'Batal',
        danger: opts.danger !== false,
      })
    })
  }, [])

  const close = useCallback((result) => {
    setState(null)
    if (resolver.current) { resolver.current(result); resolver.current = null }
  }, [])

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {state && (
        <div onClick={() => close(false)}
          style={{ position: 'fixed', inset: 0, zIndex: 10000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, background: 'rgba(8,8,14,0.6)', backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)', paddingBottom: 'max(16px, env(safe-area-inset-bottom))' }}>
          <div onClick={e => e.stopPropagation()} className="animate-slideUp"
            style={{ width: '100%', maxWidth: 400, background: 'rgba(24,24,34,0.98)', border: '1px solid var(--border-strong)', borderRadius: 20, padding: 22, boxShadow: '0 24px 70px rgba(0,0,0,0.6)' }}>
            <div className="flex items-start gap-3">
              <div style={{ width: 42, height: 42, borderRadius: 12, flexShrink: 0, background: state.danger ? 'rgba(255,77,106,0.12)' : 'rgba(245,158,11,0.12)', border: `1px solid ${state.danger ? 'rgba(255,77,106,0.4)' : 'rgba(245,158,11,0.4)'}`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <AlertTriangle size={20} style={{ color: state.danger ? '#ff4d6a' : '#f59e0b' }} />
              </div>
              <div className="min-w-0 flex-1">
                <h3 className="font-bold text-sm" style={{ fontFamily: 'Syne', color: 'var(--text-primary)' }}>{state.title}</h3>
                <p className="text-xs mt-1.5 leading-relaxed" style={{ color: 'var(--text-secondary)' }}>{state.message}</p>
              </div>
              <button onClick={() => close(false)} style={{ color: 'var(--text-muted)', flexShrink: 0 }}><X size={16} /></button>
            </div>
            <div className="flex gap-2.5 mt-5">
              <button onClick={() => close(false)} className="flex-1 py-2.5 rounded-xl text-sm font-semibold btn-press"
                style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', color: 'var(--text-secondary)', fontFamily: 'Syne' }}>
                {state.cancelLabel}
              </button>
              <button onClick={() => close(true)} className="flex-1 py-2.5 rounded-xl text-sm font-bold btn-press"
                style={{ background: state.danger ? 'linear-gradient(135deg,#ff4d6a,#e11d48)' : 'linear-gradient(135deg, var(--accent), #6366f1)', color: '#fff', fontFamily: 'Syne' }}>
                {state.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  )
}

export function useConfirm() {
  const ctx = useContext(ConfirmContext)
  // fallback: window.confirm bila di luar provider
  if (!ctx) return async (opts = {}) => window.confirm(opts.title || 'Hapus data ini?')
  return ctx
}
