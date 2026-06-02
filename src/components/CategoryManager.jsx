import React, { useState } from 'react'
import { Plus, Check, X, Pencil, Trash2, Tag } from 'lucide-react'
import Modal from './Modal'
import { Button } from './ui'

// Pilihan emoji cepat untuk ikon kategori.
const ICON_CHOICES = ['👕', '👚', '🧥', '🩳', '🧢', '🚩', '✨', '🖨️', '🎒', '📦', '🎨', '🧵', '📏', '🏷️', '🔖', '⭐']

function IconPicker({ value, onChange }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {ICON_CHOICES.map((ic) => (
        <button
          key={ic}
          type="button"
          onClick={() => onChange(ic)}
          className="w-8 h-8 rounded-lg flex items-center justify-center text-base btn-press"
          style={{
            background: value === ic ? 'rgba(139,92,246,0.18)' : 'var(--bg-card)',
            border: `1px solid ${value === ic ? 'var(--accent)' : 'var(--border)'}`,
          }}
        >
          {ic}
        </button>
      ))}
    </div>
  )
}

export default function CategoryManager({ open, onClose, categories, addCategory, updateCategory, deleteCategory }) {
  const [newLabel, setNewLabel] = useState('')
  const [newIcon, setNewIcon] = useState('📦')
  const [error, setError] = useState('')

  const [editId, setEditId] = useState(null)
  const [editLabel, setEditLabel] = useState('')
  const [editIcon, setEditIcon] = useState('📦')

  const [confirmId, setConfirmId] = useState(null)

  const resetAdd = () => { setNewLabel(''); setNewIcon('📦'); setError('') }

  const handleAdd = () => {
    const res = addCategory({ label: newLabel, icon: newIcon })
    if (!res.ok) { setError(res.error || 'Gagal menambah kategori'); return }
    resetAdd()
  }

  const startEdit = (c) => {
    setEditId(c.id); setEditLabel(c.label); setEditIcon(c.icon || '📦'); setError('')
  }
  const cancelEdit = () => { setEditId(null); setEditLabel(''); setError('') }
  const saveEdit = () => {
    const res = updateCategory(editId, { label: editLabel, icon: editIcon })
    if (!res.ok) { setError(res.error || 'Gagal menyimpan'); return }
    cancelEdit()
  }

  const handleDelete = (id) => {
    const res = deleteCategory(id)
    if (!res.ok) { setError(res.error || 'Gagal menghapus'); return }
    setConfirmId(null)
  }

  return (
    <Modal open={open} onClose={onClose} title="Kelola Kategori" subtitle="Tambah, edit, atau hapus kategori produk" size="md">
      {error && (
        <div className="flex items-center gap-2 px-3 py-2.5 rounded-xl text-xs font-semibold mb-3"
          style={{ background: 'rgba(255,77,106,0.08)', color: 'var(--red)', border: '1px solid rgba(255,77,106,0.25)' }}>
          <X size={13} /> {error}
        </div>
      )}

      {/* Daftar kategori */}
      <div className="space-y-2 mb-5">
        {categories.map((c) => {
          const isEditing = editId === c.id
          const isConfirming = confirmId === c.id
          return (
            <div key={c.id} className="rounded-xl p-3"
              style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
              {isEditing ? (
                <div className="space-y-2.5">
                  <input
                    value={editLabel}
                    onChange={(e) => setEditLabel(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg text-sm"
                    style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
                    placeholder="Nama kategori"
                    autoFocus
                  />
                  <IconPicker value={editIcon} onChange={setEditIcon} />
                  <div className="flex gap-2">
                    <Button variant="primary" size="sm" onClick={saveEdit}>
                      <Check size={13} /> Simpan
                    </Button>
                    <Button variant="ghost" size="sm" onClick={cancelEdit}>
                      Batal
                    </Button>
                  </div>
                </div>
              ) : isConfirming ? (
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                    Hapus kategori <strong>{c.label}</strong>?
                  </span>
                  <div className="flex gap-2 flex-shrink-0">
                    <Button variant="danger" size="sm" onClick={() => handleDelete(c.id)}>Hapus</Button>
                    <Button variant="ghost" size="sm" onClick={() => setConfirmId(null)}>Batal</Button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-lg flex items-center justify-center text-lg flex-shrink-0"
                    style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}>
                    {c.icon || '📦'}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)', fontFamily: 'Syne' }}>
                      {c.label}
                    </div>
                    <div className="text-[11px] truncate" style={{ color: 'var(--text-muted)' }}>{c.id}</div>
                  </div>
                  <button onClick={() => startEdit(c)}
                    className="w-8 h-8 rounded-lg flex items-center justify-center btn-press flex-shrink-0"
                    style={{ background: 'rgba(139,92,246,0.1)', color: 'var(--accent-light)', border: '1px solid rgba(139,92,246,0.2)' }}>
                    <Pencil size={13} />
                  </button>
                  <button onClick={() => { setConfirmId(c.id); setError('') }}
                    className="w-8 h-8 rounded-lg flex items-center justify-center btn-press flex-shrink-0"
                    style={{ background: 'rgba(255,77,106,0.08)', color: 'var(--red)', border: '1px solid rgba(255,77,106,0.15)' }}>
                    <Trash2 size={13} />
                  </button>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Tambah kategori baru */}
      <div className="rounded-xl p-4" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
        <div className="flex items-center gap-1.5 text-xs font-semibold mb-3"
          style={{ color: 'var(--accent-light)', fontFamily: 'Syne', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          <Tag size={12} /> Tambah Kategori Baru
        </div>
        <input
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleAdd() }}
          className="w-full px-3 py-2.5 rounded-lg text-sm mb-2.5"
          style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
          placeholder="cth: Mug, Topi, Spanduk..."
        />
        <div className="mb-3">
          <div className="text-[11px] mb-1.5" style={{ color: 'var(--text-muted)' }}>Pilih ikon</div>
          <IconPicker value={newIcon} onChange={setNewIcon} />
        </div>
        <Button variant="primary" className="w-full" onClick={handleAdd} disabled={!newLabel.trim()}>
          <Plus size={14} /> Tambah Kategori
        </Button>
      </div>
    </Modal>
  )
}
