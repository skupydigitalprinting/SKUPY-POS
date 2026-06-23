# AUDIT REPORT — SKUPY POS (Full System Audit)

Tanggal: 2026-06 · Auditor: QA / Fullstack / Accounting / UI-UX
Catatan: laporan saja, belum ada perbaikan. Tidak ada rumus bisnis yang diubah.

---

## RINGKASAN

| Tingkat | Jumlah |
|---|---|
| Critical | 1 |
| High | 3 |
| Medium | 6 |
| Low | 6 |

Temuan paling penting: **keamanan (gating hanya di frontend, RLS `anon all`)** dan **akuntansi multi-book yang masih tercampur secara desain** (pengeluaran/hutang tidak punya `book_id`). Sebagian besar rumus kas/saldo SUDAH benar (Saldo rekonsiliasi pas ke rupiah — sudah diverifikasi). Kasbon edit/hapus pembayaran SUDAH benar (trigger DB recompute saat soft-delete).

---

## CRITICAL

### C1 — Permission hanya di frontend; RLS Supabase `anon all`
- **Lokasi:** semua migrasi (`CREATE POLICY ... FOR ALL USING (true) WITH CHECK (true)`); gating UI di `src/App.jsx` (`GATED`, `setActivePage`) & `src/components/Sidebar.jsx`.
- **Penyebab:** aplikasi memakai satu **anon key** dengan policy `USING(true)` di SEMUA tabel. Pembatasan Owner/Admin/Kasir hanya menyembunyikan menu/halaman di React.
- **Dampak:** siapa pun yang punya anon key (mis. Kasir lewat DevTools / API langsung) bisa **membaca & menulis SELURUH data**: laba owner, accounting, data book lain, bahkan menghapus transaksi. Gating frontend bersifat kosmetik.
- **Risiko:** Tinggi (kebocoran & manipulasi data).
- **Reproduksi:** login sebagai Kasir → buka DevTools → `supabase.from('transactions').select('*')` / `.delete()` berhasil walau menu Accounting tersembunyi.
- **Solusi (tanpa ubah rumus):** idealnya pindah ke Supabase Auth + RLS per-role (butuh perubahan arsitektur — di luar "no refactor besar"). Mitigasi minimal: (a) batasi anon key di Supabase (RLS per peran berbasis JWT), (b) pindahkan operasi sensitif ke RPC `SECURITY DEFINER` dengan cek peran, (c) minimal: jangan expose service key. **Perlu keputusan owner dulu** karena ini perubahan arsitektur.

---

## HIGH

### H1 — Multi-book: Accounting & Hutang/Pengeluaran TIDAK terpisah per book
- **Lokasi:** migrasi `2026_06_books_multibrand.sql` hanya menambah `book_id` ke `transactions, customers, debts, debt_payments`. Tabel `expenses, purchases, supplier_debts, bank_loans, employee_cash_advances, prepaid_rents, assets` **tidak** punya `book_id`. `acc_dashboard` global.
- **Penyebab:** desain awal — Accounting sengaja gabungan; hanya PENJUALAN yang per-book.
- **Dampak:** Saldo Kas&Bank, Arus Kas, Total Aset, Kekayaan, **Total Pengeluaran**, **Hutang Supplier/Bank**, **Kasbon** semuanya **gabungan semua book**. Spec audit minta "pengeluaran/hutang tidak tercampur" → saat ini **tercampur**.
- **Risiko:** Sedang–Tinggi (laporan per-brand tidak akurat untuk biaya/hutang).
- **Reproduksi:** pilih Book THEWA → Accounting tetap menampilkan pengeluaran & hutang SKUPY+THEWA.
- **Solusi:** tambah `book_id` ke tabel biaya/hutang + filter di `acc_dashboard` per book (perubahan DB + RPC besar). **Perlu keputusan**: apakah benar mau Accounting per-book, atau cukup pisah Omset/Piutang (yang sudah jalan).

### H2 — Data migrasi gelondongan menggelembungkan Omset & Laba; loan_cash tanpa liabilitas
- **Lokasi:** baris `migration_details` type `old_income` (~Rp4,14 M) & `old_expense` (~Rp4,13 M); `loan_cash` (~Rp640,96 M) di `bd.saldo_awal`. `acc_dashboard` `penjualan`/`pengeluaran_total`.
- **Penyebab:** import pembukuan lama sebagai lump-sum. `loan_cash` menambah kas tetapi tidak ada baris `bank_loans` sebagai kewajiban penyeimbang.
- **Dampak:** (1) Total Omset & Total Pengeluaran masing-masing naik ~Rp4 M (Profit Bruto/Laba ikut terdistorsi) walau Saldo tetap benar. (2) Neraca "seimbang by construction" (Kekayaan = Aset − Hutang) menyembunyikan bahwa Rp640 M pinjaman tercatat sebagai ekuitas, bukan hutang.
- **Risiko:** Sedang–Tinggi (laporan laba/omset & neraca menyesatkan).
- **Reproduksi:** Dashboard → Total Omset/Pengeluaran All Time terlihat ~4 M; klik rincian → 1 baris "Pengeluaran Lainnya" Rp4,13 M.
- **Solusi (data, bukan rumus):** edit/replace baris migrasi gelondongan; pindahkan saldo awal ke "Modal Disetor" (`modal`) dan/atau catat `loan_cash` sebagai `bank_loans` agar masuk Hutang Bank. **Koreksi DATA, bukan formula.**

