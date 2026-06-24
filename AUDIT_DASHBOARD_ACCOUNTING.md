# AUDIT MENYELURUH — DASHBOARD ACCOUNTING (Credibook)

> Status: **LAPORAN AUDIT (belum ada perbaikan).** Tidak ada rumus bisnis yang diubah.
> Tanggal: 25 Juni 2026 · Versi kode: v204.

## Peta Sumber Data (umum untuk semua card)

| Lapisan | Lokasi |
|---|---|
| Render dashboard | `src/pages/Accounting.jsx` → blok `tab === 'ringkasan'` (≈ baris 1440–1496) |
| Hook pengambil data | `src/hooks/useAccounting.js` → `getDashboard(from,to)` (baris 37) memanggil RPC `acc_dashboard` |
| Detail rincian uang keluar | `useAccounting.getOutflowTransactions(from,to)` → dipakai untuk `ukBasis`/`pengOut` |
| Detail arus kas masuk/keluar | `useAccounting.getCashflowDetail(from,to)` (baris 567) |
| Query inti | RPC `public.acc_dashboard(p_from, p_to)` — `supabase/migrations/2026_06_asset_sales.sql` (definisi terakhir) |
| Refresh | Polling 45 detik saat tab Ringkasan aktif (`Accounting.jsx` baris 510–523). **Bukan realtime subscription.** |

**Tabel/CTE yang dipakai `acc_dashboard`:** `transactions` (txp/txall), `debt_payments` (dpp/dpall, cic_all), `supplier_debt_payments` (sdp/sdpall), `bank_loan_payments` (blp/blpall), `expenses` (exp), `purchases` (pur), `employee_cash_advances` (eca/ecaall), `employee_cash_advance_payments` (ecp/ecpall), `migration_details` (old_income oi, old_expense oe, modal modall, loan_cash lcall), `prepaid_rents` (prall), `credibook_income` (cbi/cbiall), `asset_sales` (asl/aslall), `debts`, `supplier_debts`, `bank_loans`. Aset tetap & sewa dihitung di sisi JS dari `assets` & `prepaid_rents`.

**Filter dasar transaksi:** `order_status <> 'dibatalkan'` **DAN** `deleted_at IS NULL`. Tanggal transaksi pakai `created_at::date`. `init_paid = GREATEST(0, round(paid) − Σ cicilan)` (anti dobel-hitung DP vs cicilan).

---

## AUDIT PER-CARD

### CARD: Laba Bersih Periode *(owner only)*
- **Render:** `Accounting.jsx` ≈ baris 1457 (`fmt(laba)`).
- **Hook/Service:** `getDashboard` (RPC `acc_dashboard`) + `getOutflowTransactions`.
- **View/Function/Table:** `acc_dashboard` (`penjualan`, `pengeluaran_total`) + `prepaid_rents` (beban sewa, JS).
- **Rumus:** `laba = netProfit(d.penjualan, ukBasis, rentAgg.bebanPeriod)` = `penjualan − (ukBasis + beban sewa amortisasi periode)`. `ukBasis = pengOut (Σ baris getOutflowTransactions) ?? d.pengeluaran_total`.
- **Dijumlah (+):** Penjualan/Omzet periode. **Dikurangi (−):** seluruh pengeluaran periode (operasional, gaji, pembelian bahan, purchases non-credit, bayar hutang supplier/bank **pokok**, kasbon keluar, pengeluaran migrasi) + **beban sewa amortisasi**.
- **Filter:** periode `from..to`. **Status:** `<> dibatalkan`, non-deleted. **Metode:** semua (cash/transfer/qris/hutang).
- **Pending?** Omzet pakai total invoice valid (termasuk yang belum lunas). **Hutang?** Ya (omzet termasuk invoice hutang). **Pemasukan manual?** Ya (omzet termasuk `cbi income_type='omzet'` + `old_income`). **Penjualan aset?** ❌ tidak masuk laba. **Penyusutan?** ❌. **Beban sewa?** ✅ amortisasi. **Jurnal accounting?** ❌ (basis kas/agregat, bukan jurnal).

