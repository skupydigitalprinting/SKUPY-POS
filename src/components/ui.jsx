import React from 'react'
import { Check, Search, Package } from 'lucide-react'
import { formatCurrency, QUICK_PRESETS, quickRange } from '../utils/helpers'
import { resolveProductImage } from '../utils/productImageFallback'

// Chips filter waktu cepat. `active` = key preset aktif ('today'|'week'|'month'
// |'year'|'all'|'custom'). onPick(key, {from,to}) dipanggil saat chip diklik.
// Chip aktif berwarna ungu. Wrap rapi di mobile, tanpa horizontal scroll.
export function RangeChips({ active = 'month', onPick, className = '' }) {
  return (
    <div className={`flex items-center gap-1.5 flex-wrap ${className}`}>
      {QUICK_PRESETS.map(([key, label]) => {
        const on = active === key
        return (
          <button key={key} type="button" onClick={() => onPick && onPick(key, quickRange(key))}
            className="px-2.5 py-1.5 rounded-lg text-[11px] font-semibold btn-press"
            style={{ background: on ? 'linear-gradient(135deg, var(--accent), #6366f1)' : 'var(--bg-elevated)', color: on ? '#fff' : 'var(--text-secondary)', border: `1px solid ${on ? 'transparent' : 'var(--border)'}`, fontFamily: 'Syne' }}>
            {label}
          </button>
        )
      })}
      {active === 'custom' && (
        <span className="px-2.5 py-1.5 rounded-lg text-[11px] font-semibold" style={{ background: 'rgba(139,92,246,0.15)', color: 'var(--accent-light)', border: '1px solid rgba(139,92,246,0.3)', fontFamily: 'Syne' }}>Custom</span>
      )}
    </div>
  )
}

// Searchable customer picker (cari nama / no HP). Hanya menampilkan customer
// yang diberikan (sudah difilter aktif + sesuai hak akses role oleh pemanggil).
export function CustomerPicker({ customers = [], value, onChange, placeholder = 'Cari nama / no HP…' }) {
  const [q, setQ] = React.useState('')
  const s = q.toLowerCase().trim()
  const list = (customers || []).filter((c) => {
    if (!s) return true
    return (c.name || '').toLowerCase().includes(s) || String(c.phone || '').includes(s) || String(c.whatsapp || '').includes(s)
  }).slice(0, 60)
  const inp = { background: 'var(--bg-elevated)', border: '1px solid var(--border)', color: 'var(--text-primary)' }
  return (
    <div>
      <div className="relative mb-2">
        <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={placeholder} className="w-full pl-9 pr-3 py-2.5 rounded-xl text-sm" style={inp} />
      </div>
      <div style={{ maxHeight: 240, overflowY: 'auto' }} className="space-y-1">
        {list.length === 0 && <p className="text-xs text-center py-3" style={{ color: 'var(--text-muted)' }}>Tidak ada customer cocok</p>}
        {list.map((c) => (
          <button key={c.id} type="button" onClick={() => onChange(c.id)}
            className="w-full text-left px-3 py-2 rounded-lg flex items-center justify-between gap-2"
            style={{ background: value === c.id ? 'rgba(139,92,246,0.14)' : 'var(--bg-card)', border: `1px solid ${value === c.id ? 'var(--accent)' : 'var(--border)'}` }}>
            <span className="min-w-0 truncate">
              <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{c.name}</span>
              {c.phone && <span className="text-[11px] ml-2" style={{ color: 'var(--text-muted)' }}>{c.phone}</span>}
            </span>
            {value === c.id && <Check size={14} style={{ color: 'var(--accent-light)', flexShrink: 0 }} />}
          </button>
        ))}
      </div>
    </div>
  )
}

export function Label({ children, required }) {
  return (
    <label
      className="block text-xs font-semibold mb-1.5"
      style={{ color: 'var(--text-secondary)', fontFamily: 'Syne', letterSpacing: '0.02em' }}
    >
      {children} {required && <span style={{ color: 'var(--red)' }}>*</span>}
    </label>
  )
}

export function Input({ label, required, prefix, className = '', ...props }) {
  return (
    <div className="w-full">
      {label && <Label required={required}>{label}</Label>}
      <div className="relative">
        {prefix && (
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs font-semibold pointer-events-none"
            style={{ color: 'var(--text-muted)' }}>
            {prefix}
          </span>
        )}
        <input
          className={`w-full px-3 py-2.5 rounded-xl text-sm transition-all ${prefix ? 'pl-8' : ''} ${className}`}
          style={{
            background: 'var(--bg-card)',
            border: '1px solid var(--border)',
            color: 'var(--text-primary)',
            fontFamily: 'DM Sans',
          }}
          {...props}
        />
      </div>
    </div>
  )
}

