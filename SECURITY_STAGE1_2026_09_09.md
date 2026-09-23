# SKUPY POS - Keamanan Tahap 1

Tanggal: 9 September 2026
Kode dasar: `2f1f355`
Project yang diperiksa: `ejqfttivgovhqhzkrncx`

## Status

- Pemeriksaan kode lokal selesai untuk login, profil admin, dan pola akses awal.
- Perbaikan pembatasan data profil admin tersedia lokal; belum commit, push, atau deploy.
- Inventaris izin database produksi selesai melalui tiga query metadata READ ONLY.
- Pemeriksaan dashboard mencakup backup, Security Advisor, dan pengaturan Data API.
- Audit tahap ini belum mencakup uji HTTP tanpa sesi, isi setiap fungsi, atau uji pemulihan.
- Tidak ada perubahan akun, password, policy, atau data bisnis di produksi.
- Dokumen audit lama bukan bukti bahwa konfigurasi produksi masih sama hari ini.

## Perbaikan lokal tahap pertama

Pengambilan profil admin sekarang secara eksplisit meminta hanya
`id,username,name,role`. Berlaku untuk pemuatan daftar admin, respons login,
serta respons tambah dan edit admin. Mapper profil tidak meneruskan password
atau kolom tambahan ke state React. Penggantian password tidak lagi menyalin
password baru ke state daftar admin.

Ini pembatasan data aplikasi, BUKAN perbaikan autentikasi atau penutupan API.
Login lama masih mengirim password sebagai filter query database, password
masih disimpan dalam kolom lama, dan jalur ganti password masih membaca
password akun tersebut. Ketiganya perlu diganti bersama migrasi Supabase Auth.
Menghapus kolom atau mencabut izin saat ini tanpa migrasi dapat memutus login.

## Temuan kode yang harus ditindaklanjuti

| Prioritas | Temuan | Bukti lokal | Verifikasi produksi |
|---|---|---|---|
| Kritis | Login membandingkan password langsung di tabel admins | `src/hooks/useStore.js`, fungsi login/changePassword | Policy dan hak akses kolom admins; jangan mengambil nilai password |
| Kritis | Skrip SQL mendefinisikan policy FOR ALL dengan USING(true) | `supabase/schema.sql` dan beberapa migrasi accounting | Inventaris policy dan grant aktif |
| Tinggi | Identitas dan peran sesi berasal dari storage browser | loadSession/saveSession di useStore | Pastikan kelak hanya JWT Auth dan profil server yang menentukan akses |
| Tinggi | Data utama dimuat sebelum layar login diputuskan | refreshAll di useStore; pengecekan currentUser di App | Uji akses tanpa sesi pada lingkungan pengujian |
| Tinggi | Storage memiliki pola upload/update/delete publik dalam SQL | schema.sql dan migrasi products_storage_bucket | Policy storage.objects dan status public bucket |
| Tinggi | Fungsi keuangan memiliki grant anon dan sebagian SECURITY DEFINER | migrasi accounting | Grant efektif, search_path, dan validasi peran di setiap RPC |
| Sedang | Password baru minimal empat karakter; tidak tampak pembatasan percobaan login dalam alur aplikasi | addAdmin/updateAdmin/changePassword/login | Konfigurasi Auth, rate limit, MFA owner setelah migrasi |

Status di atas tidak menyatakan telah terjadi kebocoran atau serangan.
Role dalam menu saat ini juga mengizinkan Staff Admin melihat Accounting.
Hak akhir Staff Admin perlu disepakati sebelum pembatasan database diterapkan.

## Pemeriksaan produksi yang disiapkan

Skrip lengkap `supabase/audits/2026_09_09_security_inventory.sql` tersedia
untuk pengulangan audit. Skrip lengkap itu belum dijalankan sebagai satu file.
Tiga query ringkas yang benar-benar dijalankan melalui SQL Editor disimpan di
`supabase/audits/2026_09_09_executed_checks.sql`.