### CARD: Penjualan / Omzet
- **Render:** baris 1464 (`fmt(d.penjualan)`).
- **Query:** `acc_dashboard.penjualan` = `Σ txp.total` + `Σ old_income.amount` + `Σ cbi.amount WHERE income_type='omzet'`.
- **Tabel:** `transactions`, `migration_details(old_income)`, `credibook_income`.
- **Dijumlah:** total invoice valid periode + pemasukan lama (migrasi) + pemasukan manual bertipe omzet. **Dikurangi:** —.
- **Filter:** `created_at` periode, `<> dibatalkan`, non-deleted. **Pending?** ✅ termasuk (pakai `total`, bukan paid). **Hutang?** ✅. **Manual?** ✅ (omzet). **Aset?** ❌. **Sewa/penyusutan/jurnal?** ❌.

### CARD: Total Omset All Time
- **Render:** baris 1465 (`allTime.omset`).
- **Sumber:** `getDashboard(ALL_TIME_FROM, today).penjualan` (rumus sama dgn di atas, periode = semua waktu). `loadAllTime()` baris 426.

### CARD: Arus Saldo Bersih
- **Render:** baris 1466 (`fmt(netCashFlow)`).
- **Rumus (v196):** `netCashFlow = totalCashIn − totalCashOut`; `totalCashIn = d.uang_masuk_total`, `totalCashOut = ukBasis + rentAgg.bebanPeriod` (sama persis dgn card Uang Masuk & Uang Keluar).
- **Catatan:** masuk pakai **kas diterima** (init_paid + cicilan + dst), keluar pakai **beban sewa** (amortisasi), bukan kas sewa — lihat BUG-7.

### CARD: Sudah Bayar (Piutang)
- **Render:** baris 1467 (`d.sudah_bayar`).
- **Query:** `Σ round(paid) FROM debts WHERE deleted_at IS NULL` (snapshot, **tidak** difilter periode).
- **Tabel:** `debts`. **Pending?** n/a (ini akumulasi pembayaran piutang). **Realtime?** ikut poll 45s.

### CARD: Uang Masuk
- **Render:** baris 1468 (`fmt(totalCashIn)`), `totalCashIn = d.uang_masuk_total`.
- **Query:** `uang_masuk_total = Σ txp.init_paid + Σ dpp.amount + Σ ecp.amount + Σ old_income.amount + Σ cbi.amount + Σ asl.sale_price`.
- **Dijumlah:** kas dari penjualan (init_paid) + cicilan piutang (debt_payments) + setoran kasbon karyawan (ecp) + pemasukan lama + pemasukan manual (credibook, **semua tipe**) + **penjualan aset**.
- **Filter:** periode masing-masing tabel; transaksi `<> dibatalkan`. **Pending?** ❌ hanya uang yang benar-benar diterima (init_paid, bukan total). **Hutang?** ✅ DP invoice hutang + cicilan. **Manual?** ✅. **Aset?** ✅. **Penyusutan/sewa/jurnal?** ❌.

### CARD: Uang Keluar
- **Render:** baris 1473 (`fmt(totalCashOut)`), `totalCashOut = ukBasis + rentAgg.bebanPeriod`.
- **ukBasis:** Σ baris `getOutflowTransactions(from,to)` (fallback `d.pengeluaran_total`).
- **`pengeluaran_total`:** `Σ exp + Σ pur(non-credit) + Σ supplier_debt_payments + Σ bank_loan_payments(amount=pokok) + Σ eca + Σ old_expense`.
- **Ditambah:** beban sewa amortisasi periode. **Pending?** n/a. **Hutang?** ✅ angsuran supplier & bank (pokok). **Manual?** ✅ (old_expense). **Aset?** ❌ (pembelian aset tidak di sini). **Penyusutan?** ❌. **Beban sewa?** ✅ (amortisasi, bukan kas penuh). **Jurnal?** ❌. **Bunga bank?** ❌ tidak termasuk (lihat BUG-2).

### CARD: Total Pengeluaran All Time
- **Render:** baris 1474. `= (pengOutAll ?? allTime.pengeluaran) + rentBebanAllTimeAcc`.
- **Sumber:** `getOutflowTransactions(ALL_TIME, today)` + beban sewa amortisasi semua waktu (JS).

