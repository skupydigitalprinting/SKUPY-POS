import React from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import { isModuleLoadError } from '../utils/chunkRecovery'

/**
 * Error boundary — catches JS errors in any child component subtree
 * and shows a fallback UI instead of crashing the whole app.
 *
 * Usage:
 *   <ErrorBoundary fallback={<CustomFallback/>}> <YourPage/> </ErrorBoundary>
 *   <ErrorBoundary> <YourPage/> </ErrorBoundary>   (uses default fallback)
 */
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error }
  }

  componentDidCatch(error, info) {
    // Log for devtools / observability
    // eslint-disable-next-line no-console
    console.error('[ErrorBoundary]', error, info?.componentStack)
  }

  reset = () => this.setState({ hasError: false, error: null })

  render() {
    if (!this.state.hasError) return this.props.children
    if (this.props.fallback) {
      return typeof this.props.fallback === 'function'
        ? this.props.fallback({ error: this.state.error, reset: this.reset })
        : this.props.fallback
    }
    return <DefaultFallback error={this.state.error} reset={this.reset} title={this.props.title} />
  }
}

function DefaultFallback({ error, reset, title = 'Halaman gagal dimuat' }) {
  const moduleLoadFailed = isModuleLoadError(error)
  const reload = () => window.location.reload()
  return (
    <div className="flex-1 overflow-y-auto mesh-bg">
      <div className="p-6 sm:p-8 max-w-2xl mx-auto">
        <div
          className="rounded-2xl p-6 sm:p-8 animate-fadeIn"
          style={{
            background: 'rgba(28,28,40,0.85)',
            backdropFilter: 'blur(20px)',
            border: '1px solid rgba(255,77,106,0.25)',
            boxShadow: '0 24px 80px rgba(0,0,0,0.4)',
          }}
        >
          <div
            className="w-14 h-14 rounded-2xl flex items-center justify-center mb-4"
            style={{
              background: 'rgba(255,77,106,0.12)',
              border: '1px solid rgba(255,77,106,0.3)',
            }}
          >
            <AlertTriangle size={24} style={{ color: 'var(--red)' }} />
          </div>
          <h2
            className="font-bold text-lg sm:text-xl mb-2"
            style={{ fontFamily: 'Syne', color: 'var(--text-primary)' }}
          >
            {title}
          </h2>
          <p className="text-sm mb-4" style={{ color: 'var(--text-secondary)' }}>
            {moduleLoadFailed
              ? 'Kode halaman tidak berhasil dimuat. Tab ini mungkin masih memakai versi lama setelah pembaruan, atau koneksi sedang terganggu.'
              : 'Terjadi kesalahan saat menampilkan halaman ini. Silakan coba lagi.'}
          </p>
          {moduleLoadFailed && (
            <p className="text-sm mb-4" style={{ color: 'var(--text-secondary)' }}>
              Muat versi terbaru untuk melanjutkan. Isian yang belum disimpan di tab ini akan hilang saat halaman dimuat ulang.
            </p>
          )}
          {error && (
            <details className="mb-5 text-sm" style={{ color: 'var(--text-secondary)' }}>
              <summary className="cursor-pointer mb-2">Detail kesalahan</summary>
              <pre
                className="text-xs p-3 rounded-xl overflow-x-auto"
                style={{
                  background: 'rgba(0,0,0,0.3)',
                  color: '#ff4d6a',
                  border: '1px solid rgba(255,77,106,0.15)',
                  fontFamily: 'DM Mono, monospace',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
                {String(error?.message || error || 'Unknown error')}
              </pre>
            </details>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              onClick={moduleLoadFailed ? reload : reset}
              className="flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl text-sm font-bold btn-press"
              style={{
                background: 'linear-gradient(135deg, var(--accent), #6366f1)',
                color: '#fff',
                boxShadow: '0 4px 16px rgba(139,92,246,0.35)',
                fontFamily: 'Syne',
              }}
            >
              <RefreshCw size={14} className="shrink-0" /> {moduleLoadFailed ? 'Muat Versi Terbaru' : 'Coba Lagi'}
            </button>
            {!moduleLoadFailed && (
              <button
                onClick={reload}
                className="flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl text-sm font-bold btn-press"
                style={{
                  background: 'var(--bg-card)',
                  color: 'var(--text-secondary)',
                  border: '1px solid var(--border)',
                  fontFamily: 'Syne',
                }}
              >
                Reload Halaman
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