- Transaksi READ ONLY, dengan batas waktu 15 detik dan ROLLBACK.
- Membaca metadata RLS, policy, grant, view, fungsi, dan default privilege.
- Membaca nama/jenis kolom kredensial, bukan nilainya.
- Membaca status publik bucket dan jumlah akun Auth, tanpa daftar akun.
- Tidak memanggil RPC bisnis atau mencoba INSERT/UPDATE/DELETE produksi.

Grant tabel adalah satu lapisan pemeriksaan: hasil anon_select=true sendiri
belum membuktikan baris dapat dibaca, karena policy RLS juga harus dievaluasi.
Sebaliknya, policy USING(true) tanpa grant yang sesuai belum cukup untuk
menyimpulkan operasi dapat dijalankan. Hak fungsi dan view harus dianalisis
tersendiri. Hasil inventaris berisi konfigurasi internal; jangan dipublikasikan.

## Hasil produksi terverifikasi

Inventaris pertama: 9 September 2026, 10:28:54 WIB (03:28:54 UTC).
Sumber: katalog PostgreSQL di SQL Editor project produksi dan halaman
Supabase terkait. Tidak mengambil nilai password, nama pengguna, isi invoice,
atau data transaksi. Jumlah akun dan distribusi peran dibaca sebagai agregat.

| Prioritas | Hasil | Implikasi |
|---|---|---|
| Kritis | 41 tabel public semuanya RLS aktif, tetapi anon memiliki SELECT/INSERT/UPDATE/DELETE dan setiap tabel memiliki policy permisif ALL tanpa syarat | RLS aktif saja tidak melindungi data dari peran anon |
| Kritis | admins mempunyai dua policy ALL tanpa syarat; anon memiliki SELECT pada kolom password | Lapisan izin database tidak melindungi kredensial lama; tidak dilakukan pembacaan nilai password |
| Tinggi | Supabase Auth berisi 0 akun; admins lama berisi 1 owner, 1 admin, 2 staff | Empat identitas harus dipetakan ke login baru sebelum akses lama ditutup |
| Tinggi | Bucket logos, invoices, products bersifat public; 12 policy storage.objects mengizinkan SELECT/INSERT/UPDATE/DELETE untuk public dengan syarat bucket_id saja | Tidak ada pembatasan pemilik atau sesi pada policy tersebut; grants anon untuk empat operasi juga true |
| Tinggi | 26 fungsi public dapat dieksekusi anon; 14 SECURITY DEFINER | Perlu audit fungsi satu per satu, bukan sekadar membatasi menu aplikasi |
| Tinggi | Backup harian tersedia tetapi tidak mencakup isi file Storage | Pemulihan database saja tidak memulihkan gambar/invoice yang terhapus |

Rincian pembatasan kesimpulan:

- Ada 50 policy public, 49 merupakan ALL tanpa syarat; tidak ditemukan
  policy RESTRICTIVE pada public/storage. USAGE schema public dan storage
  tersedia bagi anon maupun authenticated.
- Dari 26 fungsi, 15 mengembalikan trigger/event_trigger, bukan endpoint RPC
  biasa. Ada 11 fungsi non-trigger, 5 di antaranya SECURITY DEFINER:
  acc_bootstrap_migration_details, acc_delete_employee_advance,
  acc_delete_supplier_debt, acc_recalc_bank_loan, dan acc_resync.
  Badan fungsi dan pemeriksaan otorisasi internal belum diperiksa; tidak
  menyimpulkan semua fungsi dapat disalahgunakan hanya dari grant EXECUTE.
- Tidak ditemukan view/materialized view public.
- Default privilege berbeda menurut pembuat objek. Untuk supabase_admin,
  anon masih mendapatkan hak luas pada tabel, sequence, dan fungsi baru.
  Untuk postgres, default tabel masih memuat hak TRUNCATE/REFERENCES/TRIGGER/
  MAINTAIN bagi anon walaupun CRUD tidak ada dalam default tersebut.
  Default privilege tidak sama dengan hak objek lama dan perlu dibatasi
  untuk semua role pembuat objek, lalu diuji pada lingkungan nonproduksi.