### CARD: Beban (Op+Gaji+Bunga)
- **Render:** baris 1475 = `d.operasional + d.gaji + d.beban_bunga`.
- **Query:** `operasional = Σ exp WHERE category NOT IN (Gaji,Gaji Karyawan,Pembelian Bahan)`; `gaji = Σ exp WHERE category IN (Gaji,Gaji Karyawan)`; `beban_bunga = Σ bank_loan_payments.bunga` periode.
- **Tabel:** `expenses`, `bank_loan_payments`. **Catatan:** card ini **memasukkan bunga**, tetapi Uang Keluar & Laba **tidak** memasukkan bunga (lihat BUG-2).

### CARD: Hutang Supplier
- `d.hutang_supplier = Σ greatest(0, total−paid) FROM supplier_debts WHERE status='aktif' AND deleted_at IS NULL` (snapshot, abaikan periode). Tabel `supplier_debts`.

### CARD: Piutang Karyawan
- `d.piutang_karyawan = Σ greatest(0, amount−paid) FROM employee_cash_advances WHERE status='aktif' AND deleted_at IS NULL` (snapshot). Tabel `employee_cash_advances`.

### CARD: Beban Sewa Bulan Ini
- `rentAgg.bebanBulanIni` (JS) = `Σ rentBebanBulanIni(r, now)` untuk sewa non-cancelled. Sumber `prepaid_rents` via `listRents()`. **Akrual** bulan berjalan (bukan kas).

### CARD: Piutang Usaha
- `d.piutang_aktif = Σ greatest(0, total_debt−paid) FROM debts WHERE deleted_at IS NULL` (snapshot). Ada cek sinkron vs `debts` langsung (baris 410–412, hanya `console.warn`).

### CARD: Hutang Bank
- `d.hutang_bank = Σ round(sisa_pokok) FROM bank_loans WHERE status='aktif' AND deleted_at IS NULL`. Sub-teks: `pinjaman_aktif` (COUNT) + `cicilan_bank` (`Σ blp.amount` periode). Tabel `bank_loans`, `bank_loan_payments`.

### CARD: Saldo (Kas & Bank) *(owner)*
- `saldoKasBank = d.saldo_kas + d.saldo_rekening`.
- `saldo_kas = awal_cash + masuk_cash − keluar_cash`; `saldo_rekening = awal_bank + masuk_transfer + masuk_qris − keluar_transfer − keluar_qris` (semua **all-time s/d p_to**, dari CTE `bd`).
- **Masuk:** txall(init_paid) + dpall + ecpall + old_income + credibook + **asset_sales** per metode. **Keluar:** exp + pur(non-credit) + supplier/bank payment + kasbon keluar + old_expense + **prepaid_rents (kas penuh)** per metode. **Saldo awal:** modal + loan_cash.

### CARD: Aset Tetap (Nilai Buku) *(owner)*
- `asetTetap` (JS, baris 859) = `Σ calculateAssetBookValue(a).bookValue` untuk `assets` status `active|depleted|broken` (sold dikecualikan). Sumber `assets` via `listAssets()`. **Penyusutan?** ✅ (nilai buku = harga − akumulasi penyusutan).

### CARD: Sewa Dibayar Dimuka *(owner)*
- `rentAgg.dibayarDimuka` (JS) = `Σ rentAmortization(r).prepaid` sewa non-cancelled. Sumber `prepaid_rents`.

### CARD: Total Aset *(owner)*
- `asetTotal = saldo_kas + saldo_rekening + piutang_aktif + piutang_karyawan + asetTetap + sewaDibayarDimuka` (baris 865). Persediaan **sengaja tidak** dijumlahkan.

### CARD: Kekayaan Bersih *(owner)*
- `kekayaanBersih = asetTotal − totalHutang`; `totalHutang = d.hutang_supplier + d.hutang_bank`.

---

## BUG / TEMUAN