### H3 — Realtime parsial (banyak tabel tidak sinkron antar perangkat)
- **Lokasi:** `src/hooks/useStore.js` channel realtime hanya: `transactions, debts, debt_payments, credibook_income`.
- **Penyebab:** optimasi egress (komentar di kode).
- **Dampak:** perubahan `customers, products, expenses, purchases, supplier_debts, bank_loans, employee_cash_advances, master data, books, admin_bank_accounts` oleh perangkat/akun LAIN **tidak muncul** sampai refresh manual / reload. Aman untuk 1 perangkat; berisiko stale untuk owner+kasir paralel.
- **Risiko:** Sedang.
- **Reproduksi:** 2 device. Device A tambah produk/pengeluaran → Device B tidak update tanpa reload.
- **Solusi:** tambah subscription untuk tabel yang sering berubah, atau tombol "Sinkronkan" yang jelas (sudah ada di Accounting). Pertimbangkan egress.

---

## MEDIUM

### M1 — Credibook "Total Pengeluaran" & "Saldo Book" mencampur scope
- **Lokasi:** `src/pages/Credibook.jsx` (`sumExpensesRange` global) vs `sumOmsetByBook`/income per-book.
- **Dampak:** "Total Pengeluaran" di Credibook = pengeluaran SEMUA book; "Saldo Book" = pemasukan per-book − pengeluaran global → angka per-book tidak murni. (Sudah pernah dicatat sebagai keterbatasan.)
- **Risiko:** Sedang (salah interpretasi saldo per-brand).
- **Solusi:** beri label tegas "Pengeluaran (semua book)" (sudah ada subteks), atau tunggu H1 (book_id pada expenses).

### M2 — Dashboard Owner "Laba Bersih" memakai Omset GLOBAL, bukan book aktif
- **Lokasi:** `src/pages/Dashboard.jsx` `labaRugi.revenue = omsetAcc` (dari `acc_dashboard`, global) sedangkan kartu omzet store di-scope book.
- **Dampak:** saat book aktif = THEWA, kartu Total Omzet (store) per-book, tapi panel Laba/Rugi owner pakai omset gabungan → bisa beda.
- **Risiko:** Sedang.
- **Solusi:** konsistenkan sumber (keduanya book-scoped atau keduanya global) — tergantung keputusan H1.

### M3 — Saldo: DP invoice HUTANG & QRIS-kasbon masuk bucket Kas
- **Lokasi:** `acc_dashboard` `masuk_cash` = `txall ... IN ('cash','hutang')`; kasbon `payment_method` collapse `qris→cash`.
- **Dampak:** DP hutang yang dibayar via transfer, dan pengembalian kasbon via QRIS, dibukukan ke **Kas** bukan Bank. **Total Saldo benar**, hanya pembagian Kas vs Bank yang bergeser.
- **Risiko:** Rendah–Sedang (hanya komposisi Kas/Bank).
- **Solusi:** simpan metode asli DP; tambah opsi QRIS pada kasbon. (Hati-hati: menyentuh breakdown saldo — uji ketat.)

### M4 — Accounting dashboard tidak realtime (poll 45s)
- **Lokasi:** `src/pages/Accounting.jsx` `setInterval(loadDashboard, 45000)` (cleanup OK, **tidak ada memory leak**).
- **Dampak:** transaksi/pengeluaran dari halaman lain baru tampak setelah ≤45s atau Sinkronkan.
- **Risiko:** Rendah.
- **Solusi:** sudah ada tombol Sinkronkan; opsional percepat saat tab aktif.

### M5 — Snapshot identitas invoice hanya saat transaksi dibuat
- **Lokasi:** `useStore.addTransaction` (snapshot bank/alamat/telepon) + `Invoice.jsx`.
- **Dampak:** invoice yang dibuat SEBELUM owner mengisi Profil Invoice/rekening admin akan pakai default toko (tidak retroaktif). Ini memang desain "histori aman", tapi bisa membingungkan saat awal setup.
- **Risiko:** Rendah.
- **Solusi:** dokumentasi/onboarding; opsional tombol "perbarui identitas invoice" (hati-hati: mengubah histori).