// Input UANG reusable. Aturan:
//  • value kosong / 0 / null → tampil KOSONG (placeholder redup "0"), bukan "0".
//  • mengetik → format ribuan otomatis (1000000 → 1.000.000).
//  • type="text" inputMode="numeric" → tanpa spinner number.
//  • onChange(rawDigits) → mengirim string angka murni ("" bila kosong) supaya
//    Number(value) di pemanggil tetap valid; saat simpan, "" dianggap 0.
export function MoneyInput({ label, required, prefix = 'Rp', value, onChange, placeholder = '0', className = '', ...props }) {
  const display = (value === '' || value === null || value === undefined) ? '' : formatCurrency(value)
  return (
    <div className="w-full">
      {label && <Label required={required}>{label}</Label>}
      <div className="relative">
        {prefix && (
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs font-semibold pointer-events-none"
            style={{ color: 'var(--text-muted)' }}>
            {prefix}
          </span>
        )}
        <input
          type="text"
          inputMode="numeric"
          value={display}
          placeholder={placeholder}
          onChange={(e) => { const d = (e.target.value || '').replace(/[^\d]/g, ''); onChange(d === '' ? '' : String(parseInt(d, 10))) }}
          className={`w-full px-3 py-2.5 rounded-xl text-sm transition-all ${prefix ? 'pl-8' : ''} ${className}`}
          style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', color: 'var(--text-primary)', fontFamily: 'DM Sans' }}
          {...props}
        />
      </div>
    </div>
  )
}

export function Select({ label, required, children, className = '', ...props }) {
  return (
    <div className="w-full">
      {label && <Label required={required}>{label}</Label>}
      <select
        className={`w-full px-3 py-2.5 rounded-xl text-sm transition-all ${className}`}
        style={{
          background: 'var(--bg-card)',
          border: '1px solid var(--border)',
          color: 'var(--text-primary)',
          fontFamily: 'DM Sans',
        }}
        {...props}
      >
        {children}
      </select>
    </div>
  )
}

export function Textarea({ label, required, className = '', ...props }) {
  return (
    <div className="w-full">
      {label && <Label required={required}>{label}</Label>}
      <textarea
        className={`w-full px-3 py-2.5 rounded-xl text-sm transition-all resize-none ${className}`}
        style={{
          background: 'var(--bg-card)',
          border: '1px solid var(--border)',
          color: 'var(--text-primary)',
          fontFamily: 'DM Sans',
        }}
        rows={3}
        {...props}
      />
    </div>
  )
}

export function Button({ children, variant = 'primary', size = 'md', className = '', disabled, ...props }) {
  const base = 'inline-flex items-center justify-center gap-2 font-semibold rounded-xl transition-all btn-press select-none disabled:opacity-50 disabled:cursor-not-allowed'
  const sizes = {
    sm: 'px-3 py-1.5 text-xs',
    md: 'px-4 py-2.5 text-sm',
    lg: 'px-6 py-3 text-sm',
  }
  const variants = {
    primary: {
      background: 'linear-gradient(135deg, #8b5cf6, #6366f1)',
      color: '#fff',
      boxShadow: disabled ? 'none' : '0 4px 16px rgba(139,92,246,0.3)',
    },
    secondary: {
      background: 'rgba(255,255,255,0.04)',
      color: 'var(--text-primary)',
      border: '1px solid var(--border)',
    },
    danger: {
      background: 'rgba(255,77,106,0.12)',
      color: 'var(--red)',
      border: '1px solid rgba(255,77,106,0.25)',
    },
    success: {
      background: 'linear-gradient(135deg, #10d98a, #059669)',
      color: '#fff',
      boxShadow: disabled ? 'none' : '0 4px 16px rgba(16,217,138,0.3)',
    },
    ghost: {
      background: 'transparent',
      color: 'var(--text-secondary)',
    },
  }
  return (
    <button
      disabled={disabled}
      className={`${base} ${sizes[size]} ${className}`}
      style={{ fontFamily: 'Syne', ...variants[variant] }}
      {...props}
    >
      {children}
    </button>
  )
}

