import React, { useRef, useState } from 'react'
import { X, Printer, FileText, MessageCircle, Loader2, Download } from 'lucide-react'
import html2canvas from 'html2canvas'
import { formatRupiah, formatDateTime, STATUS_MAP, downloadFile } from '../utils/helpers'
import { STORE_INFO as DEFAULT_STORE } from '../data/dummyData'
import Logo from './Logo'

const PAYMENT_LABEL = {
  cash: 'Cash',
  transfer: 'Bank Transfer',
  qris: 'QRIS',
}

export default function Invoice({ transaction: t, onClose, storeInfo }) {
  const STORE_INFO = storeInfo || DEFAULT_STORE
  const printRef = useRef()
  const [sharing, setSharing] = useState(false)
  const [shareInfo, setShareInfo] = useState(null) // {kind, text}
  const status = STATUS_MAP[t.status]

  const handlePrint = () => {
    const content = printRef.current.innerHTML
    const win = window.open('', '_blank', 'width=900,height=1200')
    if (!win) return
    win.document.write(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Invoice ${t.invoiceNo}</title>
        <meta charset="UTF-8" />
        <style>
          @import url('https://fonts.googleapis.com/css2?family=Syne:wght@500;600;700;800&family=DM+Sans:wght@400;500;600;700&family=Bree+Serif&display=swap');
          * { margin: 0; padding: 0; box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          html, body { background: #f1f1f5; }
          body { font-family: 'DM Sans', sans-serif; color: #1a1a25; padding: 24px; }
          @media print {
            @page { size: A4; margin: 12mm; }
            body { background: #fff; padding: 0; }
          }
        </style>
      </head>
      <body>${content}</body>
      </html>
    `)
    win.document.close()
    win.focus()
    setTimeout(() => { win.print(); win.close() }, 500)
  }

  /** Render the invoice DOM to a JPEG blob via html2canvas. */
  const renderInvoiceJPEG = async () => {
    const node = printRef.current
    if (!node) throw new Error('Invoice belum siap')
    // Capture full document size, not just viewport — prevents clipping
    const canvas = await html2canvas(node, {
      backgroundColor: '#ffffff',
      scale: 2,
      useCORS: true,
      allowTaint: true,
      logging: false,
      width: node.scrollWidth,
      height: node.scrollHeight,
      windowWidth: node.scrollWidth,
      windowHeight: node.scrollHeight,
      scrollX: 0,
      scrollY: 0,
    })
    const blob = await new Promise((resolve) => {
      canvas.toBlob(b => resolve(b), 'image/jpeg', 0.95)
    })
    if (!blob) throw new Error('Gagal membuat JPEG')
    return blob
  }

  /** Share the invoice as JPEG via WhatsApp.
   *  Mobile / supported desktop: navigator.share (file).
   *  Fallback: download + open wa.me with caption.
   */
  const handleWhatsApp = async () => {
    if (sharing) return
    setSharing(true)
    setShareInfo(null)
    try {
      const blob = await renderInvoiceJPEG()
      const filename = `Invoice-${t.invoiceNo}.jpg`
      const file = new File([blob], filename, { type: 'image/jpeg' })

      const caption = `*Invoice ${t.invoiceNo}*\n${STORE_INFO.name}\n\nHalo ${t.customer}, berikut invoice Anda.\nTotal: ${formatRupiah(t.total)}`

      // Try native Web Share API with file (works on most modern mobile + some desktop)
      if (typeof navigator !== 'undefined' && navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({
            files: [file],
            title: `Invoice ${t.invoiceNo}`,
            text: caption,
          })
          setShareInfo({ kind: 'success', text: 'Invoice dikirim 🎉' })
          return
        } catch (e) {
          if (e.name === 'AbortError') {
            setShareInfo(null)
            return
          }
          // fall through to fallback
        }
      }

      // Fallback: download the JPEG and open WhatsApp Web with caption
      downloadFile(filename, blob, 'image/jpeg')
      const message = encodeURIComponent(
        caption + `\n\n_(Silakan lampirkan gambar invoice ${filename} yang baru diunduh ke pesan ini.)_`
      )
      setTimeout(() => {
        window.open(`https://wa.me/?text=${message}`, '_blank', 'noopener,noreferrer')
      }, 200)
      setShareInfo({ kind: 'info', text: 'JPEG diunduh — lampirkan ke WhatsApp yang baru terbuka.' })
    } catch (err) {
      setShareInfo({ kind: 'error', text: err.message || 'Gagal share' })
    } finally {
      setSharing(false)
    }
  }

  /** Download JPEG directly (without opening WhatsApp). */
  const handleDownloadJPG = async () => {
    if (sharing) return
    setSharing(true)
    try {
      const blob = await renderInvoiceJPEG()
      downloadFile(`Invoice-${t.invoiceNo}.jpg`, blob, 'image/jpeg')
      setShareInfo({ kind: 'success', text: 'JPEG berhasil diunduh' })
    } catch (err) {
      setShareInfo({ kind: 'error', text: err.message || 'Gagal' })
    } finally {
      setSharing(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6 animate-fadeIn"
      style={{ background: 'rgba(0,0,0,0.78)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)' }}>
      <div className="animate-scaleIn rounded-2xl overflow-hidden w-full flex flex-col" style={{
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border-strong)',
        boxShadow: '0 24px 80px rgba(0,0,0,0.6)',
        maxWidth: 720,
        maxHeight: '94vh',
      }}>
        {/* Toolbar */}
        <div className="flex items-center justify-between px-4 sm:px-5 py-3.5 flex-shrink-0 gap-2"
          style={{ borderBottom: '1px solid var(--border)' }}>
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0"
              style={{ background: 'rgba(139,92,246,0.15)', border: '1px solid rgba(139,92,246,0.25)' }}>
              <FileText size={16} style={{ color: 'var(--accent-light)' }} />
            </div>
            <div className="min-w-0">
              <div className="font-bold text-sm truncate" style={{ fontFamily: 'Syne', color: 'var(--text-primary)' }}>
                Preview Invoice
              </div>
              <div className="text-xs truncate" style={{ color: 'var(--text-muted)' }}>
                {t.invoiceNo}
              </div>
            </div>
          </div>
          <div className="flex gap-2 flex-shrink-0">
            <button
              onClick={handleWhatsApp}
              disabled={sharing}
              className="flex items-center gap-2 px-3 sm:px-4 py-2 rounded-xl text-xs font-semibold btn-press disabled:opacity-70"
              style={{
                background: 'linear-gradient(135deg, #25d366, #128c7e)',
                color: '#fff',
                fontFamily: 'Syne',
                boxShadow: '0 4px 14px rgba(37,211,102,0.3)',
              }}
              title="Bagikan invoice sebagai JPEG via WhatsApp"
            >
              {sharing ? <Loader2 size={13} className="animate-spin" /> : <MessageCircle size={13} />}
              <span className="hidden sm:inline">{sharing ? 'Memproses...' : 'WhatsApp'}</span>
            </button>
            <button
              onClick={handleDownloadJPG}
              disabled={sharing}
              className="flex items-center justify-center w-9 h-9 rounded-xl btn-press disabled:opacity-70"
              style={{
                background: 'var(--bg-card)',
                color: 'var(--text-secondary)',
                border: '1px solid var(--border)',
              }}
              title="Download JPEG"
            >
              <Download size={14} />
            </button>
            <button
              onClick={handlePrint}
              className="flex items-center gap-2 px-3 sm:px-4 py-2 rounded-xl text-xs font-semibold btn-press"
              style={{
                background: 'linear-gradient(135deg, var(--accent), #6366f1)',
                color: '#fff',
                fontFamily: 'Syne',
                boxShadow: '0 4px 14px rgba(139,92,246,0.3)',
              }}
            >
              <Printer size={13} />
              <span className="hidden sm:inline">Cetak</span>
            </button>
            <button
              onClick={onClose}
              className="w-9 h-9 flex items-center justify-center rounded-xl btn-press flex-shrink-0"
              style={{ background: 'var(--bg-card)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
            >
              <X size={14} />
            </button>
          </div>
        </div>

        {/* Share status banner */}
        {shareInfo && (
          <div className="px-5 py-2 flex-shrink-0 animate-fadeIn"
            style={{
              borderBottom: '1px solid var(--border)',
              background:
                shareInfo.kind === 'success' ? 'rgba(16,217,138,0.08)'
                : shareInfo.kind === 'error' ? 'rgba(255,77,106,0.08)'
                : 'rgba(59,130,246,0.08)',
              color:
                shareInfo.kind === 'success' ? '#10d98a'
                : shareInfo.kind === 'error' ? '#ff4d6a'
                : '#3b82f6',
            }}>
            <div className="text-xs font-semibold" style={{ fontFamily: 'Syne' }}>
              {shareInfo.text}
            </div>
          </div>
        )}

        {/* Invoice Body */}
        <div className="overflow-y-auto p-6 sm:p-8" style={{ background: '#1c1c28' }}>
          <div
            ref={printRef}
            id="invoice-print"
            style={{
              width: 640,
              maxWidth: '100%',
              margin: '0 auto',
              background: '#fff',
              color: '#1a1a25',
              borderRadius: 16,
              // Safe-area padding: extra bottom space to prevent canvas clipping
              padding: '40px 36px 60px',
              fontFamily: 'DM Sans, sans-serif',
              boxShadow: '0 16px 48px rgba(0,0,0,0.25)',
              position: 'relative',
              overflow: 'hidden',
            }}
          >
            {/* Decorative gradient strip */}
            <div style={{
              position: 'absolute',
              top: 0, left: 0, right: 0,
              height: 6,
              background: 'linear-gradient(90deg, #a3ff3a 0%, #06d6f5 35%, #6e3aff 65%, #ff2dbe 100%)',
            }} />

            {/* Header: Logo + Invoice meta */}
            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'flex-start',
              gap: 24,
              flexWrap: 'wrap',
              marginBottom: 28,
              paddingTop: 8,
            }}>
              {/* Logo + Store */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                <Logo size={64} customSrc={STORE_INFO.invoiceLogo} onLight />
                <div>
                  <div style={{
                    fontFamily: 'Syne, sans-serif',
                    fontWeight: 800,
                    fontSize: 22,
                    color: '#0a0a0f',
                    letterSpacing: '-0.02em',
                    lineHeight: 1.1,
                  }}>
                    {STORE_INFO.name}
                  </div>
                  <div style={{ fontSize: 11, color: '#6b6b80', marginTop: 2, fontStyle: 'italic' }}>
                    {STORE_INFO.tagline}
                  </div>
                </div>
              </div>

              {/* Invoice meta */}
              <div style={{ textAlign: 'right' }}>
                <div style={{
                  fontFamily: 'Syne, sans-serif',
                  fontWeight: 800,
                  fontSize: 32,
                  color: '#0a0a0f',
                  letterSpacing: '-0.03em',
                  lineHeight: 1,
                }}>
                  INVOICE
                </div>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#8b5cf6', marginTop: 4, fontFamily: 'DM Sans' }}>
                  #{t.invoiceNo}
                </div>
                <div style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  marginTop: 8,
                  padding: '4px 10px',
                  borderRadius: 999,
                  fontSize: 10,
                  fontWeight: 700,
                  fontFamily: 'Syne',
                  letterSpacing: '0.06em',
                  textTransform: 'uppercase',
                  background: status.color === 'green'
                    ? 'rgba(16,217,138,0.12)'
                    : status.color === 'accent'
                    ? 'rgba(139,92,246,0.12)'
                    : status.color === 'amber'
                    ? 'rgba(245,158,11,0.12)'
                    : 'rgba(59,130,246,0.12)',
                  color: status.hex,
                  border: `1px solid ${status.hex}33`,
                }}>
                  {status.label}
                </div>
              </div>
            </div>

            {/* From / To / Date cards */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr 1fr',
              gap: 12,
              marginBottom: 24,
            }}>
              {/* From */}
              <div style={{
                padding: 14,
                borderRadius: 12,
                background: '#f8f8fb',
                border: '1px solid #ececf2',
              }}>
                <div style={{
                  fontSize: 9,
                  fontWeight: 700,
                  color: '#8888a8',
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                  fontFamily: 'Syne',
                  marginBottom: 6,
                }}>
                  Dari
                </div>
                <div style={{ fontSize: 12, fontWeight: 700, color: '#1a1a25', marginBottom: 4 }}>
                  {STORE_INFO.name}
                </div>
                <div style={{ fontSize: 10, color: '#55556a', lineHeight: 1.5 }}>
                  {STORE_INFO.address}
                </div>
                <div style={{ fontSize: 10, color: '#55556a', marginTop: 4 }}>
                  {STORE_INFO.phone}
                </div>
              </div>

              {/* To */}
              <div style={{
                padding: 14,
                borderRadius: 12,
                background: '#f8f8fb',
                border: '1px solid #ececf2',
              }}>
                <div style={{
                  fontSize: 9,
                  fontWeight: 700,
                  color: '#8888a8',
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                  fontFamily: 'Syne',
                  marginBottom: 6,
                }}>
                  Ditagihkan Kepada
                </div>
                <div style={{ fontSize: 12, fontWeight: 700, color: '#1a1a25', marginBottom: 4 }}>
                  {t.customer}
                </div>
                <div style={{ fontSize: 10, color: '#55556a' }}>
                  Pelanggan
                </div>
              </div>

              {/* Info */}
              <div style={{
                padding: 14,
                borderRadius: 12,
                background: '#f8f8fb',
                border: '1px solid #ececf2',
              }}>
                <div style={{
                  fontSize: 9,
                  fontWeight: 700,
                  color: '#8888a8',
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                  fontFamily: 'Syne',
                  marginBottom: 6,
                }}>
                  Detail
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, marginBottom: 4 }}>
                  <span style={{ color: '#8888a8' }}>Tanggal</span>
                  <span style={{ color: '#1a1a25', fontWeight: 600 }}>
                    {formatDateTime(t.date)}
                  </span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, marginBottom: 4 }}>
                  <span style={{ color: '#8888a8' }}>Pembayaran</span>
                  <span style={{ color: '#1a1a25', fontWeight: 600 }}>
                    {PAYMENT_LABEL[t.paymentMethod]}
                  </span>
                </div>
                {t.cashier && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10 }}>
                    <span style={{ color: '#8888a8' }}>Kasir</span>
                    <span style={{ color: '#1a1a25', fontWeight: 600 }}>
                      {t.cashier}
                    </span>
                  </div>
                )}
              </div>
            </div>

            {/* Items Table */}
            <div style={{
              borderRadius: 12,
              overflow: 'hidden',
              border: '1px solid #ececf2',
              marginBottom: 20,
            }}>
              <div style={{
                display: 'grid',
                gridTemplateColumns: '40px 1fr 60px 110px 110px',
                gap: 10,
                padding: '12px 16px',
                background: '#f8f8fb',
                fontSize: 10,
                fontWeight: 700,
                color: '#55556a',
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                fontFamily: 'Syne',
                borderBottom: '1px solid #ececf2',
              }}>
                <span>#</span>
                <span>Produk</span>
                <span style={{ textAlign: 'center' }}>Qty</span>
                <span style={{ textAlign: 'right' }}>Harga</span>
                <span style={{ textAlign: 'right' }}>Subtotal</span>
              </div>
              {t.items.map((item, i) => (
                <div key={i} style={{
                  display: 'grid',
                  gridTemplateColumns: '40px 1fr 60px 110px 110px',
                  gap: 10,
                  padding: '14px 16px',
                  fontSize: 11,
                  borderBottom: i < t.items.length - 1 ? '1px solid #ececf2' : 'none',
                  alignItems: 'center',
                }}>
                  <span style={{
                    fontSize: 10,
                    fontWeight: 700,
                    color: '#8b5cf6',
                    fontFamily: 'Syne',
                  }}>
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <span style={{ fontWeight: 600, color: '#1a1a25', lineHeight: 1.4 }}>
                    {item.name}
                  </span>
                  <span style={{ textAlign: 'center', color: '#55556a', fontFamily: 'Syne', fontWeight: 600 }}>
                    {item.qty}
                  </span>
                  <span style={{ textAlign: 'right', color: '#55556a' }}>
                    {formatRupiah(item.price)}
                  </span>
                  <span style={{ textAlign: 'right', fontWeight: 700, color: '#1a1a25', fontFamily: 'Syne' }}>
                    {formatRupiah(item.qty * item.price)}
                  </span>
                </div>
              ))}
            </div>

            {/* Bank Info + Summary */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: '1fr 280px',
              gap: 20,
              marginBottom: 24,
            }}>
              {/* Bank Account (Bree Serif) */}
              <div style={{
                padding: 18,
                borderRadius: 12,
                background: 'linear-gradient(135deg, #f8f8fb 0%, #f1f1f5 100%)',
                border: '1px solid #ececf2',
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'center',
              }}>
                <div style={{
                  fontSize: 10,
                  fontWeight: 700,
                  color: '#8888a8',
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                  fontFamily: 'Syne',
                  marginBottom: 10,
                }}>
                  Pembayaran via Transfer
                </div>
                <div style={{
                  background: '#0a0a0f',
                  color: '#fff',
                  padding: '14px 16px',
                  borderRadius: 10,
                  fontFamily: '"Bree Serif", serif',
                }}>
                  <div style={{
                    fontSize: 12,
                    fontWeight: 400,
                    color: '#a3ff3a',
                    letterSpacing: '0.04em',
                    fontFamily: '"Bree Serif", serif',
                  }}>
                    {STORE_INFO.bank.name}
                  </div>
                  <div style={{
                    fontSize: 22,
                    fontWeight: 400,
                    color: '#fff',
                    letterSpacing: 2,
                    fontFamily: '"Bree Serif", serif',
                    margin: '4px 0 2px',
                  }}>
                    {STORE_INFO.bank.number}
                  </div>
                  <div style={{
                    fontSize: 13,
                    color: '#e0e0e8',
                    fontFamily: '"Bree Serif", serif',
                  }}>
                    a.n. {STORE_INFO.bank.holder}
                  </div>
                </div>
              </div>

              {/* Summary */}
              <div style={{
                padding: 16,
                borderRadius: 12,
                background: '#0a0a0f',
                color: '#fff',
                position: 'relative',
                overflow: 'hidden',
              }}>
                <div style={{
                  position: 'absolute',
                  top: -20, right: -20,
                  width: 100, height: 100,
                  borderRadius: '50%',
                  background: 'radial-gradient(circle, rgba(139,92,246,0.3), transparent 70%)',
                }} />
                <div style={{ position: 'relative' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 6 }}>
                    <span style={{ color: '#8888a8' }}>Subtotal</span>
                    <span style={{ color: '#f0f0f8', fontWeight: 600 }}>{formatRupiah(t.subtotal)}</span>
                  </div>
                  {t.discount > 0 && (
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 6 }}>
                      <span style={{ color: '#8888a8' }}>Diskon</span>
                      <span style={{ color: '#ff4d6a', fontWeight: 600 }}>−{formatRupiah(t.discount)}</span>
                    </div>
                  )}
                  <div style={{
                    height: 1,
                    background: 'rgba(255,255,255,0.08)',
                    margin: '10px 0',
                  }} />
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
                    <span style={{
                      fontSize: 11,
                      fontWeight: 700,
                      color: '#a78bfa',
                      textTransform: 'uppercase',
                      letterSpacing: '0.08em',
                      fontFamily: 'Syne',
                    }}>
                      Total
                    </span>
                    <span style={{
                      fontSize: 22,
                      fontWeight: 800,
                      color: '#fff',
                      fontFamily: 'Syne',
                      letterSpacing: '-0.02em',
                    }}>
                      {formatRupiah(t.total)}
                    </span>
                  </div>
                  {t.dp > 0 && t.remaining > 0 && (
                    <>
                      <div style={{
                        height: 1,
                        background: 'rgba(255,255,255,0.08)',
                        margin: '8px 0',
                      }} />
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, marginBottom: 4 }}>
                        <span style={{ color: '#8888a8' }}>DP Dibayar</span>
                        <span style={{ color: '#10d98a', fontWeight: 600 }}>{formatRupiah(t.dp)}</span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
                        <span style={{ color: '#f59e0b', fontWeight: 700, fontFamily: 'Syne' }}>SISA</span>
                        <span style={{ color: '#f59e0b', fontWeight: 700, fontFamily: 'Syne' }}>
                          {formatRupiah(t.remaining)}
                        </span>
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>

            {/* Footer */}
            <div style={{
              borderTop: '2px dashed #ececf2',
              paddingTop: 18,
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'flex-end',
              gap: 16,
              flexWrap: 'wrap',
            }}>
              <div style={{ flex: 1, minWidth: 200 }}>
                <div style={{
                  fontSize: 10,
                  fontWeight: 700,
                  color: '#8888a8',
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                  fontFamily: 'Syne',
                  marginBottom: 6,
                }}>
                  Catatan
                </div>
                <p style={{ fontSize: 10, color: '#55556a', lineHeight: 1.5, marginBottom: 4 }}>
                  Terima kasih atas kepercayaan Anda. Pembayaran dapat dilakukan via transfer ke <strong>{STORE_INFO.bank.name} {STORE_INFO.bank.number}</strong> a.n. <strong>{STORE_INFO.bank.holder}</strong>.
                </p>
                <p style={{ fontSize: 10, color: '#55556a', lineHeight: 1.5 }}>
                  Untuk pertanyaan, hubungi {STORE_INFO.phone}.
                </p>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{
                  fontSize: 9,
                  color: '#8888a8',
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                  fontFamily: 'Syne',
                  marginBottom: 24,
                }}>
                  Tanda Tangan
                </div>
                <div style={{
                  borderTop: '1px solid #c5c5d0',
                  paddingTop: 6,
                  minWidth: 140,
                  fontSize: 10,
                  fontWeight: 600,
                  color: '#1a1a25',
                  fontFamily: 'Syne',
                }}>
                  {STORE_INFO.name}
                </div>
              </div>
            </div>

            {/* Bottom strip */}
            <div style={{
              marginTop: 24,
              textAlign: 'center',
              fontSize: 9,
              color: '#a8a8b8',
              fontFamily: 'Syne',
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
            }}>
              ✦ Powered by {STORE_INFO.name} ✦
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
