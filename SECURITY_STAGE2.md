# Keamanan tahap 2: persiapan login

Catatan lanjutan 10 September 2026: dokumen ini adalah hasil tahap 2 saat itu.
Integrasi login untuk preview, pengelolaan sesi, dan reset staf oleh owner kini
telah dibuat dan diuji terpisah. Hasil terbaru, batas pengujian, dan syarat
deploy tercatat di [SECURITY_STAGE3.md](SECURITY_STAGE3.md). Produksi belum diubah.

## Batas tahap ini

Persetujuan pengguna: lanjutkan persiapan lingkungan uji dan migrasi login.
Implementasi ini terpisah dari login kasir yang aktif. Tidak mengubah akun,
policy produksi, mengambil password lama, atau membuat project berbayar.

## Rancangan

- Pengguna telah mengonfirmasi sebagian staf belum punya email. Jalur username
  melalui server dan adapter klien telah dibuat, dengan identitas Auth internal
  per orang. Tidak memakai email atau akun bersama. Pemulihan staf oleh owner
  belum dibuat; email pemulihan owner masih perlu dikonfirmasi.
- ID admins lama dipertahankan agar referensi transaksi dan PIC tidak berubah.
- Pemetaan Auth -> admin, peran, dan status aktif disimpan di schema private,
  bukan metadata pengguna yang bisa diedit sendiri atau session browser.
- RPC profil tidak menerima ID pengguna. Ia memakai auth.uid() dari JWT.
- Modul login memverifikasi getUser sebelum meminta profil; kegagalan sesi,
  mapping hilang/nonaktif, atau role tidak dikenal tidak boleh memberi akses.
- Tidak ada fallback ke password tabel admins pada modul baru.
- SQL ini hanya jembatan identitas, BUKAN penutupan policy bisnis lama.

## Pekerjaan

- [x] Modul login terpisah beserta pengujian gagal/sukses.
- [x] Kandidat SQL pemetaan identitas dan uji izin dengan data buatan.
- [x] Pemeriksaan regresi aplikasi dan build.
- [x] Server login username, pembatas percobaan, dan adapter sesi terpisah.
- [x] Uji Supabase Auth/REST sesungguhnya di localhost dengan akun buatan.
- [ ] Lingkungan uji lengkap dengan schema bisnis, Storage, dan Realtime.
- [ ] Backup isi Storage dan uji pemulihan database/file.
- [ ] Konfirmasi email pemulihan owner, provisioning staf tanpa email, dan
  matriks peran bisnis. Jangan melakukan lookup email/password publik.
- [ ] Integrasi lifecycle login/logout, pembatalan request, cache, Realtime,
  pengelolaan akun server-side, dan pemulihan password ke aplikasi.
- [ ] Policy akhir 41 tabel, Storage, default grants, dan seluruh RPC bisnis.
- [ ] Uji pesanan, DP/pelunasan/invoice, Accounting, lalu cutover terkoordinasi.

## Larangan cutover

Jangan deploy sebagai sistem login selesai. Jangan menjalankan SQL kandidat
pada produksi atau mencabut anon sebelum semua pengujian integrasi selesai.
Jangan gunakan tabel admins.role lama sebagai sumber otorisasi karena masih
memiliki policy publik. Jangan menyalin password lama ke Auth.

## Hasil persiapan

- `src/lib/posAuth.js`: adapter signIn/signInUsername/restore/signOut dengan batas SDK yang
  dapat diuji. Tidak diimpor oleh useStore sehingga login aktif tidak berubah.
- `supabase/security-stage2/001_identity_bridge.sql`: kandidat schema private,
  mapping unik dengan status default nonaktif, dan RPC profil hanya untuk
  authenticated. Hanya diterapkan di lab lokal, bukan produksi.
- `supabase/security-stage2/002_username_login.sql`: pemetaan username private
  dan pembatas percobaan atomik, hanya dapat dipanggil service_role.
- `api/auth/login.js` dan `server/`: endpoint nonaktif secara default, hanya
  mengizinkan preview dengan project uji nonproduksi yang dikonfigurasi eksplisit.
- `tools/security-lab`: PostgreSQL in-memory untuk menguji izin dengan data
  buatan, ditambah pengujian integrasi opt-in pada Supabase localhost terisolasi.
  Uji in-memory tidak menerima URL/credential database atau membaca .env.
  Peran dari admins.role sengaja berbeda dalam fixture untuk membuktikan
  bahwa peran lama bukan sumber otorisasi baru.
- Docker kini tersedia. Supabase lokal Auth/REST/database berjalan dengan port
  API dan database terikat eksplisit ke 127.0.0.1. Akun buatan pengujian telah
  dihapus oleh cleanup tes. Storage, Realtime, dan schema bisnis lengkap belum
  diuji. Keberhasilan Auth/REST bukan bukti seluruh aplikasi aman.
- Backup file produksi belum dibuat; restore belum diuji. Tidak menganggap
  backup database harian sebagai backup lengkap Storage.
- Belum commit, push, deploy, mengundang akun, atau mengubah password.

## Verifikasi

- 45 pengujian JavaScript lulus: adapter Auth/username, endpoint HTTP, guard
  preview, profil admin, aset, dan thumbnail.
- 12 pengujian PostgreSQL in-memory lulus, termasuk default grants permisif,
  isolasi mapping, limit percobaan, dan regresi IP terblokir menghabiskan limit global.
- 1 pengujian integrasi Auth/REST lokal lulus: login, pemulihan sesi, logout,
  password salah, mapping nonaktif, penolakan RPC anonim, dan limit username.
  Dari 20 percobaan RPC bersamaan, tepat 10 diterima tanpa error/deadlock.
  Total 58 pengujian lulus pada 10 September 2026.
- Build Vite berhasil pada salinan `/private/tmp/skupy-security-stage2`
  tanpa environment produksi. Modul persiapan belum dibundel ke aplikasi.
- `git diff --check` lulus. Tidak ada pengujian transaksi/akun di produksi.
- Review terpisah menemukan risiko penghabisan limit global oleh IP terblokir
  dan perbedaan waktu respons akun tidak dikenal. Keduanya telah dimitigasi dan
  diuji ulang; review ulang tidak menemukan masalah baru dalam scope preview.
  Dummy Auth dan minimum waktu respons mengurangi, bukan menghapus, kebocoran
  timing jaringan. Uji kegagalan cleanup sesi, cache lintas akun/tab, pemulihan
  password, dan lifecycle layar kasir masih diperlukan sebelum integrasi.

## Referensi

- https://supabase.com/docs/reference/javascript/auth-signinwithpassword
- https://supabase.com/docs/reference/javascript/auth-getuser
- https://supabase.com/docs/guides/database/postgres/row-level-security
- https://supabase.com/docs/guides/local-development
