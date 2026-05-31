import React, { useRef, useState, useEffect } from 'react'
import { X, Printer, FileText, MessageCircle, Loader2, Download } from 'lucide-react'
import html2canvas from 'html2canvas'
import { formatRupiah, formatDateTime, STATUS_MAP, downloadFile } from '../utils/helpers'
import { STORE_INFO as DEFAULT_STORE } from '../data/dummyData'
import { buildWaLink, normalizePhone, isValidWA } from '../utils/whatsapp'
import { uploadInvoiceImage } from '../lib/supabase'
import Logo from './Logo'

const PAYMENT_LABEL = {
  cash: 'Cash', transfer: 'Bank Transfer', qris: 'QRIS', hutang: 'Hutang / Tempo',
}

export default function Invoice({ transaction: t, onClose, storeInfo, autoShare = false }) {
  const STORE_INFO = storeInfo || DEFAULT_STORE
  const printRef = useRef(null)
  const [sharing, setSharing] = useState(false)
  const [shareInfo, setShareInfo] = useState(null)
  const autoTriggered = useRef(false)
  const status = STATUS_MAP[t.status]
  const isHutang = t.paymentMethod === 'hutang' || (t.remaining || 0) > 0

  /** Render the invoice DOM to a PNG blob — fully captured (no clipping). */
  const renderInvoicePNG = async () => {
    const node = printRef.current
    if (!node) throw new Error('Invoice belum siap')

    // Wait for fonts to load before capture (prevents reflow during render)
    try { if (document.fonts?.ready) await document.fonts.ready } catch {}
    // Two RAFs to ensure layout is stable
    await new Promise(r => requestAnimationFrame(r))
    await new Promise(r => requestAnimationFrame(r))

    // Use the actual rendered box — offsetWidth/Height includes padding
    const width = node.offsetWidth
    const height = node.offsetHeight

    const canvas = await html2canvas(node, {
      backgroundColor: '#ffffff',
      scale: 3,                 // high-res 3x for crisp PNG
      useCORS: true,
      allowTaint: true,
      logging: false,
      width,
      height,
      windowWidth: Math.max(width, document.documentElement.scrollWidth),
      windowHeight: Math.max(height, document.documentElement.scrollHeight),
      scrollX: 0,
      scrollY: -window.scrollY,
      onclone: (clonedDoc) => {
        // Ensure cloned node has fixed width + visible overflow for full capture
        const clone = clonedDoc.getElementById('invoice-print')
        if (clone) {
          clone.style.width = width + 'px'
          clone.style.maxWidth = 'none'
          clone.style.overflow = 'visible'
          clone.style.boxShadow = 'none'
          clone.style.margin = '0'
        }
      },
    })

    const blob = await new Promise((resolve) => {
      canvas.toBlob(b => resolve(b), 'image/png')
    })
    if (!blob) throw new Error('Gagal membuat PNG')
    return blob
  }

  const handlePrint = () => {
    const content = printRef.current?.outerHTML || ''
    const win = window.open('', '_blank', 'width=900,height=1200')
    if (!win) return
    win.document.write(`
      <!DOCTYPE html>
      <html><head><title>Invoice ${t.invoiceNo}</title><meta charset="UTF-8" />
      <style>
        @import url('https://fonts.googleapis.com/css2?family=Syne:wght@500;600;700;800&family=DM+Sans:wght@400;500;600;700&family=Bree+Serif&display=swap');
        * { margin: 0; padding: 0; box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        html, body { background: #f1f1f5; }
        body { font-family: 'DM Sans', sans-serif; color: #1a1a25; padding: 24px; display: flex; justify-content: center; }
        @media print { @page { size: A4; margin: 12mm; } body { background: #fff; padding: 0; } }
      </style></head><body>${content}</body></html>
    `)
    win.document.close()
    win.focus()
    setTimeout(() => { win.print(); win.close() }, 600)
  }

  /**
   * Send invoice via WhatsApp.
   *
   * Flow (final, sesuai spec):
   *   1. Generate invoice PNG dari DOM (html2canvas).
   *   2. Upload PNG ke Supabase Storage bucket `invoices`.
   *   3. Dapatkan public URL.
   *   4. Buka WhatsApp via https://wa.me/{nomor} dengan pesan auto-fill yang
   *      berisi URL publik invoice + total.
   *
   * Yang TIDAK dilakukan:
   *   - ❌ Download PNG ke perangkat
   *   - ❌ navigator.share() / Web Share API
   *   - ❌ Share dialog OS (AirDrop / Mail / Messages)
   *
   * Support: Android, iPhone, WhatsApp Desktop, WhatsApp Web.
   */
  const handleWhatsApp = async () => {
    if (sharing) return

    setSharing(true)
    setShareInfo({ kind: 'info', text: 'Membuat invoice PNG...' })

    const phone = t.customerPhone || ''
    const hasValidPhone = !!phone && isValidWA(phone)

    try {
      // 1. Generate PNG
      const blob = await renderInvoicePNG()

      // 2-3. Upload ke Supabase Storage → public URL (BLOCKING — invoice URL wajib)
      setShareInfo({ kind: 'info', text: 'Mengunggah invoice ke storage...' })
      let publicUrl = ''
      try {
        publicUrl = await uploadInvoiceImage(blob, t.invoiceNo)
      } catch (uploadErr) {
        // eslint-disable-next-line no-console
        console.error('[Invoice] Upload gagal:', uploadErr)
        setShareInfo({
          kind: 'error',
          text: `Gagal upload invoice ke storage: ${uploadErr.message || uploadErr}. Pastikan bucket "invoices" sudah dibuat di Supabase Storage.`,
        })
        return
      }

      // 4. Build pesan otomatis (sesuai spec)
      const customerLabel = (!t.customer || /^umum$/i.test(String(t.customer).trim()))
        ? 'Pelanggan Umum' : t.customer
      const message = [
        `Halo ${customerLabel},`,
        `Berikut invoice Anda:`,
        publicUrl,
        `Total: ${formatRupiah(t.total)}`,
        `Terima kasih.`,
      ].join('\n')

      // 5. Buka WhatsApp via wa.me
      const phonePart = hasValidPhone ? normalizePhone(phone) : ''
      const waUrl = `https://wa.me/${phonePart}?text=${encodeURIComponent(message)}`

      const win = window.open(waUrl, '_blank', 'noopener,noreferrer')
      if (!win || win.closed || typeof win.closed === 'undefined') {
        // Popup-blocker → same-tab navigation (works on all platforms)
        window.location.href = waUrl
        return
      }

      setShareInfo({
        kind: 'success',
        text: hasValidPhone
          ? 'WhatsApp telah dibuka untuk customer. Silakan kirim invoice.'
          : 'WhatsApp telah dibuka. Silakan pilih kontak tujuan.',
      })
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[Invoice] WhatsApp flow error:', err)
      setShareInfo({
        kind: 'error',
        text: `Gagal kirim invoice: ${err?.message || 'unknown error'}`,
      })
    } finally {
      setSharing(false)
    }
  }

  // Auto-trigger WhatsApp when component mounts with autoShare=true
  useEffect(() => {
    if (autoShare && !autoTriggered.current) {
      autoTriggered.current = true
      const id = setTimeout(() => handleWhatsApp(), 300)
      return () => clearTimeout(id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoShare])

  const handleDownloadPNG = async () => {
    if (sharing) return
    setSharing(true)
    try {
      const blob = await renderInvoicePNG()
      downloadFile(`Invoice-${t.invoiceNo}.png`, blob, 'image/png')
      setShareInfo({ kind: 'success', text: 'PNG berhasil diunduh' })
    } catch (err) {
      setShareInfo({ kind: 'error', text: err.message || 'Gagal' })
    } finally {
      setSharing(false)
    }
  }

  // Status badge color
  const badgeBg = status?.color === 'green' ? 'rgba(16,217,138,0.12)'
    : status?.color === 'accent' ? 'rgba(139,92,246,0.12)'
    : status?.color === 'amber' ? 'rgba(245,158,11,0.12)'
    : 'rgba(59,130,246,0.12)'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6 animate-fadeIn"
      style={{ background: 'rgba(0,0,0,0.78)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)' }}>
      <div className="animate-scaleIn rounded-2xl overflow-hidden w-full flex flex-col" style={{
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border-strong)',
        boxShadow: '0 24px 80px rgba(0,0,0,0.6)',
        maxWidth: 760, maxHeight: '94vh',
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
            <button onClick={handleWhatsApp} disabled={sharing}
              className="flex items-center gap-2 px-3 sm:px-4 py-2 rounded-xl text-xs font-semibold btn-press disabled:opacity-70"
              style={{
                background: 'linear-gradient(135deg, #25d366, #128c7e)',
                color: '#fff', fontFamily: 'Syne',
                boxShadow: '0 4px 14px rgba(37,211,102,0.3)',
              }}
              title="Bagikan invoice PNG via WhatsApp">
              {sharing ? <Loader2 size={13} className="animate-spin" /> : <MessageCircle size={13} />}
              <span className="hidden sm:inline">{sharing ? 'Memproses...' : 'WhatsApp'}</span>
            </button>
            <button onClick={handleDownloadPNG} disabled={sharing}
              className="flex items-center justify-center w-9 h-9 rounded-xl btn-press disabled:opacity-70"
              style={{ background: 'var(--bg-card)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
              title="Download PNG">
              <Download size={14} />
            </button>
            <button onClick={handlePrint}
              className="flex items-center gap-2 px-3 sm:px-4 py-2 rounded-xl text-xs font-semibold btn-press"
              style={{
                background: 'linear-gradient(135deg, var(--accent), #6366f1)',
                color: '#fff', fontFamily: 'Syne',
                boxShadow: '0 4px 14px rgba(139,92,246,0.3)',
              }}>
              <Printer size={13} />
              <span className="hidden sm:inline">Cetak</span>
            </button>
            <button onClick={onClose}
              className="w-9 h-9 flex items-center justify-center rounded-xl btn-press flex-shrink-0"
              style={{ background: 'var(--bg-card)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}>
              <X size={14} />
            </button>
          </div>
        </div>

        {/* Share status */}
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
            <div className="text-xs font-semibold" style={{ fontFamily: 'Syne' }}>{shareInfo.text}</div>
          </div>
        )}

        {/* Invoice render area */}
        <div
          className="overflow-auto p-4 sm:p-8 flex justify-center"
          style={{
            background: '#1c1c28',
            // Allow horizontal scroll on mobile so user can swipe the desktop-sized invoice
            WebkitOverflowScrolling: 'touch',
          }}
        >
          {/* IMPORTANT: this is the node captured by html2canvas.
              No `overflow: hidden`, no absolute decorations, plenty of padding. */}
          <div
            ref={printRef}
            id="invoice-print"
            style={{
              // FIXED desktop width — invoice must look identical on PC, Android, iPhone
              width: 720,
              minWidth: 720,
              background: '#ffffff',
              color: '#1a1a25',
              borderRadius: 16,
              padding: '0 40px 64px',
              fontFamily: 'DM Sans, sans-serif',
              boxShadow: '0 16px 48px rgba(0,0,0,0.25)',
              position: 'relative',
              boxSizing: 'border-box',
              wordBreak: 'normal',
              overflowWrap: 'break-word',
              flexShrink: 0,
            }}
          >
            {/* Top gradient strip — always desktop */}
            <div style={{
              height: 8,
              margin: '0 -40px 36px',
              background: 'linear-gradient(90deg, #a3ff3a 0%, #06d6f5 35%, #6e3aff 65%, #ff2dbe 100%)',
              borderTopLeftRadius: 16,
              borderTopRightRadius: 16,
            }} />

            {/* Header: Logo + Invoice meta — always desktop layout */}
            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'flex-start',
              gap: 24,
              marginBottom: 32,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                <Logo size={68} customSrc={STORE_INFO.invoiceLogo} onLight />
                <div>
                  <div style={{
                    fontFamily: 'Syne, sans-serif', fontWeight: 800, fontSize: 24,
                    color: '#0a0a0f', letterSpacing: '-0.02em', lineHeight: 1.1,
                  }}>
                    {STORE_INFO.name}
                  </div>
                  <div style={{ fontSize: 12, color: '#6b6b80', marginTop: 3, fontStyle: 'italic' }}>
                    {STORE_INFO.tagline}
                  </div>
                </div>
              </div>

              <div style={{ textAlign: 'right' }}>
                <div style={{
                  fontFamily: 'Syne, sans-serif', fontWeight: 800, fontSize: 36,
                  color: '#0a0a0f', letterSpacing: '-0.03em', lineHeight: 1,
                }}>
                  INVOICE
                </div>
                <div style={{
                  fontSize: 13, fontWeight: 700, color: '#8b5cf6',
                  marginTop: 6, fontFamily: 'DM Sans',
                }}>
                  #{t.invoiceNo}
                </div>
                <div style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  marginTop: 8, padding: '5px 12px', borderRadius: 999,
                  fontSize: 10, fontWeight: 700, fontFamily: 'Syne',
                  letterSpacing: '0.06em', textTransform: 'uppercase',
                  background: badgeBg, color: status?.hex || '#3b82f6',
                  border: `1px solid ${(status?.hex || '#3b82f6')}33`,
                }}>
                  {status?.label || t.status}
                </div>
              </div>
            </div>

            {/* From / To / Date cards — always 3 columns */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr 1fr',
              gap: 14,
              marginBottom: 28,
            }}>
              <div style={{ padding: 16, borderRadius: 12, background: '#f8f8fb', border: '1px solid #ececf2' }}>
                <div style={infoLabel}>Dari</div>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#1a1a25', marginBottom: 6 }}>
                  {STORE_INFO.name}
                </div>
                <div style={{ fontSize: 10.5, color: '#55556a', lineHeight: 1.5 }}>
                  {STORE_INFO.address}
                </div>
                <div style={{ fontSize: 10.5, color: '#55556a', marginTop: 6 }}>
                  {STORE_INFO.phone}
                </div>
              </div>

              <div style={{ padding: 16, borderRadius: 12, background: '#f8f8fb', border: '1px solid #ececf2' }}>
                <div style={infoLabel}>Ditagihkan Kepada</div>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#1a1a25', marginBottom: 6 }}>
                  {(!t.customer || /^umum$/i.test(String(t.customer).trim())) ? 'Pelanggan Umum' : t.customer}
                </div>
                {t.customerPhone && (
                  <div style={{ fontSize: 10.5, color: '#55556a' }}>{t.customerPhone}</div>
                )}
                <div style={{ fontSize: 10.5, color: '#55556a', marginTop: 6 }}>Pelanggan</div>
              </div>

              <div style={{ padding: 16, borderRadius: 12, background: '#f8f8fb', border: '1px solid #ececf2' }}>
                <div style={infoLabel}>Detail</div>
                <DetailRow k="Tanggal" v={formatDateTime(t.date)} />
                <DetailRow k="Pembayaran" v={PAYMENT_LABEL[t.paymentMethod] || t.paymentMethod} />
                {t.cashier && <DetailRow k="Kasir" v={t.cashier} />}
              </div>
            </div>

            {/* Items table */}
            <div style={{
              borderRadius: 12,
              overflow: 'visible',
              border: '1px solid #ececf2',
              marginBottom: 24,
              background: '#fff',
            }}>
              {/* Header — always 5 columns desktop */}
              <div style={{
                display: 'grid',
                gridTemplateColumns: '40px 1fr 60px 120px 130px',
                gap: 12,
                padding: '14px 18px',
                background: '#f8f8fb',
                fontSize: 11,
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
              {(t.items || []).map((item, i) => (
                <div key={i} style={{
                  display: 'grid',
                  gridTemplateColumns: '40px 1fr 60px 120px 130px',
                  gap: 12,
                  padding: '16px 18px',
                  fontSize: 12,
                  borderBottom: i < t.items.length - 1 ? '1px solid #ececf2' : 'none',
                  alignItems: 'center',
                }}>
                  <span style={{
                    fontSize: 11, fontWeight: 700, color: '#8b5cf6', fontFamily: 'Syne',
                  }}>
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <span style={{
                    fontWeight: 600, color: '#1a1a25', lineHeight: 1.4,
                    // Keep words intact, never per-letter break
                    wordBreak: 'normal',
                    overflowWrap: 'break-word',
                    whiteSpace: 'normal',
                  }}>
                    {item.name}
                  </span>
                  <span style={{ textAlign: 'center', color: '#55556a', fontFamily: 'Syne', fontWeight: 600 }}>
                    {item.qty}
                  </span>
                  <span style={{ textAlign: 'right', color: '#55556a', whiteSpace: 'nowrap' }}>
                    {formatRupiah(item.price)}
                  </span>
                  <span style={{
                    textAlign: 'right', fontWeight: 700, color: '#1a1a25',
                    fontFamily: 'Syne', whiteSpace: 'nowrap',
                  }}>
                    {formatRupiah(item.qty * item.price)}
                  </span>
                </div>
              ))}
            </div>

            {/* Bank + Summary — always 2 columns desktop */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: isHutang ? '1fr 1.15fr' : '1fr 1fr',
              gap: 18,
              marginBottom: 26,
            }}>
              {/* Bank card */}
              <div style={{
                padding: 18,
                borderRadius: 12,
                background: 'linear-gradient(135deg, #f8f8fb 0%, #f1f1f5 100%)',
                border: '1px solid #ececf2',
                display: 'flex', flexDirection: 'column', justifyContent: 'center',
                minWidth: 0,
              }}>
                <div style={{ ...infoLabel, marginBottom: 10 }}>
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
                    fontSize: 12.5, color: '#a3ff3a', letterSpacing: '0.04em',
                    fontFamily: '"Bree Serif", serif',
                  }}>
                    {STORE_INFO.bank?.name || '-'}
                  </div>
                  <div style={{
                    fontSize: 22, color: '#fff', letterSpacing: 2,
                    fontFamily: '"Bree Serif", serif', margin: '4px 0 2px',
                    wordBreak: 'break-all',
                  }}>
                    {STORE_INFO.bank?.number || '-'}
                  </div>
                  <div style={{
                    fontSize: 13, color: '#e0e0e8', fontFamily: '"Bree Serif", serif',
                  }}>
                    a.n. {STORE_INFO.bank?.holder || '-'}
                  </div>
                </div>
              </div>

              {/* Total summary — Hutang mode emphasizes SISA TAGIHAN */}
              <div style={{
                padding: 20,
                borderRadius: 12,
                background: (t.remaining || 0) > 0
                  ? 'linear-gradient(135deg, #0a0a0f 0%, #2d1a0a 100%)'   // hutang: dark + orange glow
                  : 'linear-gradient(135deg, #0a0a0f 0%, #1a0a2e 100%)',   // lunas: dark + purple
                color: '#fff',
                minWidth: 0,
                position: 'relative',
                overflow: 'hidden',
              }}>
                {/* Soft glow accent untuk hutang */}
                {(t.remaining || 0) > 0 && (
                  <div style={{
                    position: 'absolute',
                    top: -40, right: -40,
                    width: 160, height: 160,
                    borderRadius: '50%',
                    background: 'radial-gradient(circle, rgba(245,158,11,0.25), transparent 70%)',
                    pointerEvents: 'none',
                  }} />
                )}

                <div style={{ position: 'relative' }}>
                  {/* Subtotal */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 8 }}>
                    <span style={{ color: '#8888a8' }}>Subtotal</span>
                    <span style={{ color: '#f0f0f8', fontWeight: 600 }}>{formatRupiah(t.subtotal)}</span>
                  </div>

                  {/* Diskon */}
                  {t.discount > 0 && (
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 8 }}>
                      <span style={{ color: '#8888a8' }}>Diskon</span>
                      <span style={{ color: '#ff4d6a', fontWeight: 600 }}>−{formatRupiah(t.discount)}</span>
                    </div>
                  )}

                  {/* Divider */}
                  <div style={{
                    height: 1,
                    background: 'rgba(255,255,255,0.1)',
                    margin: '12px 0',
                  }} />

                  {/* TOTAL */}
                  <div style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginBottom: (t.remaining || 0) > 0 ? 16 : 4,
                    gap: 6,
                  }}>
                    <span style={{
                      fontSize: 12, fontWeight: 700, color: '#a78bfa',
                      textTransform: 'uppercase', letterSpacing: '0.08em', fontFamily: 'Syne',
                    }}>
                      Total
                    </span>
                    <span style={{
                      fontSize: 28, fontWeight: 800, color: '#fff',
                      fontFamily: 'Syne', letterSpacing: '-0.02em',
                      whiteSpace: 'nowrap',
                    }}>
                      {formatRupiah(t.total)}
                    </span>
                  </div>

                  {/* HUTANG SECTION — DP + SISA TAGIHAN (prominent) */}
                  {(t.remaining || 0) > 0 && (
                    <>
                      <div style={{
                        height: 1,
                        background: 'rgba(245,158,11,0.25)',
                        margin: '16px 0',
                      }} />

                      {/* DP Dibayar */}
                      <div style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'baseline',
                        marginBottom: 18,
                      }}>
                        <span style={{
                          fontSize: 11,
                          fontWeight: 700,
                          color: '#8888a8',
                          textTransform: 'uppercase',
                          letterSpacing: '0.08em',
                          fontFamily: 'Syne',
                        }}>
                          DP Dibayar
                        </span>
                        <span style={{
                          fontSize: 16,
                          fontWeight: 700,
                          color: '#10d98a',
                          fontFamily: 'Syne',
                          whiteSpace: 'nowrap',
                        }}>
                          {formatRupiah(t.dp || t.paid || 0)}
                        </span>
                      </div>

                      {/* SISA TAGIHAN — HERO ELEMENT */}
                      <div style={{
                        background: 'linear-gradient(135deg, rgba(245,158,11,0.15), rgba(234,88,12,0.08))',
                        border: '1px solid rgba(245,158,11,0.35)',
                        borderRadius: 10,
                        padding: '14px 16px',
                      }}>
                        <div style={{
                          fontSize: 11,
                          fontWeight: 800,
                          color: '#fbbf24',
                          textTransform: 'uppercase',
                          letterSpacing: '0.1em',
                          fontFamily: 'Syne',
                          marginBottom: 6,
                        }}>
                          Sisa Tagihan
                        </div>
                        <div style={{
                          fontSize: 32,
                          fontWeight: 800,
                          color: '#fbbf24',
                          fontFamily: 'Syne',
                          letterSpacing: '-0.02em',
                          lineHeight: 1.05,
                          whiteSpace: 'nowrap',
                          textShadow: '0 0 24px rgba(245,158,11,0.4)',
                        }}>
                          {formatRupiah(t.remaining)}
                        </div>
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>

            {/* Footer */}
            <div style={{
              borderTop: '2px dashed #ececf2',
              paddingTop: 20,
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'flex-end',
              gap: 18,
              flexWrap: 'wrap',
            }}>
              <div style={{ flex: 1, minWidth: 240 }}>
                <div style={infoLabel}>Catatan</div>
                <p style={{ fontSize: 11, color: '#55556a', lineHeight: 1.6, marginBottom: 6 }}>
                  Terima kasih atas kepercayaan Anda. Pembayaran via transfer ke <strong>{STORE_INFO.bank?.name} {STORE_INFO.bank?.number}</strong> a.n. <strong>{STORE_INFO.bank?.holder}</strong>.
                </p>
                <p style={{ fontSize: 11, color: '#55556a', lineHeight: 1.6 }}>
                  Untuk pertanyaan, hubungi {STORE_INFO.phone}.
                </p>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ ...infoLabel, marginBottom: 28 }}>Tanda Tangan</div>
                <div style={{
                  borderTop: '1px solid #c5c5d0',
                  paddingTop: 6,
                  minWidth: 160,
                  fontSize: 11, fontWeight: 600, color: '#1a1a25', fontFamily: 'Syne',
                }}>
                  {STORE_INFO.name}
                </div>
              </div>
            </div>

            {/* Bottom strip */}
            <div style={{
              marginTop: 28,
              textAlign: 'center',
              fontSize: 10,
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

const infoLabel = {
  fontSize: 10,
  fontWeight: 700,
  color: '#8888a8',
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  fontFamily: 'Syne',
  marginBottom: 8,
}

function DetailRow({ k, v }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10.5, marginBottom: 5 }}>
      <span style={{ color: '#8888a8' }}>{k}</span>
      <span style={{ color: '#1a1a25', fontWeight: 600, textAlign: 'right' }}>{v}</span>
    </div>
  )
}