### BUG-1 — Dashboard tidak realtime (hanya polling 45 detik)
- **Lokasi:** `Accounting.jsx` baris 510–523.
- **Penyebab:** sengaja tanpa subscription (optimasi egress); hanya `setInterval(loadDashboard, 45000)` + refresh saat ganti tab/visible/tombol Sinkronkan.
- **Dampak:** order baru, pembayaran, hapus/edit, jual aset baru tampak setelah ≤45 detik atau refresh manual. Tidak sesuai harapan "realtime".
- **Solusi (usul):** tambah subscription Supabase ringan untuk `transactions/debt_payments/expenses/asset_sales/prepaid_rents/assets` yang men-trigger `loadDashboard` (debounce), atau perpendek interval saat tab aktif. Pertimbangkan biaya egress.

### BUG-2 — Bunga bank tidak konsisten antara card "Beban" vs "Uang Keluar"/"Laba"
- **Lokasi:** SQL `acc_dashboard` (`pengeluaran_total` baris 111–114 vs `beban_bunga` baris 119); `Accounting.jsx` baris 1475 vs 1473/1458.
- **Penyebab:** `pengeluaran_total` menjumlah `bank_loan_payments.amount` (**pokok saja**); `beban_bunga` = `bank_loan_payments.bunga` dihitung terpisah dan **tidak** ikut ke `pengeluaran_total`. Card "Beban (Op+Gaji+Bunga)" memasukkan bunga, tetapi "Uang Keluar" & "Laba Bersih" **tidak**.
- **Dampak:** Uang keluar/Laba **kurang menghitung beban bunga**; di sisi lain pembayaran **pokok** pinjaman ikut mengurangi Laba (padahal pokok bukan beban). Angka "Beban" tidak bisa dijumlahkan rapi dengan Uang Keluar.
- **Solusi (usul):** tentukan basis tunggal — jika basis kas: Uang Keluar = total kas keluar termasuk pokok+bunga; jika basis laba/akrual: Laba kurangi bunga (beban) + pengeluaran operasional, tetapi **jangan** kurangi pokok. Perlu keputusan kebijakan sebelum diubah.

### BUG-3 — Laba/Rugi penjualan aset tidak masuk Laba Bersih
- **Lokasi:** `acc_dashboard.laba_rugi_aset` (baris 108) ada, tapi `laba` (Accounting.jsx 533) hanya `penjualan − pengeluaran − beban sewa`.
- **Penyebab:** `gain_loss` aset tidak diikutkan ke perhitungan Laba.
- **Dampak:** untung/rugi jual aset tidak tampil di Laba Bersih (walau masuk ke Saldo & Kekayaan Bersih lewat selisih nilai buku). Bisa membuat Laba terlihat tidak mencerminkan keuntungan jual aset.
- **Solusi (usul):** sepakati apakah gain/loss aset masuk "Laba Bersih operasional" atau dipisah sebagai "Laba Lain-lain". Tampilkan baris terpisah agar transparan.

### BUG-4 — Card balance (snapshot) tidak terpengaruh filter periode
- **Lokasi:** `acc_dashboard` field `piutang_aktif`, `sudah_bayar`, `hutang_supplier`, `hutang_bank`, `piutang_karyawan`, `persediaan` — query **tanpa** `p_from/p_to`.
- **Penyebab:** item neraca/saldo bersifat snapshot saat ini.
- **Dampak:** saat user memilih "Bulan Lalu", card-card ini tetap menampilkan posisi **terkini**, bukan posisi akhir periode → membingungkan jika diharapkan historis.
- **Solusi (usul):** beri label "posisi saat ini" pada card snapshot, atau (opsional besar) buat versi "as-of p_to".

### BUG-5 — Dua mekanisme menghitung "pengeluaran" (RPC vs frontend)
- **Lokasi:** `ukBasis` = `getOutflowTransactions()` (frontend) vs `d.pengeluaran_total` (RPC) — `Accounting.jsx` baris 416, 532.
- **Penyebab:** card "Uang Keluar"/"Laba" memakai jumlah baris rincian (frontend) agar kartu = total modal Rincian; RPC `pengeluaran_total` jadi fallback saja.
- **Dampak:** bila definisi kategori/filter di `getOutflowTransactions` berbeda dari `pengeluaran_total`, Uang Keluar bisa ≠ angka RPC dan ≠ "Total Pengeluaran All Time" basisnya. Risiko divergensi diam-diam.
- **Solusi (usul):** jadikan satu sumber (idealnya RPC) untuk total, lalu rincian mengikuti; atau tambah self-check yang mem-warning bila selisih > 1.

