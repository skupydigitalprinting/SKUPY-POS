import React from 'react'

/**
 * Skupy Logo — inline SVG with optional custom image override.
 *
 * Props:
 *   size       — pixel size (default 40)
 *   variant    — 'icon' (default) or 'full' (icon + wordmark)
 *   onLight    — adapt for light background
 *   customSrc  — if provided, render this image instead of the built-in SVG
 *                (base64 data URL or http URL)
 */
export default function Logo({
  size = 40,
  variant = 'icon',
  onLight = false,
  customSrc = '',
  className = '',
  style = {},
}) {
  const id = React.useId().replace(/:/g, '')

  // If user uploaded a custom logo, render it as <img>
  if (customSrc) {
    if (variant === 'full') {
      return (
        <img
          src={customSrc}
          alt="Logo"
          className={className}
          style={{
            height: size,
            width: 'auto',
            maxWidth: size * 3.2,
            objectFit: 'contain',
            display: 'block',
            ...style,
          }}
        />
      )
    }
    return (
      <img
        src={customSrc}
        alt="Logo"
        className={className}
        style={{
          width: size,
          height: size,
          objectFit: 'contain',
          borderRadius: size * 0.22,
          background: onLight ? '#fff' : '#0a0a0f',
          display: 'block',
          ...style,
        }}
      />
    )
  }

  const Icon = (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      xmlns="http://www.w3.org/2000/svg"
      style={style}
      className={className}
    >
      <defs>
        <linearGradient id={`gS-${id}`} x1="20%" y1="0%" x2="80%" y2="100%">
          <stop offset="0%" stopColor="#a3ff3a" />
          <stop offset="35%" stopColor="#06d6f5" />
          <stop offset="65%" stopColor="#6e3aff" />
          <stop offset="100%" stopColor="#ff2dbe" />
        </linearGradient>
        <linearGradient id={`gAccent-${id}`} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#a3ff3a" />
          <stop offset="100%" stopColor="#fff200" />
        </linearGradient>
      </defs>

      {!onLight && <rect width="100" height="100" rx="22" fill="#0a0a0f" />}

      <path d="M30,20 L62,20 L62,32 L42,32 L42,40 L30,40 Z" fill={`url(#gS-${id})`} />
      <path d="M30,40 L70,40 L70,60 L30,60 Z" fill={`url(#gS-${id})`} opacity="0.92" />
      <path d="M30,60 L58,60 L58,68 L70,68 L70,80 L30,80 Z" fill={`url(#gS-${id})`} />
      <rect x="48" y="12" width="4" height="78" fill="#0a0a0f" />
      <rect x="62" y="20" width="10" height="10" fill={`url(#gAccent-${id})`} />
      <rect x="22" y="68" width="10" height="12" fill="#ff2dbe" />
    </svg>
  )

  if (variant === 'icon') return Icon

  return (
    <div
      className={className}
      style={{ display: 'inline-flex', alignItems: 'center', gap: size * 0.18, ...style }}
    >
      {Icon}
      <svg
        height={size * 0.62}
        viewBox="0 0 200 80"
        xmlns="http://www.w3.org/2000/svg"
        style={{ display: 'block' }}
      >
        <defs>
          <linearGradient id={`gText-${id}`} x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#a3ff3a" />
            <stop offset="100%" stopColor="#fff200" />
          </linearGradient>
        </defs>
        <text
          x="0" y="58"
          fontFamily="Syne, sans-serif"
          fontWeight="800"
          fontSize="64"
          fill={`url(#gText-${id})`}
          letterSpacing="-2"
        >
          Skupy
        </text>
        <rect x="0" y="68" width="180" height="3" rx="1.5" fill={`url(#gText-${id})`} />
      </svg>
    </div>
  )
}