### M6 — "Semua Book" menulis ke book default (SKUPY)
- **Lokasi:** `useStore.writeBookId = activeBookId || defaultBookId`.
- **Dampak:** saat memilih "Semua Book", transaksi/customer baru otomatis ditandai SKUPY. Bisa salah-tag jika user mengira "Semua Book" = netral.
- **Risiko:** Rendah–Sedang.
- **Solusi:** saat "Semua Book", paksa pilih book sebelum checkout, atau beri peringatan.

---

## LOW

- **L1 — Unused code di Settings.jsx:** state/fungsi/imports rekening per-admin (`bankForm`, `submitBank`, `Landmark`, `Star`, dll) jadi tak terpakai setelah tab Rekening dilepas. Hanya warning lint, build tetap sukses. *Solusi: hapus yang benar-benar mati bila mau bersih.*
- **L2 — Dead branch `tab==='pembelian'`** di Accounting (menu dihapus sebelumnya) — unreachable, harmless.
- **L3 — Invoice bottom strip** "✦ Powered by {STORE_INFO.name} ✦" masih pakai nama toko global, bukan `issuerName` snapshot. Minor inkonsistensi brand pada multi-lokasi.
- **L4 — Badge PNG** bergantung versi html2canvas; sudah dipakai centering padding+line-height:1 (v189) yang stabil, tapi selisih ±1px antar versi mungkin terjadi. Opsi anti-gagal: render badge sebagai teks SVG.
- **L5 — Kasbon metode** UI hanya Cash/Transfer (tidak ada QRIS) — konsisten dengan M3.
- **L6 — `payEmployeeFIFO`/pay flows** meng-collapse metode non-transfer ke 'cash' (lihat M3).

---

## MATRIKS SINKRONISASI REALTIME

| Modul | Realtime antar device? | Update setelah aksi lokal? |
|---|---|---|
| Kasir / Transaksi | ✅ (transactions) | ✅ |
| Piutang / debt_payments | ✅ | ✅ |
| Credibook income | ✅ | ✅ |
| Customers | ❌ (lokal saja) | ✅ lokal |
| Produk | ❌ | ✅ lokal |
| Pengeluaran/Pembelian | ❌ | ✅ saat reload tab |
| Hutang Supplier/Bank | ❌ | ✅ lokal |
| Kasbon | ❌ | ✅ lokal |
| Master Data / Rekening / Books | ❌ | ✅ lokal (refetch fungsi) |
| Accounting Dashboard | poll 45s | ✅ saat Sinkronkan/poll |

## MATRIKS PERMISSION (frontend)

| Area | Owner | Admin | Kasir | Catatan |
|---|---|---|---|---|
| Dashboard/Accounting/Credibook | ✅ | ✅ | ❌ (UI) | Data tetap reachable via API (C1) |
| Kasir/Order/Produk/Customers/Piutang | ✅ | ✅ | ✅ | |
| Pengaturan | ✅ | ❌ | ❌ | Owner-only (UI) |
| Hapus transaksi/pembayaran | ✅ | sebagian | ❌ (UI) | Cek `isOwner` di UI saja |

## MATRIKS MULTI-BOOK

| Data | Terpisah per book? |
|---|---|
| Omset / Invoice / Order | ✅ |
| Customer | ✅ |
| Piutang (debts/payments) | ✅ |
| Credibook income | ✅ |
| Pengeluaran | ❌ (global) |
| Hutang Supplier/Bank | ❌ (global) |
| Kasbon | ❌ (global) |
| Aset / Sewa | ❌ (global) |
| Saldo/Arus Kas/Total Aset/Kekayaan | ❌ (global) |

---

## RECOMMENDED FIX ORDER

1. **C1 — Keamanan RLS/permission** (perlu keputusan owner; paling berbahaya). 
2. **H2 — Koreksi DATA migrasi & loan_cash** (perbaiki angka Omset/Laba/Neraca tanpa ubah rumus; cepat & berdampak besar).
3. **H1 — Keputusan multi-book accounting** (apakah pengeluaran/hutang harus per-book). 
4. **M2 — Konsistenkan sumber omset Dashboard Owner vs book aktif.**
5. **M6 — Guard "Semua Book" saat menulis transaksi.**
6. **H3 / M4 — Tambah realtime/refresh untuk tabel yang kurang sinkron.**
7. **M3 — Metode asli DP & QRIS kasbon (komposisi Kas/Bank).**
8. **M1 / M5 — Pelabelan Credibook & onboarding snapshot invoice.**
9. **L1–L6 — Bersih-bersih kode mati, polish PNG/SVG, konsistensi brand.**

> Banyak item Critical/High butuh KEPUTUSAN bisnis (arsitektur keamanan, apakah accounting per-book, koreksi data migrasi). Mohon konfirmasi item mana yang boleh saya kerjakan lebih dulu — saya akan perbaiki satu per satu, tanpa mengubah rumus, dengan format FIXED / RETEST / RISK di tiap langkah.