### BUG-6 — Tanggal transaksi memakai `created_at`, bukan `date` transaksi
- **Lokasi:** `acc_dashboard` txp/txall (`created_at::date`); halaman Order memakai `t.date`.
- **Penyebab:** beda field tanggal antar modul.
- **Dampak:** total Penjualan di Accounting (per `created_at`) bisa berbeda periodisasinya dengan total di halaman Order (per `date`) untuk transaksi yang tanggal-nya diundur/diubah.
- **Solusi (usul):** samakan field tanggal acuan (pilih `created_at` atau `date`) di kedua modul.

### BUG-7 — "Arus Saldo Bersih" mencampur basis kas (masuk) dan akrual (keluar)
- **Lokasi:** `Accounting.jsx` `totalCashOut = ukBasis + rentAgg.bebanPeriod` (beban sewa amortisasi), sedangkan masuk pakai kas nyata.
- **Penyebab:** keputusan v196 menyamakan Arus Saldo dengan kartu Uang Keluar (yang berbasis beban sewa, bukan kas sewa).
- **Dampak:** "Arus Saldo Bersih" bukan arus kas murni (sewa dihitung sebagai amortisasi, bukan kas keluar). Berbeda dari mutasi Saldo (Kas & Bank) yang memakai kas sewa penuh.
- **Solusi (usul):** beri label jelas "berbasis beban" atau sediakan dua angka: Arus Kas (kas sewa) vs Arus Laba (beban sewa). Perlu keputusan.

### Catatan (bukan bug, by-design)
- `init_paid` mencegah dobel-hitung DP vs cicilan — benar.
- Penjualan aset menambah Saldo & Kekayaan, tidak ke Omzet — benar (bukan penjualan barang).
- Persediaan disembunyikan dari Total Aset — disengaja.
- Saldo (Kas & Bank) sudah terverifikasi rekonsiliasi ke rupiah pada audit sebelumnya.

---

## REKOMENDASI URUTAN PERBAIKAN (menunggu persetujuan)
1. **BUG-1 realtime** (dampak UX paling terasa, risiko rendah).
2. **BUG-5 satu sumber pengeluaran** (mencegah divergensi diam-diam).
3. **BUG-2 bunga bank** (perlu keputusan kebijakan akuntansi).
4. **BUG-3 laba aset** & **BUG-7 label arus saldo** (perlu keputusan; bisa hanya pelabelan).
5. **BUG-4 label snapshot** & **BUG-6 field tanggal** (low risk, kosmetik/penyelarasan).

---

## KEPUTUSAN KEBIJAKAN (dari owner — untuk dieksekusi nanti)
- **BUG-2 (bunga bank):** basis **KAS — pokok + bunga**. Uang Keluar/Laba harus memasukkan pokok DAN bunga cicilan bank (`bank_loan_payments.amount + bank_loan_payments.bunga`); jaga agar tidak dobel dengan card "Beban (…+Bunga)".
- **BUG-3 (laba/rugi jual aset):** **TAMPILKAN TERPISAH** sebagai baris "Laba Lain-lain (jual aset)", tidak digabung ke Laba Bersih operasional. Sumber: `acc_dashboard.laba_rugi_aset`.
- **Status:** perbaikan DITUNDA — owner ingin membaca laporan dulu. Jangan ubah kode sampai ada instruksi lanjut.

---

## HASIL EKSEKUSI PERBAIKAN (v205) — "ok lakukan"

### ✅ BUG-1 — Dashboard realtime
- **Rumus lama:** dashboard hanya polling 45 detik, tanpa subscription.
- **Rumus baru:** subscription Supabase `acc.subscribeDashboard()` ke 16 tabel sumber → `loadDashboard()` (debounce 800ms). Polling 45s **tetap** sebagai jaring pengaman.
- **File berubah:** `src/hooks/useAccounting.js` (fungsi baru `subscribeDashboard`, di-export), `src/pages/Accounting.jsx` (efek polling kini juga subscribe).
- **Query berubah:** tidak ada query/rumus angka yang berubah — hanya pemicu refresh.
- **Mengapa:** angka update otomatis saat ada order/pembayaran/edit/hapus/jual aset tanpa tunggu 45 detik.
- **Verifikasi:** buka tab Ringkasan, di tab/perangkat lain buat transaksi → angka berubah < ~1 detik. Jika realtime nonaktif di project, polling 45s tetap menyegarkan.

