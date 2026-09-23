import React, { useEffect, useId, useRef, useState } from 'react'
import { Check, Loader2, Pencil, RefreshCw, UserPlus, X } from 'lucide-react'
import { Button } from './ui'
import { createAccountClient } from '../lib/accountClient'
import { validNewPassword } from '../utils/passwordRules'

const inputClass = 'w-full min-w-0 rounded-lg px-3 py-2.5 text-sm'
const inputStyle = { background: 'var(--bg-elevated)', color: 'var(--text-primary)', border: '1px solid var(--border)' }
const empty = { username: '', name: '', role: 'staff', active: true }

export default function ManagedAccounts(props) {
  if (props.currentUser?.role !== 'owner') return null
  return <AccountForm key={`${props.currentUser.authUserId}:${props.currentUser.authSessionId}`} {...props} />
}

function AccountForm(props) {
  const prefix = useId()
  const alive = useRef(false)
  const running = useRef(false)
  const [client] = useState(() => createAccountClient(props))
  const [accounts, setAccounts] = useState([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [target, setTarget] = useState(null)
  const [fields, setFields] = useState(empty)
  const [ownerPassword, setOwnerPassword] = useState('')
  const [initialPassword, setInitialPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [message, setMessage] = useState('')
  const [pendingOperation, setPendingOperation] = useState(null)
  const refresh = async () => {
    setLoading(true)
    const result = await client.list()
    if (!alive.current) return
    if (result.ok) setAccounts(result.accounts)
    else { setAccounts([]); setMessage('Daftar akun belum dapat diverifikasi.') }
    setLoading(false)
  }
  useEffect(() => {
    alive.current = true
    void refresh()
    return () => { alive.current = false }
  }, [client])
  const clearPasswords = () => { setOwnerPassword(''); setInitialPassword(''); setConfirmation('') }
  const select = account => {
    setTarget(account); setFields(account || empty); clearPasswords(); setMessage('')
  }
  const submit = async event => {
    event.preventDefault()
    if (running.current || pendingOperation || loading) return
    if (!target && (!validNewPassword(initialPassword) || initialPassword !== confirmation || initialPassword === ownerPassword)) {
      setMessage('Password baru harus berbeda, minimal 12 karakter, maksimal 72 byte, dan konfirmasi cocok.'); return
    }
    const operationId = globalThis.crypto?.randomUUID?.()
    if (!operationId) { setMessage('Operasi akun belum tersedia di perangkat ini.'); return }
    running.current = true; setBusy(true); setMessage(''); clearPasswords()
    try {
      const result = target
        ? await client.update(target.id, target.version, { name: fields.name, role: fields.role, active: fields.active }, ownerPassword, operationId)
        : await client.create({ username: fields.username, name: fields.name, role: fields.role, ownerPassword, initialPassword }, operationId)
      if (!alive.current) return
      if (result.ok) { setTarget(null); setFields(empty); setMessage('Akun tersimpan.'); await refresh() }
      else if (result.uncertain) { setPendingOperation(operationId); setMessage('Status belum pasti. Operasi ditahan untuk pemeriksaan.'); await refresh() }
      else { setMessage(result.conflict ? 'Akun telah berubah. Pilih kembali akun setelah daftar diperbarui.' : result.error); setTarget(null); setFields(empty); await refresh() }
    } finally { running.current = false; if (alive.current) setBusy(false) }
  }
  const checkStatus = async operationId => {
    if (running.current) return
    running.current = true; setBusy(true)
    try {
      const result = await client.status(operationId)
      if (!alive.current) return
      if (result.ok && result.account) {
        if (pendingOperation === operationId) setPendingOperation(null)
        setTarget(null); setFields(empty); setMessage('Operasi selesai.'); await refresh()
      } else setMessage('Operasi belum terkonfirmasi selesai. Hubungi pengelola sistem; jangan buat ulang akun.')
    } finally { running.current = false; if (alive.current) setBusy(false) }
  }
  const disabled = busy || loading || !!pendingOperation
  const field = (key, label, extra = {}) => <div className="min-w-0">
    <label htmlFor={`${prefix}-${key}`} className="block text-xs mb-2">{label}</label>
    <input id={`${prefix}-${key}`} name={key} value={fields[key]} onChange={e => setFields(previous => ({ ...previous, [key]: e.target.value }))}
      required disabled={disabled} className={inputClass} style={inputStyle} {...extra} />
  </div>
  const password = (key, label, value, setter, autocomplete) => <div className="min-w-0">
    <label htmlFor={`${prefix}-${key}`} className="block text-xs mb-2">{label}</label>
    <input id={`${prefix}-${key}`} type="password" value={value} onChange={e => setter(e.target.value)} autoComplete={autocomplete}
      required disabled={disabled} maxLength={autocomplete === 'new-password' ? 72 : 1024} className={inputClass} style={inputStyle} />
  </div>
  return <section className="space-y-4 min-w-0" aria-label="Kelola akun">
    <div className="flex items-center justify-between gap-3">
      <h3 className="text-base font-semibold">Kelola Akun</h3>
      <Button type="button" variant="ghost" title="Perbarui daftar" aria-label="Perbarui daftar" disabled={busy || loading} onClick={refresh}>
        <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
      </Button>
    </div>
    <ul className="divide-y" style={{ borderColor: 'var(--border)' }} aria-busy={loading}>
      {accounts.map(a => <li key={a.id} className="flex items-center gap-3 py-3 min-w-0">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold break-words">{a.name || a.username}</p>
          <p className="text-xs break-all" style={{ color: 'var(--text-secondary)' }}>@{a.username} / {a.role} / {a.pending ? 'Tertunda' : a.active ? 'Aktif' : 'Nonaktif'}</p>
        </div>
        {a.pending && a.operationId ? <Button type="button" variant="ghost" title="Periksa status" aria-label={`Periksa status ${a.username}`} disabled={busy} onClick={() => checkStatus(a.operationId)}><RefreshCw size={16} /></Button>
          : <Button type="button" variant="ghost" title="Ubah akun" aria-label={`Ubah akun ${a.username}`} disabled={disabled || a.pending} onClick={() => select(a)}><Pencil size={16} /></Button>}
      </li>)}
    </ul>
    {!loading && !accounts.length && <p className="text-sm">Belum ada akun staf atau admin terverifikasi.</p>}
    <form onSubmit={submit} className="space-y-4 min-w-0">
      <div className="flex items-center justify-between gap-3">
        <h4 className="text-sm font-semibold">{target ? `Ubah @${target.username}` : 'Akun Baru'}</h4>
        {target && <Button type="button" variant="ghost" title="Batalkan perubahan" aria-label="Batalkan perubahan" disabled={disabled} onClick={() => select(null)}><X size={16} /></Button>}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 min-w-0">
        {!target && field('username', 'Username', { autoComplete: 'off', autoCapitalize: 'none', spellCheck: false, minLength: 3, maxLength: 32, pattern: '[a-zA-Z0-9][a-zA-Z0-9._-]{2,31}' })}
        {field('name', 'Nama tampilan', { maxLength: 100 })}
        <div className="min-w-0">
          <label htmlFor={`${prefix}-role`} className="block text-xs mb-2">Peran</label>
          <select id={`${prefix}-role`} value={fields.role} onChange={e => setFields(previous => ({ ...previous, role: e.target.value }))} disabled={disabled} className={inputClass} style={inputStyle}>
            <option value="staff">Staf</option><option value="admin">Admin</option>
          </select>
        </div>
        {target && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={fields.active} disabled={disabled} onChange={e => setFields(previous => ({ ...previous, active: e.target.checked }))} />Akun aktif</label>}
        {!target && password('initial-password', 'Password awal', initialPassword, setInitialPassword, 'new-password')}
        {!target && password('confirm-password', 'Konfirmasi password awal', confirmation, setConfirmation, 'new-password')}
        {password('owner-password', 'Password owner saat ini', ownerPassword, setOwnerPassword, 'current-password')}
      </div>
      <Button type="submit" disabled={disabled}>{busy ? <Loader2 size={16} className="animate-spin" /> : target ? <Check size={16} /> : <UserPlus size={16} />}{target ? 'Simpan Perubahan' : 'Buat Akun'}</Button>
    </form>
    {message && <p role="status" className="text-sm break-words">{message}</p>}
    {pendingOperation && <div className="space-y-2">
      <p className="text-xs break-all">Operasi: {pendingOperation}</p>
      <Button type="button" variant="secondary" disabled={busy} onClick={() => checkStatus(pendingOperation)}><RefreshCw size={16} />Periksa Status</Button>
    </div>}
  </section>
}
