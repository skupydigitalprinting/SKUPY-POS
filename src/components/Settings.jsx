import React, { useState, useEffect } from 'react'
import {
  Store, Image, Users, Lock, LogOut, ImagePlus,
  CheckCircle2, AlertCircle, UserPlus, Trash2, Crown,
  Eye, EyeOff, Loader2, Pencil, Check, Tag, Plus, Power, Landmark, Star,
} from 'lucide-react'
import Modal from './Modal'
import { Input, Button } from './ui'
import Logo from './Logo'
import { useConfirm } from './Confirm'
import { useCategories } from '../hooks/useCategories'
import { ROLE_OPTIONS, roleLabel, compressImage } from '../utils/helpers'

const TABS = [
  { id: 'toko', label: 'Toko', icon: Store },
  { id: 'kategori', label: 'Kategori Produk', icon: Tag },
  { id: 'logo', label: 'Logo', icon: Image },
  { id: 'admin', label: 'Admin', icon: Users },
  { id: 'rekening', label: 'Rekening Bank', icon: Landmark },
  { id: 'password', label: 'Password', icon: Lock },
]

const CAT_COLORS = ['#8b5cf6', '#3b82f6', '#10d98a', '#f59e0b', '#ef4444', '#ec4899', '#14b8a6', '#64748b']
const CAT_EMOJIS = ['👕', '👚', '🧥', '🩳', '🧢', '🚩', '✨', '🖨️', '🎒', '📦', '🎨', '🧵', '📏', '🏷️', '🔖', '⭐']

function Banner({ kind = 'success', children }) {
  const map = {
    success: { bg: 'rgba(16,217,138,0.08)', color: '#10d98a', border: 'rgba(16,217,138,0.25)', Icon: CheckCircle2 },
    error: { bg: 'rgba(255,77,106,0.08)', color: '#ff4d6a', border: 'rgba(255,77,106,0.25)', Icon: AlertCircle },
  }
  const c = map[kind]
  const Icon = c.Icon
  return (
    <div className="flex items-center gap-2 px-3 py-2.5 rounded-xl text-xs font-semibold animate-fadeIn"
      style={{ background: c.bg, color: c.color, border: `1px solid ${c.border}` }}>
      <Icon size={13} />
      {children}
    </div>
  )
}