### ✅ BUG-3 — Laba jual aset tampil terpisah
- **Rumus lama:** `laba = penjualan − pengeluaran − beban sewa`; laba/rugi aset tidak tampil di Laba.
- **Rumus baru:** rumus `laba` **TIDAK diubah**. Ditambah kartu owner **"Laba Lain-lain — Jual Aset"** = `d.laba_rugi_aset` (muncul hanya bila ada penjualan aset di periode). Subteks Laba Bersih diperjelas: "laba operasional — di luar laba jual aset".
- **File berubah:** `src/pages/Accounting.jsx`.
- **Query berubah:** tidak ada (pakai field `laba_rugi_aset` & `penjualan_aset` yang sudah ada di `acc_dashboard`).
- **Verifikasi:** jual aset di atas/bawah nilai buku → kartu "Laba Lain-lain" muncul (+/−), Laba Bersih operasional tetap sama.

### ✅ BUG-5 — Self-check divergensi pengeluaran
- **Lama:** tidak ada peringatan bila Uang Keluar (Σ rincian) ≠ RPC `pengeluaran_total`.
- **Baru:** `console.warn` saat selisih > Rp 1 (di `loadDashboard`).
- **File:** `src/pages/Accounting.jsx`. **Verifikasi:** buka console DevTools di tab Ringkasan.

### ✅ BUG-4 — Label snapshot
- Kartu "Hutang Supplier" & "Piutang Usaha" diberi subteks **"Posisi saat ini (bukan per periode)"** agar tidak dikira mengikuti filter tanggal. File: `src/pages/Accounting.jsx`. Tidak ada perubahan angka.

### ℹ️ BUG-2 — Bunga bank (keputusan: kas pokok+bunga) → SUDAH SESUAI, tanpa ubah rumus
- **Temuan saat eksekusi:** `payBankLoan` menulis `bunga: 0` dan seluruh nominal bayar masuk ke `pokok`/`amount` (lihat `useAccounting.js` baris ~440–461). Jadi **seluruh kas yang keluar saat bayar cicilan bank (pokok + bunga yang digabung) SUDAH dihitung penuh** di `pengeluaran_total` dan `getOutflowTransactions` (kartu Uang Keluar & Laba). `beban_bunga` selalu 0 sehingga tidak ada dobel-hitung.
- **Kesimpulan:** basis "kas: pokok + bunga" **sudah terpenuhi**; tidak perlu mengubah SQL `acc_dashboard` (menghindari risiko terhadap rekonsiliasi Saldo yang sudah benar). Jika nanti ingin **memisahkan** bunga sebagai komponen sendiri, perlu perubahan input pembayaran cicilan (memasukkan bunga terpisah) lebih dulu — beri tahu bila mau.

### ⏸️ BUG-6 — Field tanggal (`created_at` vs `date`) — DITUNDA
- Mengubah field tanggal di `acc_dashboard` berisiko menggeser periodisasi Penjualan & memengaruhi verifikasi Saldo. Tidak diubah tanpa konfirmasi eksplisit. Rekomendasi tetap: samakan acuan tanggal Order vs Accounting.

### ℹ️ BUG-7 — Label "Arus Saldo Bersih"
- Sudah berlabel "Uang Masuk − Uang Keluar"; basis beban sewa dijelaskan di kartu Uang Keluar ("Termasuk beban sewa (amortisasi)"). Tidak ada perubahan rumus.

> Tidak ada perubahan kode dilakukan. Beri tahu BUG mana yang ingin diperbaiki dan keputusan kebijakan untuk BUG-2/3/7, lalu saya kerjakan satu per satu + tampilkan rumus lama vs baru, file/query yang berubah, alasan, dan cara verifikasi.
