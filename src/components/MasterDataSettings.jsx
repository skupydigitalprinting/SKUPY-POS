import React, { useState } from 'react'
import { MapPin, Phone, Landmark, FileText, Plus, Pencil, Trash2, Check, X, Loader2, Star } from 'lucide-react'
import { Input, Button } from './ui'
import { useToast } from './Toast'
import { useConfirm } from './Confirm'

const SUBTABS = [
  { id: 'alamat', label: 'Master Alamat', icon: MapPin },
  { id: 'kontak', label: 'Master Kontak', icon: Phone },
  { id: 'bank', label: 'Master Rekening', icon: Landmark },
  { id: 'profil', label: 'Profil Invoice Admin', icon: FileText },
]

const inp = { background: 'var(--bg-elevated)', border: '1px solid var(--border)', color: 'var(--text-primary)' }
const FIELD = 'w-full px-3 py-2.5 rounded-xl text-sm'

function Toggle({ checked, onChange, label }) {
  return (
    <label className="flex items-center gap-2 text-xs cursor-pointer" style={{ color: 'var(--text-secondary)' }}>
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} /> {label}
    </label>
  )
}

export default function MasterDataSettings({
  locations = [], contacts = [], banks = [], profiles = [], admins = [],
  addLocation, updateLocation, deleteLocation,
  addContact, updateContact, deleteContact,
  addStoreBank, updateStoreBank, deleteStoreBank,
  setAdminInvoiceProfile, invoiceProfileForAdmin,
}) {
  const toast = useToast()
  const confirm = useConfirm()
  const [sub, setSub] = useState('alamat')
  const [busy, setBusy] = useState(false)

  // ── generic form state per section ──
  const [locForm, setLocForm] = useState(null) // {id?, locationName, storeName, address, city, note, isActive}
  const [conForm, setConForm] = useState(null)
  const [bankForm, setBankForm] = useState(null)
  const [err, setErr] = useState('')

  const run = async (fn, okMsg, after) => {
    if (busy) return
    setBusy(true); setErr('')
    const r = await fn()
    setBusy(false)
    if (r?.ok) { toast.success(okMsg); after?.() } else setErr(r?.error || 'Gagal')
  }
  const del = async (label, fn) => {
    if (!(await confirm({ title: 'Hapus data ini?', message: `${label} disembunyikan. Invoice lama tetap memakai data saat dibuat.` }))) return
    const r = await fn()
    if (r?.ok) toast.success('Dihapus'); else toast.error(r?.error || 'Gagal')
  }

  const SubNav = (
    <div className="flex gap-1.5 mb-4 overflow-x-auto pb-1" style={{ scrollbarWidth: 'none' }}>
      {SUBTABS.map(({ id, label, icon: Icon }) => (
        <button key={id} onClick={() => { setSub(id); setErr('') }}
          className="flex-shrink-0 inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold whitespace-nowrap"
          style={{ background: sub === id ? 'linear-gradient(135deg, var(--accent), #6366f1)' : 'var(--bg-card)', color: sub === id ? '#fff' : 'var(--text-secondary)', border: `1px solid ${sub === id ? 'transparent' : 'var(--border)'}`, fontFamily: 'Syne' }}>
          <Icon size={13} /> {label}
        </button>
      ))}
    </div>
  )

  const Row = ({ title, subtitle, active, onEdit, onDelete }) => (
    <div className="flex items-center gap-3 p-3 rounded-xl" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', opacity: active === false ? 0.55 : 1 }}>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-xs font-bold truncate" style={{ color: 'var(--text-primary)', fontFamily: 'Syne' }}>{title}</span>
          {active === false && <span className="text-[9px] font-bold px-1.5 py-0.5 rounded" style={{ background: 'rgba(148,163,184,0.15)', color: 'var(--text-muted)' }}>NONAKTIF</span>}
        </div>
        <div className="text-[11px] mt-0.5 truncate" style={{ color: 'var(--text-muted)' }}>{subtitle}</div>
      </div>
      <button onClick={onEdit} className="w-8 h-8 rounded-lg inline-flex items-center justify-center flex-shrink-0" style={{ background: 'rgba(139,92,246,0.1)', color: 'var(--accent-light)' }}><Pencil size={12} /></button>
      <button onClick={onDelete} className="w-8 h-8 rounded-lg inline-flex items-center justify-center flex-shrink-0" style={{ background: 'rgba(255,77,106,0.08)', color: 'var(--red)' }}><Trash2 size={12} /></button>
    </div>
  )

  return (
    <div className="animate-fadeIn">
      {SubNav}
      {err && <div className="px-3 py-2 rounded-lg text-xs font-semibold mb-3" style={{ background: 'rgba(239,68,68,0.08)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.25)' }}>{err}</div>}

      {/* ALAMAT */}
      {sub === 'alamat' && (
        <div className="space-y-4">
          <div className="rounded-2xl p-4 space-y-3" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
            <div className="text-xs font-bold uppercase tracking-wider" style={{ color: 'var(--accent-light)', fontFamily: 'Syne' }}>{locForm?.id ? 'Edit Alamat' : 'Tambah Alamat'}</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Input label="Nama Lokasi / Cabang" value={locForm?.locationName || ''} onChange={e => setLocForm(p => ({ ...(p || {}), locationName: e.target.value }))} placeholder="Tanah Abang" />
              <Input label="Nama Toko" value={locForm?.storeName || ''} onChange={e => setLocForm(p => ({ ...(p || {}), storeName: e.target.value }))} placeholder="SKUPY" />
            </div>
            <Input label="Alamat Lengkap" value={locForm?.address || ''} onChange={e => setLocForm(p => ({ ...(p || {}), address: e.target.value }))} placeholder="Jl. ..." />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Input label="Kota" value={locForm?.city || ''} onChange={e => setLocForm(p => ({ ...(p || {}), city: e.target.value }))} placeholder="Jakarta Pusat" />
              <Input label="Catatan" value={locForm?.note || ''} onChange={e => setLocForm(p => ({ ...(p || {}), note: e.target.value }))} placeholder="Opsional" />
            </div>
            <Toggle checked={locForm?.isActive !== false} onChange={v => setLocForm(p => ({ ...(p || {}), isActive: v }))} label="Aktif" />
            <div className="flex gap-2">
              <Button variant="primary" className="flex-1" disabled={busy} onClick={() => run(
                () => locForm?.id ? updateLocation(locForm.id, locForm) : addLocation(locForm || {}),
                locForm?.id ? 'Alamat diperbarui' : 'Alamat ditambahkan', () => setLocForm(null))}>
                {busy ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Simpan
              </Button>
              {locForm?.id && <Button variant="secondary" onClick={() => setLocForm(null)}>Batal</Button>}
            </div>
          </div>
          <div className="space-y-2">
            {locations.length === 0 && <p className="text-xs text-center py-4" style={{ color: 'var(--text-muted)' }}>Belum ada alamat</p>}
            {locations.map(l => <Row key={l.id} title={`${l.location_name}${l.store_name ? ` · ${l.store_name}` : ''}`} subtitle={`${l.address}${l.city ? `, ${l.city}` : ''}`} active={l.is_active}
              onEdit={() => setLocForm({ id: l.id, locationName: l.location_name, storeName: l.store_name || '', address: l.address, city: l.city || '', note: l.note || '', isActive: l.is_active !== false })}
              onDelete={() => del(l.location_name, () => deleteLocation(l.id))} />)}
          </div>
        </div>
      )}

      {/* KONTAK */}
      {sub === 'kontak' && (
        <div className="space-y-4">
          <div className="rounded-2xl p-4 space-y-3" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
            <div className="text-xs font-bold uppercase tracking-wider" style={{ color: 'var(--accent-light)', fontFamily: 'Syne' }}>{conForm?.id ? 'Edit Kontak' : 'Tambah Kontak'}</div>
            <Input label="Nama Kontak" value={conForm?.contactName || ''} onChange={e => setConForm(p => ({ ...(p || {}), contactName: e.target.value }))} placeholder="CS SKUPY" />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Input label="Nomor Telepon" value={conForm?.phone || ''} onChange={e => setConForm(p => ({ ...(p || {}), phone: e.target.value }))} placeholder="021..." />
              <Input label="Nomor WhatsApp" value={conForm?.whatsapp || ''} onChange={e => setConForm(p => ({ ...(p || {}), whatsapp: e.target.value }))} placeholder="08..." />
            </div>
            <Input label="Catatan" value={conForm?.note || ''} onChange={e => setConForm(p => ({ ...(p || {}), note: e.target.value }))} placeholder="Opsional" />
            <Toggle checked={conForm?.isActive !== false} onChange={v => setConForm(p => ({ ...(p || {}), isActive: v }))} label="Aktif" />
            <div className="flex gap-2">
              <Button variant="primary" className="flex-1" disabled={busy} onClick={() => run(
                () => conForm?.id ? updateContact(conForm.id, conForm) : addContact(conForm || {}),
                conForm?.id ? 'Kontak diperbarui' : 'Kontak ditambahkan', () => setConForm(null))}>
                {busy ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Simpan
              </Button>
              {conForm?.id && <Button variant="secondary" onClick={() => setConForm(null)}>Batal</Button>}
            </div>
          </div>
          <div className="space-y-2">
            {contacts.length === 0 && <p className="text-xs text-center py-4" style={{ color: 'var(--text-muted)' }}>Belum ada kontak</p>}
            {contacts.map(c => <Row key={c.id} title={c.contact_name} subtitle={`Tel: ${c.phone || '-'} · WA: ${c.whatsapp || '-'}`} active={c.is_active}
              onEdit={() => setConForm({ id: c.id, contactName: c.contact_name, phone: c.phone || '', whatsapp: c.whatsapp || '', note: c.note || '', isActive: c.is_active !== false })}
              onDelete={() => del(c.contact_name, () => deleteContact(c.id))} />)}
          </div>
        </div>
      )}

      {/* BANK */}
      {sub === 'bank' && (
        <div className="space-y-4">
          <div className="rounded-2xl p-4 space-y-3" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
            <div className="text-xs font-bold uppercase tracking-wider" style={{ color: 'var(--accent-light)', fontFamily: 'Syne' }}>{bankForm?.id ? 'Edit Rekening' : 'Tambah Rekening'}</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Input label="Nama Bank" value={bankForm?.bankName || ''} onChange={e => setBankForm(p => ({ ...(p || {}), bankName: e.target.value }))} placeholder="BCA" />
              <Input label="Nomor Rekening" value={bankForm?.accountNumber || ''} onChange={e => setBankForm(p => ({ ...(p || {}), accountNumber: e.target.value }))} placeholder="1234567890" />
            </div>
            <Input label="Atas Nama" value={bankForm?.accountHolder || ''} onChange={e => setBankForm(p => ({ ...(p || {}), accountHolder: e.target.value }))} placeholder="Nama pemilik" />
            <Input label="Catatan" value={bankForm?.note || ''} onChange={e => setBankForm(p => ({ ...(p || {}), note: e.target.value }))} placeholder="Opsional" />
            <Toggle checked={bankForm?.isActive !== false} onChange={v => setBankForm(p => ({ ...(p || {}), isActive: v }))} label="Aktif" />
            <div className="flex gap-2">
              <Button variant="primary" className="flex-1" disabled={busy} onClick={() => run(
                () => bankForm?.id ? updateStoreBank(bankForm.id, bankForm) : addStoreBank(bankForm || {}),
                bankForm?.id ? 'Rekening diperbarui' : 'Rekening ditambahkan', () => setBankForm(null))}>
                {busy ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Simpan
              </Button>
              {bankForm?.id && <Button variant="secondary" onClick={() => setBankForm(null)}>Batal</Button>}
            </div>
          </div>
          <div className="space-y-2">
            {banks.length === 0 && <p className="text-xs text-center py-4" style={{ color: 'var(--text-muted)' }}>Belum ada rekening</p>}
            {banks.map(b => <Row key={b.id} title={`${b.bank_name} · ${b.account_number}`} subtitle={`a.n. ${b.account_holder}`} active={b.is_active}
              onEdit={() => setBankForm({ id: b.id, bankName: b.bank_name, accountNumber: b.account_number, accountHolder: b.account_holder, note: b.note || '', isActive: b.is_active !== false })}
              onDelete={() => del(b.bank_name, () => deleteStoreBank(b.id))} />)}
          </div>
        </div>
      )}

      {/* PROFIL INVOICE ADMIN */}
      {sub === 'profil' && (
        <div className="space-y-2">
          <p className="text-xs mb-2" style={{ color: 'var(--text-muted)' }}>Pilih alamat, kontak, dan rekening untuk tiap admin. Invoice yang dibuat admin otomatis memakai data ini (di-snapshot saat invoice dibuat).</p>
          {admins.map(a => {
            const cur = invoiceProfileForAdmin ? invoiceProfileForAdmin(a.id) : null
            const prof = cur?.profile
            return (
              <div key={a.id} className="rounded-2xl p-3.5 space-y-2.5" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
                <div className="text-xs font-bold" style={{ color: 'var(--text-primary)', fontFamily: 'Syne' }}>{a.name || a.username}{a.role === 'owner' ? ' · Owner' : ''}</div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  <select defaultValue={prof?.location_id || ''} className={FIELD} style={inp} data-admin={a.id} data-kind="loc">
                    <option value="">— Alamat —</option>
                    {locations.filter(l => l.is_active !== false).map(l => <option key={l.id} value={l.id}>{l.location_name}{l.store_name ? ` (${l.store_name})` : ''}</option>)}
                  </select>
                  <select defaultValue={prof?.contact_id || ''} className={FIELD} style={inp} data-admin={a.id} data-kind="con">
                    <option value="">— Kontak —</option>
                    {contacts.filter(c => c.is_active !== false).map(c => <option key={c.id} value={c.id}>{c.contact_name}</option>)}
                  </select>
                  <select defaultValue={prof?.bank_account_id || ''} className={FIELD} style={inp} data-admin={a.id} data-kind="bank">
                    <option value="">— Rekening —</option>
                    {banks.filter(b => b.is_active !== false).map(b => <option key={b.id} value={b.id}>{b.bank_name} · {b.account_number}</option>)}
                  </select>
                </div>
                <div className="flex justify-end">
                  <Button variant="primary" size="sm" disabled={busy} onClick={async (ev) => {
                    const root = ev.currentTarget.closest('[class*="rounded-2xl"]')
                    const get = (kind) => root.querySelector(`select[data-admin="${a.id}"][data-kind="${kind}"]`)?.value || ''
                    await run(() => setAdminInvoiceProfile(a.id, { locationId: get('loc'), contactId: get('con'), bankAccountId: get('bank') }), 'Profil invoice disimpan')
                  }}>
                    <Check size={13} /> Simpan Profil
                  </Button>
                </div>
              </div>
            )
          })}
          {admins.length === 0 && <p className="text-xs text-center py-4" style={{ color: 'var(--text-muted)' }}>Belum ada admin</p>}
        </div>
      )}
    </div>
  )
}

export { Star }