export default function Settings({
  open, onClose,
  storeInfo, admins, currentUser, busy, products = [],
  updateStoreInfo, updateLogo,
  addAdmin, updateAdmin, deleteAdmin, changePassword, logout, reassignAdminCustomers,
  adminBankAccounts = [], addBankAccount, updateBankAccount, deleteBankAccount,
}) {
  const confirm = useConfirm()
  const { addCategory, updateCategory, deleteCategory, setCategoryActive, listAllCategories } = useCategories()
  // ── Kategori Produk (manajemen) ──
  const [catList, setCatList] = useState([])
  const [catModal, setCatModal] = useState(null) // { id?, label, icon, color, thumbnail, active }
  const [catErr, setCatErr] = useState('')
  const [catBusy, setCatBusy] = useState(false)
  const blankCat = { label: '', icon: '📦', color: CAT_COLORS[0], thumbnail: '', active: true }
  const loadCats = async () => { try { setCatList(await listAllCategories()) } catch { /* ignore */ } }
  const catCount = (id) => (products || []).filter(p => (p.category || '') === id).length
  const onCatThumb = async (file) => {
    if (!file) return
    try { const url = await compressImage(file, { maxSize: 200, quality: 0.7 }); setCatModal(p => ({ ...p, thumbnail: url })) }
    catch { setCatErr('Gagal memproses gambar') }
  }
  const saveCat = () => {
    if (!catModal || catBusy) return
    setCatErr('')
    if (!catModal.label.trim()) return setCatErr('Nama kategori wajib diisi')
    setCatBusy(true)
    const payload = { label: catModal.label, icon: catModal.icon, color: catModal.color, thumbnail: catModal.thumbnail || null, active: catModal.active }
    const res = catModal.id ? updateCategory(catModal.id, payload) : addCategory(payload)
    setCatBusy(false)
    if (!res.ok) return setCatErr(res.error || 'Gagal menyimpan')
    flash('success', catModal.id ? 'Kategori diperbarui' : 'Kategori ditambahkan')
    setCatModal(null); loadCats()
  }
  const handleCatDelete = async (cat) => {
    const used = catCount(cat.id)
    if (used > 0) {
      if (!(await confirm({
        title: 'Kategori masih dipakai produk',
        message: `${used} produk memakai kategori ini. Kategori akan DINONAKTIFKAN (bukan dihapus permanen). Produk lama tetap memakai nama kategori terakhir.`,
        confirmLabel: 'Nonaktifkan', danger: false,
      }))) return
      setCategoryActive(cat.id, false); flash('success', 'Kategori dinonaktifkan'); loadCats()
    } else {
      if (!(await confirm({ title: 'Yakin ingin menghapus kategori ini?', message: 'Kategori tidak dipakai produk mana pun dan akan dihapus.' }))) return
      const r = deleteCategory(cat.id)
      if (r.ok) { flash('success', 'Kategori dihapus'); loadCats() } else flash('error', r.error)
    }
  }
  const [tab, setTab] = useState('toko')
  const [msg, setMsg] = useState(null)
  // ── Rekening Bank per admin (owner only) ──
  const blankBank = { adminId: '', bankName: '', accountNumber: '', accountHolder: '', branch: '', note: '', isActive: true, isDefault: false }
  const [bankForm, setBankForm] = useState(blankBank)
  const [bankEditId, setBankEditId] = useState(null)
  const [bankErr, setBankErr] = useState('')
  const [bankBusy, setBankBusy] = useState(false)
  const adminLabel = (id) => { const a = admins.find(x => x.id === id); return a ? (a.name || a.username) : '—' }
  const resetBankForm = () => { setBankForm(blankBank); setBankEditId(null); setBankErr('') }
  const submitBank = async () => {
    if (bankBusy) return
    setBankErr('')
    if (!bankForm.adminId) return setBankErr('Pilih admin dulu')
    if (!bankForm.bankName.trim()) return setBankErr('Nama bank wajib diisi')
    if (!bankForm.accountNumber.trim()) return setBankErr('Nomor rekening wajib diisi')
    if (!bankForm.accountHolder.trim()) return setBankErr('Atas nama wajib diisi')
    setBankBusy(true)
    const r = bankEditId ? await updateBankAccount(bankEditId, bankForm) : await addBankAccount(bankForm)
    setBankBusy(false)
    if (r?.ok) { flash('success', bankEditId ? 'Rekening diperbarui' : 'Rekening ditambahkan'); resetBankForm() }
    else setBankErr(r?.error || 'Gagal menyimpan rekening')
  }
  const editBank = (b) => { setBankEditId(b.id); setBankErr(''); setBankForm({ adminId: b.admin_id, bankName: b.bank_name, accountNumber: b.account_number, accountHolder: b.account_holder, branch: b.branch || '', note: b.note || '', isActive: b.is_active !== false, isDefault: !!b.is_default }) }
  const removeBank = async (b) => {
    if (!(await confirm({ title: 'Hapus rekening ini?', message: `${b.bank_name} · ${b.account_number} (${adminLabel(b.admin_id)}). Rekening disembunyikan dari invoice baru; invoice lama tetap menyimpan rekening saat dibuat.` }))) return
    const r = await deleteBankAccount(b.id)
    if (r?.ok) { flash('success', 'Rekening dihapus'); if (bankEditId === b.id) resetBankForm() } else flash('error', r?.error || 'Gagal')
  }
  const [savingToko, setSavingToko] = useState(false)
  const [uploading, setUploading] = useState({ frontLogo: false, invoiceLogo: false })
  const [addingAdmin, setAddingAdmin] = useState(false)
  const [changingPass, setChangingPass] = useState(false)
  const [deletingId, setDeletingId] = useState(null)
  // Edit Admin (Owner only)
  const [editAdmin, setEditAdmin] = useState(null) // { id, username, name, role, password, confirm }
  const [editShowPass, setEditShowPass] = useState(false)
  const [savingEdit, setSavingEdit] = useState(false)
  const [editErr, setEditErr] = useState('')
  const isOwnerUser = currentUser?.role === 'owner'

  const saveEditAdmin = async () => {
    if (!editAdmin || savingEdit) return
    setEditErr('')
    const u = (editAdmin.username || '').trim().toLowerCase()
    if (!u) return setEditErr('Username wajib diisi')
    if (/\s/.test(u)) return setEditErr('Username tidak boleh mengandung spasi')
    if (admins.some(a => a.id !== editAdmin.id && (a.username || '').toLowerCase() === u)) return setEditErr('Username sudah dipakai admin lain')
    const pass = (editAdmin.password || '').trim()
    if (pass) {
      if (pass.length < 4) return setEditErr('Password baru minimal 4 karakter')
      if (pass !== (editAdmin.confirm || '')) return setEditErr('Konfirmasi password tidak cocok')
    }
    // Konfirmasi khusus saat mengganti password admin LAIN
    if (pass && editAdmin.id !== currentUser?.id) {
      if (!(await confirm({ title: 'Yakin ingin mengganti password admin ini?', message: `Password untuk @${u} akan diganti.`, confirmLabel: 'Ya, Ganti', danger: false }))) return
    }
    setSavingEdit(true)
    const res = await updateAdmin(editAdmin.id, {
      username: u, name: editAdmin.name, role: editAdmin.role,
      ...(pass ? { password: pass } : {}),
    })
    setSavingEdit(false)
    if (res.ok) { flash('success', 'Admin diperbarui'); setEditAdmin(null); setEditShowPass(false) }
    else setEditErr(res.error || 'Gagal menyimpan')
  }

  const [tokoForm, setTokoForm] = useState({
    name: '', tagline: '', address: '', phone: '',
    bankName: '', bankNumber: '', bankHolder: '',
  })

  useEffect(() => {
    if (open && storeInfo) {
      setTokoForm({
        name: storeInfo.name || '',
        tagline: storeInfo.tagline || '',
        address: storeInfo.address || '',
        phone: storeInfo.phone || '',
        bankName: storeInfo.bank?.name || '',
        bankNumber: storeInfo.bank?.number || '',
        bankHolder: storeInfo.bank?.holder || '',
      })
      setMsg(null)
    }
  }, [open, storeInfo])

  // Muat daftar kategori saat membuka tab Kategori Produk.
  useEffect(() => {
    if (open && tab === 'kategori') loadCats()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tab])

  const flash = (kind, text) => {
    setMsg({ kind, text })
    setTimeout(() => setMsg(null), 3200)
  }

  const handleSaveToko = async () => {
    setSavingToko(true)
    try {
      const res = await updateStoreInfo({
        name: tokoForm.name.trim(),
        tagline: tokoForm.tagline.trim(),
        address: tokoForm.address.trim(),
        phone: tokoForm.phone.trim(),
        bank: {
          name: tokoForm.bankName.trim(),
          number: tokoForm.bankNumber.trim(),
          holder: tokoForm.bankHolder.trim(),
        },
      })
      if (res.ok) flash('success', 'Info toko berhasil disimpan')
      else flash('error', res.error || 'Gagal menyimpan')
    } finally {
      setSavingToko(false)
    }
  }

  const handleLogoUpload = async (type, e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    if (file.size > 2_500_000) return flash('error', 'Ukuran maksimal 2.5 MB')
    setUploading(prev => ({ ...prev, [type]: true }))
    try {
      const res = await updateLogo(type, file)
      if (res.ok) flash('success', `Logo ${type === 'frontLogo' ? 'depan' : 'invoice'} diunggah`)
      else flash('error', res.error || 'Gagal upload')
    } finally {
      setUploading(prev => ({ ...prev, [type]: false }))
    }
  }

  const handleLogoReset = async (type) => {
    setUploading(prev => ({ ...prev, [type]: true }))
    try {
      const res = await updateLogo(type, null)
      if (res.ok) flash('success', `Logo ${type === 'frontLogo' ? 'depan' : 'invoice'} dikembalikan ke default`)
      else flash('error', res.error || 'Gagal reset')
    } finally {
      setUploading(prev => ({ ...prev, [type]: false }))
    }
  }

  const [newAdmin, setNewAdmin] = useState({ username: '', name: '', password: '', role: 'staff' })

  const handleAddAdmin = async () => {
    setAddingAdmin(true)
    try {
      const res = await addAdmin(newAdmin)
      if (res.ok) {
        flash('success', `Admin "${newAdmin.username}" ditambahkan`)
        setNewAdmin({ username: '', name: '', password: '', role: 'staff' })
      } else {
        flash('error', res.error || 'Gagal menambah admin')
      }
    } finally {
      setAddingAdmin(false)
    }
  }

  const [reassignAdmin, setReassignAdmin] = useState(null) // { id, count, toId }
  const handleDeleteAdmin = async (id) => {
    if (!(await confirm({ title: 'Hapus admin ini?', message: 'Akun admin akan dihapus dan tidak bisa login lagi. Tindakan ini bisa memengaruhi data terkait.' }))) return
    setDeletingId(id)
    try {
      const res = await deleteAdmin(id)
      if (res.ok) { flash('success', 'Admin dihapus'); return }
      if (res.needsReassign) {
        // Admin masih jadi PIC customer → minta pindahkan dulu.
        const others = admins.filter(a => a.id !== id)
        setReassignAdmin({ id, count: res.customerCount || 0, toId: others[0]?.id || '' })
        return
      }
      flash('error', res.error || 'Gagal menghapus')
    } finally {
      setDeletingId(null)
    }
  }
  const confirmReassignAndDelete = async () => {
    if (!reassignAdmin?.toId) return flash('error', 'Pilih admin tujuan')
    const rr = await reassignAdminCustomers(reassignAdmin.id, reassignAdmin.toId)
    if (!rr.ok) return flash('error', rr.error || 'Gagal memindahkan customer')
    const del = await deleteAdmin(reassignAdmin.id)
    if (del.ok) { flash('success', 'Customer dipindahkan & admin dihapus'); setReassignAdmin(null) }
    else flash('error', del.error || 'Gagal menghapus admin')
  }

  const [passForm, setPassForm] = useState({ old: '', new1: '', new2: '' })
  const [showPass, setShowPass] = useState(false)

  const handleChangePass = async () => {
    if (passForm.new1 !== passForm.new2) return flash('error', 'Password baru tidak cocok')
    setChangingPass(true)
    try {
      const res = await changePassword(passForm.old, passForm.new1)
      if (res.ok) {
        flash('success', 'Password berhasil diubah')
        setPassForm({ old: '', new1: '', new2: '' })
      } else {
        flash('error', res.error || 'Gagal mengubah password')
      }
    } finally {
      setChangingPass(false)
    }
  }

  return (
    <>
    <Modal
      open={open}
      onClose={onClose}
      title="Pengaturan"
      subtitle={`Login sebagai ${currentUser?.name || currentUser?.username || '—'}`}
      size="lg"
    >
      <div className="flex flex-col sm:flex-row gap-4">
        <div className="flex sm:flex-col gap-1 sm:w-44 flex-shrink-0 overflow-x-auto sm:overflow-visible no-scrollbar">
          {TABS.map(({ id, label, icon: Icon }) => {
            const active = tab === id
            return (
              <button
                key={id}
                onClick={() => setTab(id)}
                className="flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-sm font-semibold transition-all flex-shrink-0 sm:flex-shrink-1"
                style={{
                  background: active ? 'rgba(139,92,246,0.12)' : 'transparent',
                  color: active ? 'var(--accent-light)' : 'var(--text-secondary)',
                  border: `1px solid ${active ? 'rgba(139,92,246,0.3)' : 'transparent'}`,
                  fontFamily: 'Syne',
                }}
              >
                <Icon size={15} />
                {label}
              </button>
            )
          })}
          <button
            onClick={logout}
            className="flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-sm font-semibold transition-all sm:mt-auto sm:mb-0 flex-shrink-0"
            style={{
              background: 'rgba(255,77,106,0.08)',
              color: 'var(--red)',
              border: '1px solid rgba(255,77,106,0.2)',
              fontFamily: 'Syne',
            }}
          >
            <LogOut size={15} />
            Logout
          </button>
        </div>

        <div className="flex-1 min-w-0">
          {msg && <div className="mb-3"><Banner kind={msg.kind}>{msg.text}</Banner></div>}

          {/* === TOKO === */}
          {tab === 'toko' && (
            <div className="space-y-3 animate-fadeIn">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Input label="Nama Toko" value={tokoForm.name}
                  onChange={e => setTokoForm(p => ({ ...p, name: e.target.value }))} />
                <Input label="Tagline" value={tokoForm.tagline}
                  onChange={e => setTokoForm(p => ({ ...p, tagline: e.target.value }))} />
              </div>
              <div>
                <label className="block text-xs font-semibold mb-1.5"
                  style={{ color: 'var(--text-secondary)', fontFamily: 'Syne' }}>
                  Alamat Lengkap
                </label>
                <textarea
                  rows={3}
                  value={tokoForm.address}
                  onChange={e => setTokoForm(p => ({ ...p, address: e.target.value }))}
                  className="w-full px-3 py-2.5 rounded-xl text-sm transition-all resize-none"
                  style={{
                    background: 'var(--bg-card)',
                    border: '1px solid var(--border)',
                    color: 'var(--text-primary)',
                    fontFamily: 'DM Sans',
                  }}
                />
              </div>
              <Input label="Nomor HP / Telepon" value={tokoForm.phone}
                onChange={e => setTokoForm(p => ({ ...p, phone: e.target.value }))} />

              <div className="rounded-xl p-4"
                style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
                <div className="text-xs font-semibold mb-3"
                  style={{ color: 'var(--accent-light)', fontFamily: 'Syne', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                  🏦 Rekening Bank
                </div>
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <Input label="Nama Bank" value={tokoForm.bankName}
                      onChange={e => setTokoForm(p => ({ ...p, bankName: e.target.value }))} placeholder="Bank BCA" />
                    <Input label="No Rekening" value={tokoForm.bankNumber}
                      onChange={e => setTokoForm(p => ({ ...p, bankNumber: e.target.value }))} placeholder="2065033222" />
                  </div>
                  <Input label="Atas Nama" value={tokoForm.bankHolder}
                    onChange={e => setTokoForm(p => ({ ...p, bankHolder: e.target.value }))} placeholder="Nama pemilik rekening" />
                </div>
              </div>

              <div className="flex justify-end pt-2">
                <Button variant="primary" onClick={handleSaveToko} disabled={savingToko}>
                  {savingToko ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
                  {savingToko ? 'Menyimpan...' : 'Simpan Perubahan'}
                </Button>
              </div>
            </div>
          )}

          {/* === KATEGORI PRODUK === */}
          {tab === 'kategori' && (
            <div className="space-y-4 animate-fadeIn">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Kategori dipakai di Tambah/Edit Produk, Filter, & Distribusi Kategori. Tersimpan permanen di database.</p>
                <Button variant="primary" size="sm" onClick={() => { setCatModal({ ...blankCat }); setCatErr('') }}><Plus size={13} /> Tambah Kategori</Button>
              </div>

              <div className="space-y-2">
                {catList.length === 0 && <p className="text-xs text-center py-4" style={{ color: 'var(--text-muted)' }}>Memuat kategori…</p>}
                {catList.map(c => {
                  const used = catCount(c.id)
                  const col = c.color || '#8b5cf6'
                  return (
                    <div key={c.id} className="flex items-center gap-3 p-3 rounded-xl min-w-0" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', opacity: c.active ? 1 : 0.6 }}>
                      {c.thumbnail
                        ? <img src={c.thumbnail} alt="" className="w-10 h-10 rounded-lg object-cover flex-shrink-0" style={{ border: `1px solid ${col}55` }} />
                        : <div className="w-10 h-10 rounded-lg flex items-center justify-center text-lg flex-shrink-0" style={{ background: `${col}1f`, border: `1px solid ${col}55` }}>{c.icon || '📦'}</div>}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)', fontFamily: 'Syne' }}>{c.label}</span>
                          <span className="text-[10px] px-1.5 py-0.5 rounded font-bold flex-shrink-0" style={{ background: c.active ? 'rgba(16,217,138,0.12)' : 'rgba(136,136,168,0.15)', color: c.active ? '#10d98a' : 'var(--text-muted)' }}>{c.active ? 'Aktif' : 'Nonaktif'}</span>
                        </div>
                        <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{used} produk</div>
                      </div>
                      {!c.active && (
                        <button onClick={() => { setCategoryActive(c.id, true); flash('success', 'Kategori diaktifkan'); loadCats() }} className="px-2.5 h-8 rounded-lg flex items-center gap-1 text-xs font-semibold btn-press flex-shrink-0" style={{ background: 'rgba(16,217,138,0.1)', color: '#10d98a', border: '1px solid rgba(16,217,138,0.2)', fontFamily: 'Syne' }} title="Aktifkan"><Power size={12} /></button>
                      )}
                      <button onClick={() => { setCatModal({ id: c.id, label: c.label, icon: c.icon || '📦', color: col, thumbnail: c.thumbnail || '', active: c.active }); setCatErr('') }} className="w-8 h-8 rounded-lg flex items-center justify-center btn-press flex-shrink-0" style={{ background: 'rgba(139,92,246,0.1)', color: 'var(--accent-light)', border: '1px solid rgba(139,92,246,0.2)' }} title="Edit"><Pencil size={12} /></button>
                      <button onClick={() => handleCatDelete(c)} className="w-8 h-8 rounded-lg flex items-center justify-center btn-press flex-shrink-0" style={{ background: 'rgba(255,77,106,0.08)', color: 'var(--red)', border: '1px solid rgba(255,77,106,0.15)' }} title={used > 0 ? 'Nonaktifkan' : 'Hapus'}>{used > 0 ? <Power size={12} /> : <Trash2 size={12} />}</button>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* === LOGO === */}
          {tab === 'logo' && (
            <div className="space-y-4 animate-fadeIn">
              <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                Logo di-upload ke Supabase Storage (bucket <code style={{ color: 'var(--accent-light)' }}>logos</code>).
                Format PNG/JPG, max 2.5 MB.
              </p>

              {[
                { type: 'frontLogo', title: 'Logo Tampilan Depan', desc: 'Muncul di sidebar, login, dan dashboard', onLight: false },
                { type: 'invoiceLogo', title: 'Logo Invoice', desc: 'Muncul di header invoice cetak', onLight: true },
              ].map(({ type, title, desc, onLight }) => (
                <div key={type} className="rounded-xl p-4"
                  style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
                  <div className="flex items-center justify-between mb-3 gap-3">
                    <div className="min-w-0">
                      <div className="text-sm font-bold" style={{ fontFamily: 'Syne', color: 'var(--text-primary)' }}>
                        {title}
                      </div>
                      <div className="text-xs" style={{ color: 'var(--text-muted)' }}>{desc}</div>
                    </div>
                    <div className="rounded-xl p-2 flex-shrink-0"
                      style={{ background: onLight ? '#fff' : 'var(--bg-elevated)', border: '1px solid var(--border)' }}>
                      <Logo size={56} customSrc={storeInfo?.[type]} onLight={onLight} />
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <label
                      className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-xs font-semibold btn-press ${uploading[type] ? 'cursor-wait opacity-60' : 'cursor-pointer'}`}
                      style={{
                        background: 'linear-gradient(135deg, var(--accent), #6366f1)',
                        color: '#fff', fontFamily: 'Syne',
                      }}
                    >
                      {uploading[type] ? (
                        <>
                          <Loader2 size={13} className="animate-spin" />
                          Mengunggah...
                        </>
                      ) : (
                        <>
                          <ImagePlus size={13} />
                          Upload {title}
                        </>
                      )}
                      <input type="file" accept="image/*" className="hidden"
                        disabled={uploading[type]}
                        onChange={e => handleLogoUpload(type, e)} />
                    </label>
                    {storeInfo?.[type] && (
                      <button
                        onClick={() => handleLogoReset(type)}
                        disabled={uploading[type]}
                        className="px-3 py-2.5 rounded-xl text-xs font-semibold btn-press disabled:opacity-50"
                        style={{
                          background: 'rgba(255,77,106,0.1)',
                          color: 'var(--red)',
                          border: '1px solid rgba(255,77,106,0.2)',
                          fontFamily: 'Syne',
                        }}
                      >
                        Reset
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* === ADMIN === */}
          {tab === 'admin' && (
            <div className="space-y-4 animate-fadeIn">
              <div className="space-y-2">
                {admins.map(a => {
                  const isMe = currentUser?.id === a.id
                  const isOwner = a.role === 'owner'
                  const isDeleting = deletingId === a.id
                  return (
                    <div key={a.id}
                      className="flex items-center gap-3 p-3 rounded-xl"
                      style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
                      <div className="w-9 h-9 rounded-xl flex items-center justify-center text-xs font-bold flex-shrink-0"
                        style={{
                          background: isOwner
                            ? 'linear-gradient(135deg, #f59e0b, #ea580c)'
                            : 'linear-gradient(135deg, var(--accent), #6366f1)',
                          color: '#fff', fontFamily: 'Syne',
                        }}>
                        {(a.username || '?')[0].toUpperCase()}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="text-sm font-semibold truncate"
                            style={{ color: 'var(--text-primary)' }}>
                            {a.name || a.username}
                          </span>
                          {isOwner && <Crown size={11} style={{ color: '#f59e0b' }} />}
                          {isMe && (
                            <span className="text-xs px-1.5 py-0.5 rounded font-semibold"
                              style={{ background: 'rgba(16,217,138,0.12)', color: '#10d98a', fontFamily: 'Syne' }}>
                              YOU
                            </span>
                          )}
                        </div>
                        <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                          @{a.username} · {roleLabel(a.role)}
                        </div>
                      </div>
                      {isOwnerUser && (
                        <button
                          onClick={() => { setEditAdmin({ id: a.id, username: a.username || '', name: a.name || '', role: a.role || 'staff', password: '', confirm: '' }); setEditShowPass(false); setEditErr('') }}
                          className="px-2.5 h-8 rounded-lg flex items-center gap-1 text-xs font-semibold btn-press flex-shrink-0"
                          style={{ background: 'rgba(139,92,246,0.1)', color: 'var(--accent-light)', border: '1px solid rgba(139,92,246,0.2)', fontFamily: 'Syne' }}
                          title="Edit Admin"
                        >
                          <Pencil size={12} /> <span className="hidden sm:inline">Edit</span>
                        </button>
                      )}
                      {!isMe && (
                        <button
                          onClick={() => handleDeleteAdmin(a.id)}
                          disabled={isDeleting}
                          className="w-8 h-8 rounded-lg flex items-center justify-center btn-press disabled:opacity-60 flex-shrink-0"
                          style={{
                            background: 'rgba(255,77,106,0.08)',
                            color: 'var(--red)',
                            border: '1px solid rgba(255,77,106,0.15)',
                          }}
                        >
                          {isDeleting ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                        </button>
                      )}
                    </div>
                  )
                })}
              </div>

              <div className="rounded-xl p-4"
                style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
                <div className="text-xs font-semibold mb-3"
                  style={{ color: 'var(--accent-light)', fontFamily: 'Syne', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                  ➕ Tambah Admin Baru
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
                  <Input label="Username" value={newAdmin.username}
                    onChange={e => setNewAdmin(p => ({ ...p, username: e.target.value }))}
                    placeholder="cth: kasir1" />
                  <Input label="Nama Lengkap" value={newAdmin.name}
                    onChange={e => setNewAdmin(p => ({ ...p, name: e.target.value }))}
                    placeholder="Nama tampilan" />
                  <Input label="Password" type="password" value={newAdmin.password}
                    onChange={e => setNewAdmin(p => ({ ...p, password: e.target.value }))}
                    placeholder="min 4 karakter" />
                  <div>
                    <label className="block text-xs font-semibold mb-1.5"
                      style={{ color: 'var(--text-secondary)', fontFamily: 'Syne' }}>
                      Role
                    </label>
                    <select
                      value={newAdmin.role}
                      onChange={e => setNewAdmin(p => ({ ...p, role: e.target.value }))}
                      className="w-full px-3 py-2.5 rounded-xl text-sm"
                      style={{
                        background: 'var(--bg-elevated)',
                        border: '1px solid var(--border)',
                        color: 'var(--text-primary)',
                      }}
                    >
                      {ROLE_OPTIONS.map(r => (
                        <option key={r.id} value={r.id}>{r.label}</option>
                      ))}
                    </select>
                    <p className="text-[11px] mt-1.5 leading-snug" style={{ color: 'var(--text-muted)' }}>
                      Owner: akses penuh + laba-rugi · Staff Admin: lihat dashboard · Staff Kasir: hanya kasir
                    </p>
                  </div>
                </div>
                <Button variant="primary" className="w-full" onClick={handleAddAdmin} disabled={addingAdmin}>
                  {addingAdmin ? <Loader2 size={14} className="animate-spin" /> : <UserPlus size={14} />}
                  {addingAdmin ? 'Menyimpan...' : 'Tambah Admin'}
                </Button>
              </div>
            </div>
          )}

          {/* === REKENING BANK (owner only) === */}
          {tab === 'rekening' && (
            <div className="space-y-4 animate-fadeIn">
              <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                Atur rekening bank per admin. Invoice otomatis memakai rekening default admin pembuat transaksi. Invoice lama tetap menyimpan rekening saat dibuat.
              </p>

              {/* Form tambah/edit */}
              <div className="rounded-2xl p-4 space-y-3" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
                <div className="text-xs font-bold uppercase tracking-wider" style={{ color: 'var(--accent-light)', fontFamily: 'Syne' }}>{bankEditId ? 'Edit Rekening' : 'Tambah Rekening'}</div>
                {bankErr && <Banner kind="error">{bankErr}</Banner>}
                <div>
                  <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--text-secondary)' }}>Pilih Admin <span style={{ color: '#ef4444' }}>*</span></label>
                  <select value={bankForm.adminId} onChange={e => setBankForm(p => ({ ...p, adminId: e.target.value }))} className="w-full px-3 py-2.5 rounded-xl text-sm" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}>
                    <option value="">— Pilih admin —</option>
                    {admins.map(a => <option key={a.id} value={a.id}>{a.name || a.username}{a.role === 'owner' ? ' (Owner)' : ''}</option>)}
                  </select>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <Input label="Nama Bank" value={bankForm.bankName} onChange={e => setBankForm(p => ({ ...p, bankName: e.target.value }))} placeholder="BCA / BRI / Mandiri" />
                  <Input label="Nomor Rekening" value={bankForm.accountNumber} onChange={e => setBankForm(p => ({ ...p, accountNumber: e.target.value }))} placeholder="1234567890" />
                </div>
                <Input label="Atas Nama" value={bankForm.accountHolder} onChange={e => setBankForm(p => ({ ...p, accountHolder: e.target.value }))} placeholder="Nama pemilik rekening" />
                <Input label="Cabang / Catatan" value={bankForm.branch} onChange={e => setBankForm(p => ({ ...p, branch: e.target.value }))} placeholder="Opsional" />
                <div className="flex items-center gap-4 flex-wrap">
                  <label className="flex items-center gap-2 text-xs cursor-pointer" style={{ color: 'var(--text-secondary)' }}>
                    <input type="checkbox" checked={bankForm.isActive} onChange={e => setBankForm(p => ({ ...p, isActive: e.target.checked }))} /> Aktif
                  </label>
                  <label className="flex items-center gap-2 text-xs cursor-pointer" style={{ color: 'var(--text-secondary)' }}>
                    <input type="checkbox" checked={bankForm.isDefault} onChange={e => setBankForm(p => ({ ...p, isDefault: e.target.checked }))} /> Jadikan rekening default admin ini
                  </label>
                </div>
                <div className="flex gap-2">
                  <Button variant="primary" className="flex-1" onClick={submitBank} disabled={bankBusy}>{bankBusy ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} {bankEditId ? 'Simpan Perubahan' : 'Simpan Rekening'}</Button>
                  {bankEditId && <Button variant="secondary" onClick={resetBankForm}>Batal</Button>}
                </div>
              </div>

              {/* Daftar rekening per admin */}
              <div className="space-y-2">
                <div className="text-xs font-bold uppercase tracking-wider" style={{ color: 'var(--text-muted)', fontFamily: 'Syne' }}>Daftar Rekening</div>
                {adminBankAccounts.length === 0 && <p className="text-xs text-center py-6" style={{ color: 'var(--text-muted)' }}>Belum ada rekening</p>}
                {adminBankAccounts.map(b => (
                  <div key={b.id} className="flex items-center gap-3 p-3 rounded-xl" style={{ background: 'var(--bg-card)', border: `1px solid ${b.is_default ? 'rgba(16,217,138,0.35)' : 'var(--border)'}`, opacity: b.is_active === false ? 0.55 : 1 }}>
                    <div className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: 'rgba(139,92,246,0.12)', border: '1px solid rgba(139,92,246,0.25)' }}><Landmark size={15} style={{ color: 'var(--accent-light)' }} /></div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-xs font-bold truncate" style={{ color: 'var(--text-primary)', fontFamily: 'Syne' }}>{b.bank_name} · {b.account_number}</span>
                        {b.is_default && <span className="inline-flex items-center gap-0.5 text-[9px] font-bold px-1.5 py-0.5 rounded" style={{ background: 'rgba(16,217,138,0.12)', color: '#10d98a' }}><Star size={8} /> DEFAULT</span>}
                        {b.is_active === false && <span className="text-[9px] font-bold px-1.5 py-0.5 rounded" style={{ background: 'rgba(148,163,184,0.15)', color: 'var(--text-muted)' }}>NONAKTIF</span>}
                      </div>
                      <div className="text-[11px] mt-0.5 truncate" style={{ color: 'var(--text-muted)' }}>a.n. {b.account_holder} · PIC: <b style={{ color: 'var(--text-secondary)' }}>{adminLabel(b.admin_id)}</b>{b.branch ? ` · ${b.branch}` : ''}</div>
                    </div>
                    <button onClick={() => editBank(b)} className="w-8 h-8 rounded-lg inline-flex items-center justify-center flex-shrink-0" style={{ background: 'rgba(139,92,246,0.1)', color: 'var(--accent-light)' }} title="Edit"><Pencil size={12} /></button>
                    <button onClick={() => removeBank(b)} className="w-8 h-8 rounded-lg inline-flex items-center justify-center flex-shrink-0" style={{ background: 'rgba(255,77,106,0.08)', color: 'var(--red)' }} title="Hapus"><Trash2 size={12} /></button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* === PASSWORD === */}
          {tab === 'password' && (
            <div className="space-y-3 animate-fadeIn">
              <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                Ganti password untuk akun <strong style={{ color: 'var(--text-primary)' }}>{currentUser?.username}</strong>.
              </p>
              <div>
                <label className="block text-xs font-semibold mb-1.5"
                  style={{ color: 'var(--text-secondary)', fontFamily: 'Syne' }}>
                  Password Lama
                </label>
                <div className="relative">
                  <input
                    type={showPass ? 'text' : 'password'}
                    value={passForm.old}
                    onChange={e => setPassForm(p => ({ ...p, old: e.target.value }))}
                    className="w-full px-3 py-2.5 pr-10 rounded-xl text-sm"
                    style={{
                      background: 'var(--bg-card)',
                      border: '1px solid var(--border)',
                      color: 'var(--text-primary)',
                    }}
                  />
                  <button type="button" onClick={() => setShowPass(s => !s)}
                    className="absolute right-3 top-1/2 -translate-y-1/2"
                    style={{ color: 'var(--text-muted)' }}>
                    {showPass ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
              </div>
              <Input label="Password Baru" type={showPass ? 'text' : 'password'}
                value={passForm.new1}
                onChange={e => setPassForm(p => ({ ...p, new1: e.target.value }))}
                placeholder="min 4 karakter" />
              <Input label="Konfirmasi Password Baru" type={showPass ? 'text' : 'password'}
                value={passForm.new2}
                onChange={e => setPassForm(p => ({ ...p, new2: e.target.value }))}
                placeholder="ulangi password baru" />
              <div className="pt-2">
                <Button variant="primary" className="w-full" onClick={handleChangePass} disabled={changingPass}>
                  {changingPass ? <Loader2 size={14} className="animate-spin" /> : <Lock size={14} />}
                  {changingPass ? 'Menyimpan...' : 'Ganti Password'}
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </Modal>

    {/* ── TAMBAH / EDIT KATEGORI PRODUK ── */}
    <Modal open={!!catModal} zIndex={1100} onClose={() => { setCatModal(null); setCatErr('') }} title={catModal?.id ? 'Edit Kategori' : 'Tambah Kategori'} subtitle="Kategori tersimpan permanen di database." size="sm">
      {catModal && (
        <div className="space-y-3">
          {catErr && <Banner kind="error">{catErr}</Banner>}
          <Input label="Nama Kategori" value={catModal.label} onChange={e => setCatModal(p => ({ ...p, label: e.target.value }))} placeholder="cth: Mug, Topi, Spanduk…" />

          <div>
            <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--text-secondary)', fontFamily: 'Syne' }}>Icon / Emoji</label>
            <div className="flex flex-wrap gap-1.5">
              {CAT_EMOJIS.map(ic => (
                <button key={ic} type="button" onClick={() => setCatModal(p => ({ ...p, icon: ic }))} className="w-8 h-8 rounded-lg flex items-center justify-center text-base btn-press"
                  style={{ background: catModal.icon === ic ? 'rgba(139,92,246,0.18)' : 'var(--bg-card)', border: `1px solid ${catModal.icon === ic ? 'var(--accent)' : 'var(--border)'}` }}>{ic}</button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--text-secondary)', fontFamily: 'Syne' }}>Warna Kategori</label>
            <div className="flex flex-wrap gap-2">
              {CAT_COLORS.map(col => (
                <button key={col} type="button" onClick={() => setCatModal(p => ({ ...p, color: col }))} className="w-8 h-8 rounded-lg btn-press flex items-center justify-center"
                  style={{ background: col, border: `2px solid ${catModal.color === col ? '#fff' : 'transparent'}`, boxShadow: catModal.color === col ? `0 0 0 2px ${col}` : 'none' }}>
                  {catModal.color === col && <Check size={14} style={{ color: '#fff' }} />}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--text-secondary)', fontFamily: 'Syne' }}>Thumbnail / Logo (opsional)</label>
            <div className="flex items-center gap-3">
              {catModal.thumbnail
                ? <img src={catModal.thumbnail} alt="" className="w-12 h-12 rounded-lg object-cover" style={{ border: '1px solid var(--border)' }} />
                : <div className="w-12 h-12 rounded-lg flex items-center justify-center" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}><ImagePlus size={18} style={{ color: 'var(--text-muted)' }} /></div>}
              <label className="px-3 py-2 rounded-xl text-xs font-semibold cursor-pointer" style={{ background: 'rgba(139,92,246,0.1)', color: 'var(--accent-light)', border: '1px solid rgba(139,92,246,0.2)' }}>
                Pilih Gambar
                <input type="file" accept="image/*" className="hidden" onChange={e => onCatThumb(e.target.files?.[0])} />
              </label>
              {catModal.thumbnail && <button type="button" onClick={() => setCatModal(p => ({ ...p, thumbnail: '' }))} className="text-xs" style={{ color: 'var(--red)' }}>Hapus</button>}
            </div>
          </div>

          <button type="button" onClick={() => setCatModal(p => ({ ...p, active: !p.active }))} className="flex items-center justify-between w-full px-3 py-2.5 rounded-xl" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
            <span className="text-xs font-semibold" style={{ color: 'var(--text-primary)', fontFamily: 'Syne' }}>Status: {catModal.active ? 'Aktif' : 'Nonaktif'}</span>
            <span className="w-10 h-6 rounded-full flex items-center px-0.5 transition-all" style={{ background: catModal.active ? '#10d98a' : 'var(--bg-elevated)', justifyContent: catModal.active ? 'flex-end' : 'flex-start' }}>
              <span className="w-5 h-5 rounded-full" style={{ background: '#fff' }} />
            </span>
          </button>

          <Button variant="primary" className="w-full" onClick={saveCat} disabled={catBusy}>{catBusy ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} {catModal.id ? 'Simpan' : 'Tambah Kategori'}</Button>
        </div>
      )}
    </Modal>

    {/* ── PINDAHKAN CUSTOMER SEBELUM HAPUS ADMIN ── */}
    <Modal open={!!reassignAdmin} zIndex={1100} onClose={() => setReassignAdmin(null)} title="Admin masih punya customer" subtitle="Tidak boleh ada customer tanpa PIC." size="sm">
      {reassignAdmin && (
        <div className="space-y-3">
          <Banner kind="error">Admin ini masih menjadi PIC {reassignAdmin.count} customer. Pindahkan ke admin lain dulu, atau batalkan.</Banner>
          <div>
            <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--text-secondary)', fontFamily: 'Syne' }}>Pindahkan customer ke</label>
            <select value={reassignAdmin.toId} onChange={e => setReassignAdmin(p => ({ ...p, toId: e.target.value }))}
              className="w-full px-3 py-2.5 rounded-xl text-sm" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}>
              {admins.filter(a => a.id !== reassignAdmin.id).map(a => <option key={a.id} value={a.id}>{a.name || a.username}</option>)}
            </select>
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" className="flex-1" onClick={() => setReassignAdmin(null)}>Batalkan Penghapusan</Button>
            <Button variant="primary" className="flex-1" onClick={confirmReassignAndDelete}><Check size={14} /> Pindahkan & Hapus</Button>
          </div>
        </div>
      )}
    </Modal>

    {/* ── EDIT ADMIN (Owner only) — di atas modal Settings ── */}
    <Modal open={!!editAdmin} zIndex={1100} onClose={() => { setEditAdmin(null); setEditShowPass(false) }} title="Edit Admin" subtitle="Ubah username, nama, role, atau password admin." size="sm">
      {editAdmin && (
        <div className="space-y-3">
          {editErr && <Banner kind="error">{editErr}</Banner>}
          <Input label="Username" value={editAdmin.username}
            onChange={e => setEditAdmin(p => ({ ...p, username: e.target.value.toLowerCase().replace(/\s+/g, '') }))}
            placeholder="username" />
          <Input label="Nama Lengkap" value={editAdmin.name}
            onChange={e => setEditAdmin(p => ({ ...p, name: e.target.value }))}
            placeholder="Nama tampilan" />
          <div>
            <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--text-secondary)', fontFamily: 'Syne' }}>Role</label>
            <select value={editAdmin.role} onChange={e => setEditAdmin(p => ({ ...p, role: e.target.value }))}
              className="w-full px-3 py-2.5 rounded-xl text-sm"
              style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}>
              {ROLE_OPTIONS.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}
            </select>
          </div>
          <div className="rounded-xl p-3" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
            <div className="text-[11px] mb-2" style={{ color: 'var(--text-muted)' }}>Kosongkan jika tidak ingin mengganti password.</div>
            <div className="relative mb-2">
              <Input label="Password Baru" type={editShowPass ? 'text' : 'password'} value={editAdmin.password}
                onChange={e => setEditAdmin(p => ({ ...p, password: e.target.value }))} placeholder="min 4 karakter" />
              <button type="button" onClick={() => setEditShowPass(s => !s)} className="absolute right-3" style={{ top: 32, color: 'var(--text-muted)' }}>
                {editShowPass ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
            <Input label="Konfirmasi Password Baru" type={editShowPass ? 'text' : 'password'} value={editAdmin.confirm}
              onChange={e => setEditAdmin(p => ({ ...p, confirm: e.target.value }))} placeholder="ulangi password baru" />
          </div>
          <Button variant="primary" className="w-full" onClick={saveEditAdmin} disabled={savingEdit}>
            {savingEdit ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} {savingEdit ? 'Menyimpan...' : 'Simpan Perubahan'}
          </Button>
        </div>
      )}
    </Modal>
    </>
  )
}
