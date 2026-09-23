import React, { useEffect, useRef, useState } from 'react'
import { Check, RefreshCw } from 'lucide-react'
import { getDataClient } from '../lib/supabase'
import { Button } from './ui'

export default function StaffBookAccess({ currentUser }) {
  if (currentUser?.role !== 'owner') return null
  return <BookForm />
}

function BookForm() {
  const [client] = useState(getDataClient)
  const alive = useRef(false)
  const [staff, setStaff] = useState([])
  const [books, setBooks] = useState([])
  const [target, setTarget] = useState('')
  const [selected, setSelected] = useState([])
  const [version, setVersion] = useState(null)
  const [busy, setBusy] = useState(true)
  const [message, setMessage] = useState('')
  const load = async () => {
    setBusy(true); setTarget(''); setSelected([]); setVersion(null); setMessage('')
    try {
      const [people, available] = await Promise.all([
        client.rpc('pos_resettable_staff'),
        client.from('books').select('id,name').eq('is_active', true).is('deleted_at', null).order('name'),
      ])
      if (people.error || available.error) throw new Error('Daftar akses belum dapat dimuat.')
      if (!alive.current) return
      setStaff((people.data || []).filter(p => p.role === 'staff' && !p.reset_pending))
      setBooks(available.data || [])
    } catch { if (alive.current) { setStaff([]); setBooks([]); setMessage('Daftar akses belum dapat dimuat.') } }
    finally { if (alive.current) setBusy(false) }
  }
  useEffect(() => { alive.current = true; void load(); return () => { alive.current = false } }, [client])
  const choose = async id => {
    setTarget(''); setSelected([]); setVersion(null); setMessage('')
    if (!id) return
    setBusy(true)
    try {
      const { data, error } = await client.rpc('pos_admin_book_access', { p_admin_id: id })
      if (error || data?.admin_id !== id || !Array.isArray(data.book_ids) || !Number.isSafeInteger(data.version) || data.version < 0) throw new Error('unconfirmed')
      if (alive.current) { setSelected(data.book_ids); setVersion(data.version); setTarget(id) }
    } catch { if (alive.current) setMessage('Akses staf belum dapat dibaca. Coba muat ulang.') }
    finally { if (alive.current) setBusy(false) }
  }
  const save = async event => {
    event.preventDefault()
    if (busy || !target || version === null) return
    setBusy(true); setMessage('')
    try {
      const ids = selected.filter(id => books.some(b => b.id === id)).sort()
      const { data, error } = await client.rpc('pos_set_admin_books', { p_admin_id: target, p_book_ids: ids, p_expected_version: version })
      if (error || data?.admin_id !== target || data.version !== version + 1 || !Array.isArray(data.book_ids) || JSON.stringify([...data.book_ids].sort()) !== JSON.stringify(ids)) throw new Error('unconfirmed')
      if (alive.current) { setVersion(data.version); setMessage('Akses book tersimpan.') }
    } catch { if (alive.current) { setTarget(''); setSelected([]); setVersion(null); setMessage('Status perubahan belum terkonfirmasi. Pilih kembali staf untuk memeriksa aksesnya.') } }
    finally { if (alive.current) setBusy(false) }
  }
  return <form onSubmit={save} className="space-y-4" aria-label="Akses book staf">
    <div className="flex items-center justify-between gap-3">
      <h3 className="text-base font-semibold">Akses Book Staf</h3>
      <Button type="button" variant="ghost" title="Perbarui akses book" aria-label="Perbarui akses book" disabled={busy} onClick={load}><RefreshCw size={16} /></Button>
    </div>
    <label className="block text-xs">Akun staf
      <select value={target} onChange={e => choose(e.target.value)} disabled={busy} className="w-full mt-2 px-3 py-2.5 rounded-lg text-sm" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}>
        <option value="">Pilih staf</option>
        {staff.map(s => <option key={s.id} value={s.id}>{s.name || s.username} (@{s.username})</option>)}
      </select>
    </label>
    <div className="space-y-2">
      {books.map(b => <label key={b.id} className="flex items-center gap-2 text-sm">
        <input type="checkbox" disabled={busy || !target} checked={selected.includes(b.id)} onChange={e => setSelected(prev => e.target.checked ? [...prev, b.id] : prev.filter(id => id !== b.id))} />
        <span className="break-words min-w-0">{b.name}</span>
      </label>)}
    </div>
    <Button type="submit" disabled={busy || !target}><Check size={16} />Simpan Akses</Button>
    {message && <p role="status" className="text-sm break-words">{message}</p>}
  </form>
}
