import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

// ── Tema per brand ──────────────────────────────────────────────────────────
// SKUPY = dark premium (glow hijau/ungu). THEWA = luxury clean (putih elegan).
// Lainnya / Semua Book = netral gelap.
function bookTheme(book) {
  const key = (book?.name || book?.brand_name || '').toUpperCase()
  if (key.includes('SKUPY')) return {
    bg: '#050505', fg: '#ffffff', subColor: 'rgba(255,255,255,0.55)',
    sub: book?.brand_name && !/skupy/i.test(book.brand_name) ? book.brand_name : 'Printing Studio',
    glowA: 'rgba(139,92,246,0.45)', glowB: 'rgba(16,217,138,0.30)', accent: '#a78bfa', ring: 'rgba(139,92,246,0.5)',
  }
  if (key.includes('THEWA')) return {
    bg: '#ffffff', fg: '#0a0a0a', subColor: 'rgba(10,10,10,0.5)',
    sub: book?.brand_name && !/thewa/i.test(book.brand_name) ? book.brand_name : 'Fashion & Muslim Wear',
    glowA: 'rgba(191,161,74,0.30)', glowB: 'rgba(0,0,0,0.05)', accent: '#bfa14a', ring: 'rgba(191,161,74,0.45)',
  }
  return {
    bg: '#0a0a0f', fg: '#ffffff', subColor: 'rgba(255,255,255,0.5)',
    sub: book?.brand_name || 'Pembukuan', glowA: 'rgba(99,102,241,0.4)', glowB: 'rgba(139,92,246,0.28)',
    accent: '#818cf8', ring: 'rgba(99,102,241,0.5)',
  }
}

// book = { name, brand_name, logo_url } | null (null → "Semua Book")
export default function BookSplash({ book, duration = 850, onDone }) {
  const t = bookTheme(book)
  const title = (book?.name || 'Semua Book').toUpperCase()
  const sub = book ? t.sub : 'Semua Pembukuan'
  const initial = (book?.name || 'S').trim().charAt(0).toUpperCase()
  const [phase, setPhase] = useState('in') // in → hold → out
  const [grow, setGrow] = useState(false)  // progress bar 0→100%
  const doneRef = useRef(false)

  useEffect(() => {
    const tGrow = setTimeout(() => setGrow(true), 30)
    const tOut = setTimeout(() => setPhase('out'), Math.max(300, duration - 260))
    const tEnd = setTimeout(() => { if (!doneRef.current) { doneRef.current = true; onDone?.() } }, duration)
    return () => { clearTimeout(tGrow); clearTimeout(tOut); clearTimeout(tEnd) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const node = (
    <div
      role="status" aria-live="polite"
      style={{
        position: 'fixed', inset: 0, zIndex: 100000,
        background: t.bg, display: 'flex', alignItems: 'center', justifyContent: 'center',
        opacity: phase === 'out' ? 0 : 1,
        transition: 'opacity 260ms ease',
        paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)',
        overflow: 'hidden',
      }}
    >
      <style>{`
        @keyframes bs_pop { 0%{opacity:0;transform:scale(.82)} 60%{opacity:1} 100%{opacity:1;transform:scale(1)} }
        @keyframes bs_rise { 0%{opacity:0;transform:translateY(14px)} 100%{opacity:1;transform:translateY(0)} }
        @keyframes bs_glow { 0%,100%{opacity:.55;transform:scale(1)} 50%{opacity:.9;transform:scale(1.08)} }
      `}</style>

      {/* Glow blobs */}
      <div style={{ position: 'absolute', width: '60vmin', height: '60vmin', borderRadius: '50%', background: t.glowA, filter: 'blur(80px)', top: '12%', left: '8%', animation: 'bs_glow 2.4s ease-in-out infinite' }} />
      <div style={{ position: 'absolute', width: '52vmin', height: '52vmin', borderRadius: '50%', background: t.glowB, filter: 'blur(80px)', bottom: '10%', right: '8%', animation: 'bs_glow 2.4s ease-in-out infinite .4s' }} />

      <div style={{ position: 'relative', textAlign: 'center', padding: 24, animation: 'bs_pop 620ms cubic-bezier(.2,.8,.2,1) both' }}>
        {/* Logo / monogram */}
        <div style={{
          width: 'clamp(84px,22vmin,128px)', height: 'clamp(84px,22vmin,128px)', margin: '0 auto 22px',
          borderRadius: 28, display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: book?.logo_url ? 'transparent' : `linear-gradient(135deg, ${t.accent}, ${t.ring})`,
          boxShadow: `0 0 0 1px ${t.ring}, 0 18px 60px -12px ${t.glowA}`,
          overflow: 'hidden',
        }}>
          {book?.logo_url
            ? <img src={book.logo_url} alt={title} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
            : <span style={{ fontFamily: 'Syne, sans-serif', fontWeight: 800, color: '#fff', fontSize: 'clamp(38px,10vmin,60px)', lineHeight: 1 }}>{initial}</span>}
        </div>

        <div style={{
          fontFamily: 'Syne, sans-serif', fontWeight: 800, color: t.fg,
          fontSize: 'clamp(34px,9vmin,64px)', letterSpacing: '.12em', lineHeight: 1,
          animation: 'bs_rise 520ms ease 120ms both',
        }}>{title}</div>

        <div style={{
          marginTop: 12, color: t.subColor, fontSize: 'clamp(12px,3.2vmin,16px)',
          letterSpacing: '.22em', textTransform: 'uppercase', fontWeight: 600,
          animation: 'bs_rise 520ms ease 220ms both',
        }}>{sub}</div>

        {/* progress line */}
        <div style={{ width: 120, height: 3, borderRadius: 99, margin: '26px auto 0', background: `${t.accent}26`, position: 'relative', overflow: 'hidden' }}>
          <div style={{ position: 'absolute', insetBlock: 0, left: 0, width: '100%', transformOrigin: 'left', background: t.accent, transform: grow ? 'scaleX(1)' : 'scaleX(0)', transition: `transform ${Math.max(300, duration - 200)}ms cubic-bezier(.4,0,.2,1)` }} />
        </div>
      </div>
    </div>
  )
  return createPortal(node, document.body)
}
