import React, { createContext, useContext, useState, useCallback, useRef } from 'react'
import { Loader2 } from 'lucide-react'
import Invoice from './Invoice'

const InvoicePreviewCtx = createContext({ openInvoice: () => {} })
export const useInvoicePreview = () => useContext(InvoicePreviewCtx)

/**
 * Provider preview invoice global.
 *   openInvoice(ref) → ref boleh objek transaksi lengkap ATAU nomor invoice (string).
 * Jika string, dipakai `resolve(invoiceNo)` (async) untuk ambil transaksi dari store
 * (cari lokal, fallback fetch). Tidak membuat invoice baru — hanya PREVIEW (baca).
 */
export function InvoicePreviewProvider({ children, resolve, storeInfo }) {
  const [tx, setTx] = useState(null)
  const [loading, setLoading] = useState(false)
  const reqId = useRef(0)

  const openInvoice = useCallback(async (ref) => {
    if (!ref) return
    if (typeof ref === 'object') { setTx(ref); return }
    const id = ++reqId.current
    setLoading(true)
    try {
      const t = resolve ? await resolve(ref) : null
      if (id !== reqId.current) return // permintaan lebih baru menang
      setTx(t || null)
    } finally {
      if (id === reqId.current) setLoading(false)
    }
  }, [resolve])

  const close = useCallback(() => { reqId.current++; setTx(null); setLoading(false) }, [])

  return (
    <InvoicePreviewCtx.Provider value={{ openInvoice }}>
      {children}
      {loading && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)' }}>
          <div className="flex items-center gap-2 px-4 py-3 rounded-xl" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}>
            <Loader2 size={16} className="animate-spin" style={{ color: 'var(--accent-light)' }} />
            <span className="text-xs font-semibold" style={{ color: 'var(--text-secondary)', fontFamily: 'Syne' }}>Memuat invoice…</span>
          </div>
        </div>
      )}
      {tx && <Invoice transaction={tx} storeInfo={storeInfo} onClose={close} />}
    </InvoicePreviewCtx.Provider>
  )
}
