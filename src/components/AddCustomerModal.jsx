import React, { useState } from 'react'
import { Loader2, UserPlus, Check } from 'lucide-react'
import Modal from './Modal'
import { useToast } from './Toast'

// Form Tambah Customer yang dipakai ulang (mis. dari Kasir). Memakai store.addCustomer
// yang sudah otomatis mengikuti Book aktif + PIC. onCreated(customer) dipanggil
// setelah sukses agar pemanggil bisa langsung memilih customer baru.
const EMPTY = { name: '', phone: '', whatsapp: '', address: '', notes: '', ownerUserId: '' }

export default function AddCustomerModal({ open, onClose, addCustomer, admins = [], currentUser, onCreated }) {
  const toast = useToast()
  const [form, setForm] = useState(EMPTY)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const canPickPIC = currentUser?.role === 'owner' || currentUser?.role === 'admin'

  const reset = () => { setForm(EMPTY); setErr(''); setBusy(false) }
  const close = () => { reset(); onClose?.() }

  const submit = async () => {
    if (busy) return
    if (!form.name.trim()) { setErr('Nama customer wajib diisi'); return }
    setBusy(true); setErr('')
    const r = await addCustomer({
      name: form.name.trim(),
      phone: (form.phone || '').trim(),
      whatsapp: (form.whatsapp || '').trim(),
      address: (form.address || '').trim(),
      notes: (form.notes || '').trim(),
      ownerUserId: form.ownerUserId || undefined, // kosong → default ke user login (di store)
    })
    setBusy(false)
    if (r?.ok) {
      toast.success('Customer ditambahkan')
      onCreated?.(r.data)
      reset()
      onClose?.()
    } else setErr(r?.error || 'Gagal menambah customer')
  }

  const inp = { background: 'var(--bg-card)', border: '1px solid var(--border)', color: 'var(--text-primary)' }
  const FIELD = 'w-full px-3 py-2.5 rounded-xl text-sm'
  const Label = ({ children, req }) => (
    <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--text-secondary)', fontFamily: 'Syne' }}>{children}{req && <span style={{ color: '#ef4444' }}> *</span>}</label>
  )

  return (
    <Modal open={open} onClose={close} title="Tambah Customer" subtitle="Customer baru otomatis masuk Book aktif" size="sm" zIndex={100000}>
      <div className="space-y-3">
        {err && <div className="px-3 py-2 rounded-lg text-xs font-semibold" style={{ background: 'rgba(239,68,68,0.08)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.25)' }}>{err}</div>}
        <div>
          <Label req>Nama Customer</Label>
          <input autoFocus value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} placeholder="Nama lengkap" className={FIELD} style={inp} onKeyDown={e => { if (e.key === 'Enter') submit() }} />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <Label>No HP</Label>
            <input value={form.phone} onChange={e => setForm(p => ({ ...p, phone: e.target.value }))} inputMode="tel" placeholder="08xxxx" className={FIELD} style={inp} />
          </div>
          <div>
            <Label>WhatsApp</Label>
            <input value={form.whatsapp} onChange={e => setForm(p => ({ ...p, whatsapp: e.target.value }))} inputMode="tel" placeholder="08xxxx" className={FIELD} style={inp} />
          </div>
        </div>
        <div>
          <Label>Alamat</Label>
          <input value={form.address} onChange={e => setForm(p => ({ ...p, address: e.target.value }))} placeholder="Alamat (opsional)" className={FIELD} style={inp} />
        </div>
        {canPickPIC && admins.length > 0 && (
          <div>
            <Label>PIC / Pemilik Customer</Label>
            <select value={form.ownerUserId} onChange={e => setForm(p => ({ ...p, ownerUserId: e.target.value }))} className={FIELD} style={inp}>
              <option value="">— Saya ({currentUser?.name || currentUser?.username || 'sendiri'}) —</option>
              {admins.map(a => <option key={a.id} value={a.id}>{a.name || a.username}</option>)}
            </select>
          </div>
        )}
        <div>
          <Label>Keterangan</Label>
          <input value={form.notes} onChange={e => setForm(p => ({ ...p, notes: e.target.value }))} placeholder="Catatan (opsional)" className={FIELD} style={inp} />
        </div>
        <button onClick={submit} disabled={busy} className="w-full py-2.5 rounded-xl text-sm font-bold btn-press inline-flex items-center justify-center gap-1.5" style={{ background: 'linear-gradient(135deg, var(--accent), #6366f1)', color: '#fff', fontFamily: 'Syne' }}>
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Simpan Customer
        </button>
      </div>
    </Modal>
  )
}

export { UserPlus }
