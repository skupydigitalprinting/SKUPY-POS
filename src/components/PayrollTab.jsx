import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { Users as UsersIcon, Plus, Pencil, Trash2, Wallet, Search, ChevronLeft, Receipt, Building2, Check } from 'lucide-react'
import Modal from './Modal'
import { useToast } from './Toast'
import { useConfirm } from './Confirm'
import { formatRupiah, formatCurrency, parseCurrency, formatDateTimeWIB } from '../utils/helpers'

const FIELD = 'w-full px-3.5 py-3 rounded-xl text-sm'
const inp = { background: 'var(--bg-card)', border: '1px solid var(--border)', color: 'var(--text-primary)' }
const fmt = (n) => formatRupiah(Math.round(Number(n) || 0))
const todayISO = () => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` }
// Ambil nama karyawan dari note "Gaji - {nama}[ · catatan]".
const parseSalaryNote = (note) => {
  const m = String(note || '').match(/^Gaji\s*-\s*(.+?)(?:\s*·\s*(.*))?$/i)
  if (!m) return { name: '—', extra: note || '' }
  return { name: (m[1] || '').trim(), extra: (m[2] || '').trim() }
}

export default function PayrollTab({ acc, admins = [], currentUser, onChanged }) {
  const toast = useToast()
  const confirm = useConfirm()
  const adminName = (id) => admins.find(a => a.id === id)?.name || admins.find(a => a.id === id)?.username || '—'

  const [employees, setEmployees] = useState([])
  const [search, setSearch] = useState('')
  const [needMig, setNeedMig] = useState(false)
  const [empModal, setEmpModal] = useState(null)   // { id?, name, position, notes }
  const [saving, setSaving] = useState(false)
  const [detailEmp, setDetailEmp] = useState(null) // karyawan yang dibuka detailnya
  const [hist, setHist] = useState([])             // riwayat gaji karyawan terbuka
  const [payForm, setPayForm] = useState(null)     // form bayar gaji
  const [editPay, setEditPay] = useState(null)     // edit pembayaran gaji

  const load = useCallback(async () => {
    const r = await acc.listEmployees(search)
    if (r.ok) { setEmployees(r.data); setNeedMig(false) }
    else if (/relation|does not exist|schema cache/i.test(r.error || '')) setNeedMig(true)
  }, [acc, search])
  useEffect(() => { load() }, [load])

  const loadHist = useCallback(async (name) => {
    const r = await acc.listSalaryExpenses({ employeeName: name })
    setHist(r.ok ? r.data : [])
  }, [acc])
  useEffect(() => { if (detailEmp) loadHist(detailEmp.name) }, [detailEmp, loadHist])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return (employees || []).filter(e => !q || (e.name || '').toLowerCase().includes(q))
  }, [employees, search])

  const saveEmp = async () => {
    if (!empModal.name?.trim()) return toast.error('Nama wajib diisi')
    setSaving(true)
    const payload = { name: empModal.name, position: empModal.position || '', notes: empModal.notes || '', phone: empModal.phone || '' }
    const r = empModal.id ? await acc.updateEmployee(empModal.id, payload) : await acc.addEmployee(payload)
    setSaving(false)
    if (r.ok) { toast.success(empModal.id ? 'Karyawan diperbarui' : 'Karyawan ditambah'); setEmpModal(null); load(); onChanged && onChanged() }
    else if (/relation|does not exist|schema cache/i.test(r.error || '')) toast.error('Tabel karyawan belum dimigrasi. Jalankan 2026_06_employees_master.sql.')
    else toast.error(r.error)
  }

  const delEmp = async (e) => {
    if (!(await confirm({ title: 'Apakah Anda yakin ingin menghapus data karyawan ini?', message: 'Data tidak dihapus permanen (soft delete). Karyawan disembunyikan dari daftar aktif. Histori pembayaran gaji & pengeluaran tetap tersimpan.', confirmLabel: 'Ya, Hapus', cancelLabel: 'Batal' }))) return
    const r = await acc.deleteEmployee(e.id)
    if (r.ok) { toast.success('Karyawan dihapus (soft delete)'); if (detailEmp?.id === e.id) setDetailEmp(null); load(); onChanged && onChanged() } else toast.error(r.error)
  }

  const submitPay = async () => {
    const amt = parseCurrency(payForm.amount)
    if (!(amt > 0)) return toast.error('Nominal gaji harus > 0')
    setSaving(true)
    const r = await acc.payEmployeeSalary({ employeeName: detailEmp.name, amount: amt, date: payForm.date, method: payForm.method, note: payForm.note }, currentUser?.id)
    setSaving(false)
    if (r.ok) { toast.success('Gaji dibayar & dicatat di Pengeluaran'); setPayForm(null); loadHist(detailEmp.name); onChanged && onChanged() } else toast.error(r.error)
  }

  const submitEditPay = async () => {
    const amt = parseCurrency(editPay.amount)
    if (!(amt > 0)) return toast.error('Nominal harus > 0')
    setSaving(true)
    // Pertahankan format note "Gaji - {nama}[ · catatan]" agar tetap tertaut karyawan.
    const note = `Gaji - ${detailEmp.name}${editPay.note?.trim() ? ' · ' + editPay.note.trim() : ''}`
    const r = await acc.updateExpense(editPay.id, { date: editPay.date, amount: amt, method: editPay.method, note, category: 'Gaji Karyawan' })
    setSaving(false)
    if (r.ok) { toast.success('Pembayaran gaji diperbarui'); setEditPay(null); loadHist(detailEmp.name); onChanged && onChanged() } else toast.error(r.error)
  }

  const delPay = async (p) => {
    if (!(await confirm({ title: 'Hapus pembayaran gaji ini?', message: 'Soft delete — data tidak hilang permanen. Pengeluaran terkait ikut terhapus dari laporan; Uang Keluar, Total Gaji & dashboard menyesuaikan.', confirmLabel: 'Ya, Hapus', cancelLabel: 'Batal' }))) return
    const r = await acc.deleteExpense(p.id)
    if (r.ok) { toast.success('Pembayaran gaji dihapus'); loadHist(detailEmp.name); onChanged && onChanged() } else toast.error(r.error)
  }

  // ── DETAIL KARYAWAN ──
  if (detailEmp) {
    const total = hist.reduce((s, x) => s + Math.round(x.amount || 0), 0)
    return (
      <div className="space-y-4">
        <button onClick={() => setDetailEmp(null)} className="inline-flex items-center gap-1.5 text-xs font-semibold" style={{ color: 'var(--accent-light)', fontFamily: 'Syne' }}>
          <ChevronLeft size={14} /> Kembali ke daftar karyawan
        </button>
        <div className="rounded-2xl p-4 flex items-center justify-between gap-3" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: 'rgba(139,92,246,0.12)', color: 'var(--accent-light)' }}><UsersIcon size={18} /></div>
            <div className="min-w-0">
              <div className="font-bold text-sm truncate" style={{ color: 'var(--text-primary)', fontFamily: 'Syne' }}>{detailEmp.name}</div>
              <div className="text-[11px] truncate" style={{ color: 'var(--text-muted)' }}>{detailEmp.position || 'Tanpa divisi'}{detailEmp.notes ? ` · ${detailEmp.notes}` : ''}</div>
            </div>
          </div>
          <button onClick={() => setPayForm({ amount: '', date: todayISO(), method: 'transfer', note: '' })} className="inline-flex items-center gap-1.5 px-3.5 py-2.5 rounded-xl text-xs font-bold btn-press flex-shrink-0" style={{ background: 'linear-gradient(135deg, #d97706, #b45309)', color: '#fff', fontFamily: 'Syne' }}>
            <Wallet size={14} /> Bayar Gaji
          </button>
        </div>

        <div className="rounded-2xl p-4" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
          <div className="flex items-center justify-between mb-3">
            <div className="text-xs font-bold uppercase tracking-wider" style={{ color: 'var(--accent-light)', fontFamily: 'Syne' }}>Riwayat Pembayaran Gaji</div>
            <div className="text-sm font-bold" style={{ color: '#d97706', fontFamily: 'Syne', fontVariantNumeric: 'tabular-nums' }}>Total {fmt(total)}</div>
          </div>
          {hist.length === 0 ? (
            <p className="text-xs text-center py-6" style={{ color: 'var(--text-muted)' }}>Belum ada pembayaran gaji</p>
          ) : (
            <div className="space-y-1.5">
              {hist.map(p => {
                const { extra } = parseSalaryNote(p.note)
                return (
                  <div key={p.id} className="flex items-center gap-2 text-[11px] py-1" style={{ borderBottom: '1px solid var(--border)' }}>
                    <span style={{ color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>{formatDateTimeWIB(p.expense_date, p.created_at)}</span>
                    <span className="font-bold" style={{ color: '#d97706', fontVariantNumeric: 'tabular-nums' }}>{fmt(p.amount)}</span>
                    <span className="uppercase text-[9px]" style={{ color: 'var(--text-muted)' }}>{p.method}</span>
                    {extra && <span className="truncate" style={{ color: 'var(--text-muted)' }}>· {extra}</span>}
                    <span className="text-[10px] truncate" style={{ color: 'var(--text-muted)' }}>· {adminName(p.cashier_id)}</span>
                    <div className="ml-auto flex items-center gap-1 flex-shrink-0">
                      <button onClick={() => setEditPay({ id: p.id, amount: String(Math.round(p.amount || 0)), method: p.method === 'cash' ? 'cash' : 'transfer', date: String(p.expense_date).slice(0, 10), note: parseSalaryNote(p.note).extra })} className="w-6 h-6 rounded inline-flex items-center justify-center" style={{ background: 'rgba(139,92,246,0.12)', color: 'var(--accent-light)' }} title="Edit"><Pencil size={10} /></button>
                      <button onClick={() => delPay(p)} className="w-6 h-6 rounded inline-flex items-center justify-center" style={{ background: 'rgba(255,77,106,0.08)', color: 'var(--red)' }} title="Soft delete"><Trash2 size={10} /></button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Form Bayar Gaji */}
        <Modal open={!!payForm} onClose={() => setPayForm(null)} title="Bayar Gaji" subtitle={detailEmp.name} size="sm">
          {payForm && (
            <div className="space-y-3">
              <div><label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--text-secondary)', fontFamily: 'Syne' }}>Nominal Gaji</label>
                <input inputMode="numeric" value={payForm.amount ? formatCurrency(parseCurrency(payForm.amount)) : ''} onChange={e => setPayForm(p => ({ ...p, amount: e.target.value.replace(/[^\d]/g, '') }))} placeholder="0" className={FIELD} style={inp} /></div>
              <div><label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--text-secondary)', fontFamily: 'Syne' }}>Tanggal Pembayaran</label>
                <input type="date" value={payForm.date} onChange={e => setPayForm(p => ({ ...p, date: e.target.value }))} className={FIELD} style={{ ...inp, colorScheme: 'dark' }} /></div>
              <div><label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--text-secondary)', fontFamily: 'Syne' }}>Metode Pembayaran</label>
                <select value={payForm.method} onChange={e => setPayForm(p => ({ ...p, method: e.target.value }))} className={FIELD} style={inp}><option value="transfer">Transfer</option><option value="cash">Cash</option></select></div>
              <div><label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--text-secondary)', fontFamily: 'Syne' }}>Keterangan</label>
                <input value={payForm.note} onChange={e => setPayForm(p => ({ ...p, note: e.target.value }))} placeholder="Opsional (mis. periode gaji)" className={FIELD} style={inp} /></div>
              <button disabled={saving} onClick={submitPay} className="w-full py-3 rounded-xl text-sm font-bold btn-press" style={{ background: 'linear-gradient(135deg, #d97706, #b45309)', color: '#fff', fontFamily: 'Syne' }}><Check size={14} className="inline mr-1" /> Bayar & Catat Pengeluaran</button>
            </div>
          )}
        </Modal>

        {/* Edit Pembayaran Gaji */}
        <Modal open={!!editPay} onClose={() => setEditPay(null)} title="Edit Pembayaran Gaji" subtitle={detailEmp.name} size="sm">
          {editPay && (
            <div className="space-y-3">
              <div><label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--text-secondary)', fontFamily: 'Syne' }}>Nominal Gaji</label>
                <input inputMode="numeric" value={editPay.amount ? formatCurrency(parseCurrency(editPay.amount)) : ''} onChange={e => setEditPay(p => ({ ...p, amount: e.target.value.replace(/[^\d]/g, '') }))} className={FIELD} style={inp} /></div>
              <div><label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--text-secondary)', fontFamily: 'Syne' }}>Tanggal Pembayaran</label>
                <input type="date" value={editPay.date} onChange={e => setEditPay(p => ({ ...p, date: e.target.value }))} className={FIELD} style={{ ...inp, colorScheme: 'dark' }} /></div>
              <div><label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--text-secondary)', fontFamily: 'Syne' }}>Metode Pembayaran</label>
                <select value={editPay.method} onChange={e => setEditPay(p => ({ ...p, method: e.target.value }))} className={FIELD} style={inp}><option value="transfer">Transfer</option><option value="cash">Cash</option></select></div>
              <div><label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--text-secondary)', fontFamily: 'Syne' }}>Keterangan</label>
                <input value={editPay.note} onChange={e => setEditPay(p => ({ ...p, note: e.target.value }))} className={FIELD} style={inp} /></div>
              <button disabled={saving} onClick={submitEditPay} className="w-full py-3 rounded-xl text-sm font-bold btn-press" style={{ background: 'linear-gradient(135deg, var(--accent), #6366f1)', color: '#fff', fontFamily: 'Syne' }}><Check size={14} className="inline mr-1" /> Simpan Perubahan</button>
            </div>
          )}
        </Modal>
      </div>
    )
  }

  // ── DAFTAR KARYAWAN ──
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="relative flex-1 min-w-44">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Cari karyawan..." className="w-full pl-9 pr-3 py-2.5 rounded-xl text-sm" style={inp} />
        </div>
        <button onClick={() => setEmpModal({ name: '', position: '', notes: '', phone: '' })} className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl text-sm font-bold btn-press flex-shrink-0" style={{ background: 'linear-gradient(135deg, var(--accent), #6366f1)', color: '#fff', fontFamily: 'Syne' }}>
          <Plus size={15} /> Tambah Karyawan
        </button>
      </div>

      {needMig ? (
        <div className="rounded-2xl p-6 text-center" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
          <p className="text-sm font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>Tabel karyawan belum dimigrasi</p>
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Jalankan <code>supabase/migrations/2026_06_employees_master.sql</code> lalu muat ulang.</p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-2xl p-10 text-center" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
          <div className="w-16 h-16 rounded-2xl mx-auto mb-3 flex items-center justify-center" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border)' }}><UsersIcon size={26} style={{ color: 'var(--text-muted)', opacity: 0.6 }} /></div>
          <p className="text-sm font-semibold mb-3" style={{ color: 'var(--text-secondary)', fontFamily: 'Syne' }}>Belum ada karyawan</p>
          <button onClick={() => setEmpModal({ name: '', position: '', notes: '', phone: '' })} className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl text-sm font-bold btn-press" style={{ background: 'linear-gradient(135deg, var(--accent), #6366f1)', color: '#fff', fontFamily: 'Syne' }}><Plus size={15} /> Input Karyawan</button>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {filtered.map(e => (
            <div key={e.id} className="rounded-2xl p-4" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
              <div className="flex items-start justify-between gap-2 mb-3">
                <button onClick={() => setDetailEmp(e)} className="flex items-center gap-2.5 min-w-0 text-left">
                  <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: 'rgba(139,92,246,0.12)', color: 'var(--accent-light)' }}><UsersIcon size={16} /></div>
                  <div className="min-w-0">
                    <div className="font-bold text-sm truncate underline decoration-dotted" style={{ color: 'var(--text-primary)', fontFamily: 'Syne' }}>{e.name}</div>
                    <div className="text-[11px] truncate" style={{ color: 'var(--text-muted)' }}>{e.position || 'Tanpa divisi'}</div>
                  </div>
                </button>
                <div className="flex items-center gap-1 flex-shrink-0">
                  <button onClick={() => setEmpModal({ id: e.id, name: e.name || '', position: e.position || '', notes: e.notes || '', phone: e.phone || '' })} className="w-7 h-7 rounded-lg inline-flex items-center justify-center" style={{ background: 'rgba(139,92,246,0.1)', color: 'var(--accent-light)' }} title="Edit"><Pencil size={12} /></button>
                  <button onClick={() => delEmp(e)} className="w-7 h-7 rounded-lg inline-flex items-center justify-center" style={{ background: 'rgba(255,77,106,0.08)', color: 'var(--red)' }} title="Soft delete"><Trash2 size={12} /></button>
                </div>
              </div>
              {e.notes && <p className="text-[11px] mb-3 truncate" style={{ color: 'var(--text-muted)' }}>{e.notes}</p>}
              <button onClick={() => setDetailEmp(e)} className="w-full py-2 rounded-lg text-[11px] font-bold btn-press" style={{ background: 'rgba(217,119,6,0.12)', color: '#d97706', fontFamily: 'Syne' }}><Wallet size={12} className="inline mr-1" /> Bayar / Riwayat Gaji</button>
            </div>
          ))}
        </div>
      )}

      {/* Tambah / Edit Karyawan */}
      <Modal open={!!empModal} onClose={() => setEmpModal(null)} title={empModal?.id ? 'Edit Karyawan' : 'Tambah Karyawan'} size="sm">
        {empModal && (
          <div className="space-y-3">
            <div><label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--text-secondary)', fontFamily: 'Syne' }}>Nama</label>
              <input value={empModal.name} onChange={e => setEmpModal(p => ({ ...p, name: e.target.value }))} placeholder="Nama lengkap" className={FIELD} style={inp} /></div>
            <div><label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--text-secondary)', fontFamily: 'Syne' }}>Divisi</label>
              <input value={empModal.position} onChange={e => setEmpModal(p => ({ ...p, position: e.target.value }))} placeholder="Contoh: Produksi / Admin / Desain" className={FIELD} style={inp} /></div>
            <div><label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--text-secondary)', fontFamily: 'Syne' }}>Keterangan</label>
              <input value={empModal.notes} onChange={e => setEmpModal(p => ({ ...p, notes: e.target.value }))} placeholder="Opsional" className={FIELD} style={inp} /></div>
            <button disabled={saving} onClick={saveEmp} className="w-full py-3 rounded-xl text-sm font-bold btn-press" style={{ background: 'linear-gradient(135deg, var(--accent), #6366f1)', color: '#fff', fontFamily: 'Syne' }}><Check size={14} className="inline mr-1" /> {empModal.id ? 'Simpan' : 'Tambah Karyawan'}</button>
          </div>
        )}
      </Modal>
    </div>
  )
}
