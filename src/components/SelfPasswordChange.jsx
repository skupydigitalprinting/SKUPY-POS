import React, { useEffect, useId, useRef, useState } from 'react'
import { KeyRound, Loader2 } from 'lucide-react'
import { Button } from './ui'
import { createAccountClient, settlePasswordChange } from '../lib/accountClient'
import { validNewPassword } from '../utils/passwordRules'

export default function SelfPasswordChange(props) {
  if (!['owner', 'admin', 'staff'].includes(props.currentUser?.role) || typeof props.onSessionEnd !== 'function') return null
  return <PasswordForm key={`${props.currentUser.authUserId}:${props.currentUser.authSessionId}:${props.currentUser.role}`} {...props} />
}

function PasswordForm(props) {
  const prefix = useId()
  const [client] = useState(() => createAccountClient(props))
  const [onSessionEnd] = useState(() => props.onSessionEnd)
  const alive = useRef(false)
  const running = useRef(false)
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [busy, setBusy] = useState(false)
  const [ended, setEnded] = useState(false)
  const [message, setMessage] = useState('')
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const submit = async event => {
    event.preventDefault()
    if (running.current || ended) return
    if (!validNewPassword(newPassword) || newPassword === currentPassword || newPassword !== confirmation) {
      setMessage('Password baru harus berbeda, minimal 12 karakter, maksimal 72 byte, dan konfirmasi cocok.'); return
    }
    const operationId = globalThis.crypto?.randomUUID?.()
    if (!operationId) { setMessage('Operasi akun belum tersedia di perangkat ini.'); return }
    running.current = true; setBusy(true); setMessage('')
    setCurrentPassword(''); setNewPassword(''); setConfirmation('')
    try {
      await settlePasswordChange(client.changePassword(currentPassword, newPassword, operationId), {
        client, onSessionEnd, isMounted: () => alive.current,
        onResult: result => {
          if (result.reauthenticationRequired) {
            setEnded(true)
            setMessage(result.ok ? 'Password berubah. Silakan login kembali.' : `Status belum pasti. Akun mungkin dikunci. Operasi: ${operationId}`)
          } else setMessage(result.error)
        },
        onCleanupError: () => setMessage('Sesi harus ditutup. Tutup halaman dan login kembali sebelum melanjutkan.'),
      })
    } finally { running.current = false; if (alive.current) setBusy(false) }
  }
  const input = (key, label, value, setter, autocomplete) => <div className="min-w-0">
    <label htmlFor={`${prefix}-${key}`} className="block text-xs mb-2">{label}</label>
    <input id={`${prefix}-${key}`} type="password" value={value} onChange={e => setter(e.target.value)} autoComplete={autocomplete}
      required maxLength={autocomplete === 'new-password' ? 72 : 1024} disabled={busy || ended}
      className="w-full min-w-0 rounded-lg px-3 py-2.5 text-sm" style={{ background: 'var(--bg-elevated)', color: 'var(--text-primary)', border: '1px solid var(--border)' }} />
  </div>
  return <form onSubmit={submit} className="space-y-4 min-w-0" aria-label="Ubah password sendiri">
    <h3 className="text-base font-semibold">Ubah Password</h3>
    {input('current', 'Password saat ini', currentPassword, setCurrentPassword, 'current-password')}
    {input('new', 'Password baru', newPassword, setNewPassword, 'new-password')}
    {input('confirmation', 'Konfirmasi password baru', confirmation, setConfirmation, 'new-password')}
    {message && <p role="status" className="text-sm break-words">{message}</p>}
    <Button type="submit" disabled={busy || ended}>{busy ? <Loader2 size={16} className="animate-spin" /> : <KeyRound size={16} />}Ubah Password</Button>
  </form>
}