- Pengaturan Data API menampilkan 2 dari 2 schema exposed, tetapi 0 dari 41
  tabel dan 0 dari 26 fungsi exposed; halaman policy menampilkan API DISABLED.
  Ini berbeda dari grant efektif PostgreSQL yang dibaca. Penyebab perbedaan
  belum dipastikan. Tidak mengaktifkan toggle maupun menguji HTTP dengan
  mengambil data sensitif. Keterjangkauan API eksternal belum terverifikasi;
  label dashboard tidak digunakan sebagai bukti bahwa izin database aman.
- Security Advisor menampilkan 0 errors dan 92 warnings. Baris yang terlihat
  mencakup Function Search Path Mutable. Jumlah ini bukan jumlah celah unik
  atau bukti aplikasi aman; seluruh warning belum diklasifikasikan.
- Tersedia 7 backup harian, 2-8 September UTC. Backup terbaru 8 September
  17:44:25 UTC, yaitu 9 September 00:44:25 WIB. Tidak menjalankan restore;
  kemampuan pemulihan dan PITR belum diuji.
- Dashboard menampilkan Outstanding invoices dengan peringatan potensi
  gangguan layanan. Tidak membuka atau membayar tagihan.

Belum diperiksa: konfigurasi signup, password policy Auth, MFA, network
restrictions, log indikasi penyalahgunaan, dan uji negatif HTTP/RPC.
Temuan ini membuktikan kelemahan konfigurasi, bukan kejadian kebocoran.

## Tahap berikutnya setelah inventaris

1. Siapkan lingkungan uji dan buktikan jalur pemulihan database serta file.
2. Tetapkan matriks peran berdasarkan pekerjaan yang benar-benar diizinkan.
3. Migrasikan identitas ke Supabase Auth; siapkan pemulihan akun owner dan
   pemetaan admin_id lama agar invoice/PIC tetap terhubung. Jangan mencetak
   atau mengekspor password lama ke laporan maupun log.
4. Pindahkan operasi pengelolaan akun ke server yang memverifikasi owner;
   service-role key tidak boleh masuk browser.
5. Terapkan policy per operasi pada tabel dan Storage, serta pembatasan RPC.
   Policy permisif lama digabung dengan OR: menambahkan policy ketat di
   sampingnya tidak menutup akses. Validasi harus memakai policy akhir.
6. Uji pengguna tanpa sesi, owner, admin, dan kasir; termasuk percobaan akses
   lintas pengguna/book, perubahan role sendiri, dan RPC keuangan langsung.
7. Uji pesanan custom, DP, pelunasan, invoice, gambar, dan Accounting. Stok
   tidak menjadi cakupan tahap keamanan ini.
8. Lakukan perpindahan terkoordinasi aplikasi dan aturan akses. Hapus sesi
   lama dari jalur otorisasi. Penghapusan kolom password lama dilakukan
   setelah jalur login baru diverifikasi dan prosedur pemulihan disiapkan.

Jangan mengandalkan patch profil ini sebagai alasan menunda penutupan akses
database yang terbukti terbuka. Jangan menerapkan contoh policy lama dari
REMEDIATION_PLAN_C1_H1.md apa adanya tanpa pengujian matriks peran.

## Verifikasi lokal

- 10 pengujian lulus: profil admin, pembayaran aset, dan thumbnail produk.
- Pemeriksaan diff tidak menemukan whitespace error.
- Build aplikasi berhasil pada salinan lokal terisolasi tanpa file environment produksi.
- Tiga query metadata READ ONLY berhasil pada PostgreSQL produksi; tidak ada
  DDL/DML, perubahan akun, atau pemanggilan RPC bisnis.
- Login, pergantian password, dan perubahan admin produksi tidak diuji karena
  tahap ini tidak menjalankan perubahan akun.
