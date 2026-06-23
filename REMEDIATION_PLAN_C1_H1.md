# RENCANA PERBAIKAN — C1 (Keamanan) & H1 (Multi-book Accounting)

Dokumen RENCANA. Belum dieksekusi. Butuh persetujuan karena keduanya
perubahan arsitektur yang bisa berdampak luas.

---

## C1 — Keamanan: dari "gating frontend" ke RLS berbasis peran

### Kondisi sekarang
- Satu **anon key** dipakai semua user. Policy tiap tabel `FOR ALL USING(true)`.
- Peran (owner/admin/kasir) hanya disimpan di tabel `admins` & dicek di React.
- Akibat: data apa pun bisa diakses/diubah lewat API langsung memakai anon key.

### Opsi remediasi (urut dari paling ringan → paling kuat)

**Tahap 1 — Pengerasan tanpa ubah login (cepat, mitigasi)**
1. Pindahkan operasi **DESTRUKTIF & sensitif** ke RPC `SECURITY DEFINER`
   yang menerima `actor_id` + cek peran di dalam fungsi:
   - `delete_transaction`, `delete_debt_payment`, `delete_expense`,
     `delete_bank_loan_payment`, dsb.
   - Revoke akses `DELETE`/`UPDATE` langsung dari anon pada tabel terkait,
     hanya izinkan lewat RPC.
2. Sembunyikan kolom sensitif (laba/owner) di belakang RPC, bukan SELECT bebas.
   Risiko: sedang (perlu mapping semua aksi delete/edit ke RPC). Tidak ubah UI.

**Tahap 2 — Auth nyata (paling benar)**
1. Migrasi login ke **Supabase Auth** (email/username+password → `auth.users`).
2. Simpan peran di `profiles(user_id, role)`.
3. Tulis RLS per tabel berbasis `auth.uid()` + peran:
   - owner: full. admin: sesuai book/aksi. kasir: hanya book yang ditugaskan,
     hanya INSERT transaksi/pembayaran miliknya, tidak boleh baca accounting.
4. Hapus policy `USING(true)`.
   Risiko: tinggi (menyentuh seluruh alur login & query). Perlu test menyeluruh.

### Rekomendasi
Mulai **Tahap 1** (mitigasi delete/edit lewat RPC) karena dampak besar dengan
risiko UI minimal; jadwalkan **Tahap 2** sebagai proyek terpisah dengan QA penuh.
Tidak menyentuh rumus akuntansi sama sekali.

### Yang saya butuhkan dari Anda
- Konfirmasi boleh memakai RPC `SECURITY DEFINER` + revoke delete anon (Tahap 1)?
- Atau langsung rencanakan Supabase Auth (Tahap 2)?

---

## H1 — Multi-book Accounting (pengeluaran/hutang/aset per book)

### Kondisi sekarang
- `book_id` hanya ada di `transactions, customers, debts, debt_payments`.
- `acc_dashboard(p_from, p_to)` **global** (tanpa book).
- Pengeluaran, Pembelian, Hutang Supplier/Bank, Kasbon, Sewa, Aset = gabungan.

### Rencana (non-destruktif, bertahap)

**Langkah 1 — Migrasi DB (additive)**
- `ALTER TABLE ... ADD COLUMN IF NOT EXISTS book_id uuid` pada:
  `expenses, purchases, supplier_debts, supplier_debt_payments,
   bank_loans, bank_loan_payments, employee_cash_advances,
   employee_cash_advance_payments, prepaid_rents, assets`.
- Backfill semua baris lama → book default (SKUPY) agar data lama tidak hilang.
- Index `book_id`.

**Langkah 2 — `acc_dashboard(p_from, p_to, p_book uuid DEFAULT NULL)`**
- Tambah parameter opsional `p_book`. Setiap CTE memfilter
  `(p_book IS NULL OR book_id = p_book)`. `p_book NULL` = perilaku lama (global)
  → **tidak memecah apa pun yang sekarang sudah benar**.
- Saldo/Arus Kas/Total Aset/Kekayaan/Pengeluaran/Hutang ikut `p_book`.

**Langkah 3 — Hook & UI**
- `getDashboard`, `getOutflowTransactions`, `getCardDetail`, `getCashflowDetail`,
  `auditAccounting` menerima `bookId` dan meneruskannya.
- Tulis `book_id = writeBookId` saat membuat expense/purchase/hutang/kasbon/aset
  (omit-fallback bila kolom belum ada).
- Accounting page kirim `activeBookId` ke semua fetch; tambah indikator
  "Accounting: Book Aktif" + opsi "Semua Book".

**Langkah 4 — Verifikasi ketat**
- Untuk `p_book = NULL`, semua angka HARUS sama persis dengan sekarang
  (regression test — Saldo rekonsiliasi pas ke rupiah).
- Untuk tiap book, jumlah per-book = total global.

### Risiko
- **Tinggi.** Menyentuh fungsi `acc_dashboard` yang sudah tervalidasi
  (Saldo rekonsiliasi pas). Salah filter → Saldo/Laba bergeser diam-diam.
- Mitigasi: parameter `p_book` default NULL (mode lama), uji A/B
  (global lama vs global baru) sebelum aktifkan filter per book.

### Keputusan yang diperlukan
1. Apakah benar **pengeluaran, hutang, kasbon, aset** harus per-book?
   (Banyak toko menaruh biaya operasional sebagai bersama/global.)
2. Bagaimana biaya yang memang dipakai bersama 2 brand (mis. sewa, gaji)?
   - Opsi: tetap global, atau dialokasikan, atau ditandai "Bersama".
3. Backfill data lama → SKUPY semua, atau Anda mau bagi manual sebagian?

> Setelah Anda jawab 1–3, saya kerjakan H1 bertahap dengan format
> FIXED / RETEST / RISK, dan **mode lama (global) tetap jadi fallback**
> sampai verifikasi lolos.
