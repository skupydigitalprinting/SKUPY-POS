import React, { useState, useEffect } from 'react'
import { KeyRound, Loader2 } from 'lucide-react'
import { authSession } from '../lib/authRuntime'
import { supabase, getDataClient } from '../lib/supabase'
import { createStaffRecoveryClient } from '../lib/staffRecoveryClient'
import { Button } from './ui'
import { validNewPassword } from '../utils/passwordRules'

export default function StaffPasswordRecovery({ currentUser }) {
  const [dataClient] = useState(getDataClient)
  const [staff, setStaff] = useState([])
  const [listing, setListing] = useState(true)
  const [target, setTarget] = useState('')
  const [ownerPassword, setOwnerPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  const [reset] = useState(() => {
    const epoch = authSession.getSnapshot().epoch
    return createStaffRecoveryClient({ auth: supabase.auth,
      isCurrent: () => authSession.getSnapshot().phase === 'ready' && authSession.getSnapshot().epoch === epoch })
  })
  useEffect(() => {
    let active = true
    dataClient.rpc('pos_resettable_staff').then(({ data, error }) => {
      if (!active) return
      if (error || !Array.isArray(data)) setResult({ ok: false, error: 'Daftar akun belum dapat diverifikasi. Coba buka kembali halaman ini.' })
      else setStaff(data)
      setListing(false)
    }).catch(() => { if (active) { setResult({ ok: false, error: 'Daftar akun belum dapat diverifikasi.' }); setListing(false) } })
    return () => { active = false }
  }, [dataClient])
  if (currentUser?.role !== 'owner') return null
  const submit = async event => {
    event.preventDefault()
    if (busy) return
    if (!validNewPassword(newPassword)) { setResult({ ok: false, error: 'Password minimal 12 karakter dan maksimal 72 byte.' }); return }
    if (newPassword !== confirmation) { setResult({ ok: false, error: 'Konfirmasi password tidak cocok.' }); return }
    setBusy(true); setResult(null)
    try {
      const outcome = await reset(target, ownerPassword, newPassword)
      setResult(outcome)
      if (outcome.ok) { setNewPassword(''); setConfirmation('') }
    } finally { setOwnerPassword(''); setBusy(false) }
  }
  const inputStyle = { background: 'var(--bg-elevated)', color: 'var(--text-primary)', border: '1px solid var(--border)' }
  const inputClass = 'w-full rounded-lg px-3 py-2.5 text-sm'
  return <form onSubmit={submit} className="space-y-4">
    <h3 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>Reset Password Staf</h3>
    <div>
      <label htmlFor="reset-staff" className="block text-xs mb-2">Akun staf</label>
      <select id="reset-staff" value={target} onChange={e => setTarget(e.target.value)} required disabled={busy || listing} className={inputClass} style={inputStyle}>
        <option value="">{listing ? 'Memuat akun...' : 'Pilih akun'}</option>
        {staff.map(a => <option key={a.id} value={a.id} disabled={a.reset_pending}>{a.name || a.username} (@{a.username}){a.reset_pending ? ' - Dikunci' : ''}</option>)}
      </select>
    </div>
    <div>
      <label htmlFor="reset-owner-password" className="block text-xs mb-2">Password owner saat ini</label>
      <input id="reset-owner-password" type="password" autoComplete="current-password" value={ownerPassword} onChange={e => setOwnerPassword(e.target.value)} required maxLength={1024} disabled={busy} className={inputClass} style={inputStyle} />
    </div>
    <div>
      <label htmlFor="reset-new-password" className="block text-xs mb-2">Password baru staf</label>
      <input id="reset-new-password" type="password" autoComplete="new-password" value={newPassword} onChange={e => setNewPassword(e.target.value)} required minLength={12} maxLength={72} disabled={busy} className={inputClass} style={inputStyle} />
    </div>
    <div>
      <label htmlFor="reset-confirm-password" className="block text-xs mb-2">Konfirmasi password baru</label>
      <input id="reset-confirm-password" type="password" autoComplete="new-password" value={confirmation} onChange={e => setConfirmation(e.target.value)} required minLength={12} maxLength={72} disabled={busy} className={inputClass} style={inputStyle} />
    </div>
    {result && <p role="status" className="text-sm break-words" style={{ color: result.ok ? 'var(--green)' : 'var(--red)' }}>{result.ok ? 'Password staf berhasil diganti. Staf harus login kembali.' : result.error}</p>}
    <Button type="submit" variant="primary" disabled={busy || !target}>
      {busy ? <Loader2 size={16} className="animate-spin" /> : <KeyRound size={16} />}
      {busy ? 'Memproses...' : 'Reset Password'}
    </Button>
  </form>
}