export function Badge({ children, color = 'accent', className = '' }) {
  const colors = {
    accent: { bg: 'rgba(139,92,246,0.12)', text: '#a78bfa', border: 'rgba(139,92,246,0.25)' },
    green: { bg: 'rgba(16,217,138,0.12)', text: '#10d98a', border: 'rgba(16,217,138,0.25)' },
    red: { bg: 'rgba(255,77,106,0.12)', text: '#ff4d6a', border: 'rgba(255,77,106,0.25)' },
    amber: { bg: 'rgba(245,158,11,0.12)', text: '#f59e0b', border: 'rgba(245,158,11,0.25)' },
    blue: { bg: 'rgba(59,130,246,0.12)', text: '#3b82f6', border: 'rgba(59,130,246,0.25)' },
    gray: { bg: 'rgba(136,136,168,0.1)', text: '#8888a8', border: 'rgba(136,136,168,0.2)' },
  }
  const c = colors[color] || colors.accent
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-xs font-semibold whitespace-nowrap ${className}`}
      style={{ background: c.bg, color: c.text, border: `1px solid ${c.border}`, fontFamily: 'Syne' }}
    >
      {children}
    </span>
  )
}

export function Card({ children, className = '', hover, ...props }) {
  return (
    <div
      className={`premium-card p-5 ${hover ? 'hover:border-white/10' : ''} ${className}`}
      {...props}
    >
      {children}
    </div>
  )
}

export function EmptyState({ icon: Icon, title, description, action }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
      {Icon && (
        <div className="w-16 h-16 rounded-2xl flex items-center justify-center mb-4"
          style={{ background: 'rgba(139,92,246,0.08)', border: '1px solid var(--border)' }}>
          <Icon size={28} style={{ color: 'var(--text-muted)' }} />
        </div>
      )}
      <h3 className="font-bold text-base mb-1" style={{ fontFamily: 'Syne', color: 'var(--text-primary)' }}>
        {title}
      </h3>
      {description && (
        <p className="text-sm mb-4" style={{ color: 'var(--text-muted)' }}>{description}</p>
      )}
      {action}
    </div>
  )
}

export function ProductImage({ src, alt, className = '', fallbackSize = 60 }) {
  // Reset failed sources when a product is renamed or receives a new photo.
  return (
    <ProductImageContent
      key={JSON.stringify([src, alt])}
      src={src} alt={alt} className={className} fallbackSize={fallbackSize}
    />
  )
}

function ProductImageContent({ src, alt, className, fallbackSize }) {
  const [failedSources, setFailedSources] = React.useState([])
  const image = resolveProductImage(src, alt, failedSources)
  const isIllustration = image.kind === 'illustration'
  const label = isIllustration ? `Ilustrasi untuk ${alt || 'produk'}` : alt

  return (
    <div className={`relative overflow-hidden ${className}`}
      style={{ background: image.kind === 'photo' ? undefined : '#eef0f2' }}
      title={isIllustration ? label : image.kind === 'text' ? alt || image.text : undefined}>
      {image.src ? (
        <img
          key={image.src}
          src={image.src}
          alt={label}
          className="block w-full h-full"
          style={{ objectFit: isIllustration ? 'contain' : 'inherit' }}
          onError={() => setFailedSources(previous => (
            previous.includes(image.src) ? previous : [...previous, image.src]
          ))}
          loading="lazy"
          decoding="async"
        />
      ) : (
        <ProductNameThumbnail text={image.text} label={alt || image.text} fallbackSize={fallbackSize} />
      )}
      {isIllustration && fallbackSize >= 60 && (
        <span className="absolute bottom-2 right-2 z-10 pointer-events-none"
          style={{ background: '#ffffffeb', color: '#424953', fontSize: 10,
            lineHeight: '16px', padding: '1px 6px', borderRadius: 4 }}>
          Ilustrasi
        </span>
      )}
    </div>
  )
}

function ProductNameThumbnail({ text, label, fallbackSize }) {
  const box = React.useRef(null)
  const [height, setHeight] = React.useState(0)
  React.useEffect(() => {
    const element = box.current
    if (!element) return
    const measure = () => setHeight(element.clientHeight)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const padding = height >= 80 ? 16 : 4
  const available = Math.max(0, height - padding * 2)
  const fontSize = Math.max(10, Math.min(22, fallbackSize * 0.28, available / 2.5 || 10))
  // Clamp to complete lines in the actual box, including compact order rows.
  const lines = Math.max(1, Math.min(3, Math.floor(available / (fontSize * 1.25))))
  return (
    <div ref={box} className="flex items-center justify-center w-full h-full text-center"
      style={{ padding, color: '#344b59', background: '#e6edf0' }}
      role="img" aria-label={`Thumbnail tulisan: ${label}`}>
      <span style={{ display: '-webkit-box', WebkitBoxOrient: 'vertical',
        WebkitLineClamp: lines, overflow: 'hidden', overflowWrap: 'anywhere',
        maxWidth: '100%', fontWeight: 700, fontSize, lineHeight: 1.25, letterSpacing: 0 }}>
        {text}
      </span>
    </div>
  )
}
