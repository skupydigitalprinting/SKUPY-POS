# Edit Dan Hapus Invoice Tanpa ACC Owner

Status: revisi setelah persetujuan lingkup Edit + Hapus dalam percakapan;
rancangan tertulis versi ini masih perlu ditinjau sebelum rencana implementasi.
Belum diimplementasikan atau di-deploy.
Target: /Users/thewa/Documents/GitHub/SKUPY-POS

## Tujuan Yang Disepakati

Kasir dan admin dapat mengedit dan menghapus invoice tanpa menunggu persetujuan
owner. Kasus utama yang dijelaskan pengguna: admin salah membuat invoice atau
customer mengubah barang sehingga admin membuat ulang invoice dan menghapus yang
lama. Edit lengkap menjadi jalur utama untuk pergantian barang; Hapus tetap ada
untuk pesanan tidak jadi atau salah input. Pengguna tidak ingin riwayat memenuhi
daftar pesanan. Jejak teknis disimpan di belakang layar, bukan sebagai pekerjaan
tambahan kasir atau antrean owner.
Ini perubahan arsitektur alur invoice, bukan sekadar menghapus pesan pengaman.

## Pilihan Desain

Pilihan utama adalah koreksi berversi dan penghapusan dari daftar aktif dengan
pembatalan tercatat di server. Antarmuka memakai istilah Edit Invoice dan Hapus
Invoice. Invoice yang dihapus tidak ditampilkan dalam daftar aktif atau ekspor
aktif, termasuk saat Semua Waktu dipilih. Tidak menambahkan panel riwayat ke layar
utama. Riwayat hanya dibuka secara sengaja saat pemeriksaan diperlukan.
Nomor invoice tidak dipakai ulang. Tidak ada antrean persetujuan owner atau PIN
owner. Konfirmasi dilakukan sendiri oleh kasir/admin yang menjalankan tindakan.

Menghapus permanen berikut seluruh pembayaran terkait tidak dipilih karena
menghilangkan jejak dan bisa membuat uang yang pernah diterima seolah tidak ada.
Membatasi semua koreksi kepada owner juga tidak dipilih karena bertentangan dengan
kebutuhan operasional pengguna.

## Hak Akses

- Owner, admin, dan kasir/staf aktif boleh menjalankan koreksi/pembatalan terhadap
  invoice yang memang diizinkan untuk diakses oleh kebijakan server mereka.
- Tidak otomatis membuka invoice book lain atau invoice tersembunyi. Perluasan
  akses lintas kasir/book bukan bagian dari rancangan ini.
- Nama pelaku, identitas akun, waktu server dan alasan tindakan disimpan otomatis.
- Identitas pelaku harus berasal dari sesi server yang terverifikasi, bukan
  parameter role, nama atau ID kiriman browser.
- Tetap tidak menyediakan DELETE langsung terhadap transaksi, jurnal atau
  pembayaran. Operasi resmi menjalankan validasi dan pencatatan secara utuh.

## Pengalaman Kasir

### Edit Invoice Lengkap

Tambahkan Edit Invoice ke menu aksi Order, pada desktop maupun bottom sheet
mobile. Form membuka isi invoice tersimpan, bukan keranjang checkout baru.

- Tambah, ganti atau hapus baris produk; ubah jumlah, harga dan catatan pesanan.
- Jumlah PCS harus bilangan bulat positif; meter/yard boleh dua angka desimal,
  mengikuti kasir yang sudah ada. Tidak menambahkan batas stok untuk barang custom.
- Diskon berupa nominal rupiah. Nilai dari invoice lama dipertahankan saat dibuka;
  tidak menebak jenis persen yang tidak tersimpan. Nilai pajak lama tidak dihapus
  diam-diam walaupun checkout sekarang tidak menambahkan pajak.
- Nama tampilan customer dan jatuh tempo dapat dikoreksi. Pemindahan customer ID,
  book, atau kepemilikan invoice bukan bagian dari form ini.
- ID, nomor invoice, tanggal pembuatan dan identitas kasir pembuat tidak berubah.
  Pelaku revisi dicatat terpisah, termasuk bila berbeda dari pembuat invoice.
- Produk lama yang sudah berubah harga atau dihapus dari katalog tetap tampil
  dengan snapshot invoice; jangan mengganti harga lama hanya karena form dibuka.
- Minimal satu baris produk. Angka harus finite dan valid; harga tidak negatif,
  diskon tidak melebihi subtotal. Pembulatan rupiah final disepakati antara klien
  dan server dan diuji pada jumlah meter/yard pecahan.
- Total dihitung ulang di server dari baris produk, diskon dan pajak tersimpan,
  tidak mempercayai total dari browser. Simpan items, subtotal dan total bersama.
- DP/penerimaan tampil sebagai informasi, tidak dapat ditimpa lewat editor barang.
- Setelah simpan, detail, cetak invoice, WhatsApp, tagihan dan laporan membaca
  revisi terbaru dari invoice yang sama. Tidak membuat penjualan kedua.

Perubahan nilai invoice menghitung ulang tagihan dari penerimaan yang benar-benar
tercatat. Jangan menurunkan paid secara otomatis saat total baru lebih kecil dari
uang diterima. Selisih ditampilkan sebagai kelebihan pembayaran yang perlu
dikembalikan. Koreksi catatan pembayaran adalah tindakan tersendiri dengan alasan,
nilai sebelum/sesudah, dan penyesuaian jurnal; bukan menimpa DP kumulatif.

### Hapus Invoice

Gunakan tombol Hapus Invoice dan konfirmasi kasir sendiri, bukan ACC owner. Dialog
menampilkan nomor, nilai invoice, uang diterima dan sisa tagihan. Alasan wajib.
Kasir memilih salah satu dari dua kejadian berikut tanpa meminta ACC owner:

1. Salah input/duplikat tanpa penerimaan uang nyata pada catatan ini. Koreksi
   pencatatan dilakukan dengan jejak pembalik, bukan dicatat sebagai refund nyata.
   Konfirmasi menegaskan bahwa catatan penerimaan pada invoice ini memang keliru.
   Jika ada uang nyata, pilihan ini tidak boleh digunakan.
2. Pesanan benar-benar dibatalkan. Tagihan aktif berhenti, tetapi uang yang sudah
   diterima tetap tercatat. Nilai yang belum dikembalikan berstatus Perlu Refund.

Tanpa DP/pembayaran nyata, konfirmasi alasan langsung menyelesaikan penghapusan
dari daftar aktif dan koreksi tagihan. Untuk invoice berbayar, tampilkan pilihan
perlakuan uang hanya pada dialog tersebut; jangan menambah langkah pada edit biasa.
Pesan setelah berhasil adalah Invoice dihapus, bukan permintaan pemeriksaan owner.
Konfirmasi menjelaskan bahwa penghapusan dari daftar tidak mentransfer uang.

Untuk pesanan batal, defaultnya refund belum dilakukan. Kasir dapat mencatat
pengembalian setelah benar-benar terjadi, dengan nominal, metode, waktu kejadian
dan catatan bukti. Sistem tidak melakukan transfer uang dan tidak menganggap
konfirmasi pembatalan sebagai bukti refund. Total refund tidak boleh melebihi
jumlah yang masih harus dikembalikan. Pengembalian sebagian diperbolehkan dan
menyisakan status Perlu Refund. Tidak ada biaya pembatalan atau DP hangus otomatis.

Tidak ada pembukaan ulang invoice batal pada tahap ini. Koreksi salah batal
ditangani melalui invoice pengganti yang merujuk riwayat, tanpa menyalin otomatis
uang yang sudah diterima. Pemindahan pembayaran antarinvoice tidak termasuk tahap
ini; jangan menggandakan pembayaran pada invoice pengganti.

## Pencatatan Dan Konsistensi

- Simpan snapshot sebelum/sesudah dan alasan pada riwayat yang tidak dapat diedit
  melalui klien. Invoice lama dan pembayaran asli tetap dapat ditelusuri.
- Bedakan penerimaan, koreksi salah catat, pembatalan, dan pengembalian nyata.
  Penyesuaian jurnal tidak boleh menghapus posting lama atau menghitung uang dua kali.
- Pembatalan mengeluarkan invoice dari omzet/tagihan aktif dan memperbarui ringkasan
  customer. Penerimaan uang nyata tetap masuk arus uang sampai refund dicatat.
- Dashboard, Accounting, Piutang, detail invoice dan ekspor memakai definisi yang
  sama. Filter periode membedakan tanggal invoice dan tanggal kejadian uang.
- Satu operasi server menyimpan status, tagihan, riwayat, jurnal dan ringkasan
  secara atomik: seluruhnya berhasil atau tidak ada perubahan yang tersimpan.
- Gunakan ID operasi unik, terikat pelaku dan isi permintaan. Pengiriman ulang
  mengembalikan hasil lama, tidak menambah koreksi/refund kedua.
- Kunci invoice dan data terkait; tolak versi formulir yang sudah usang apabila
  ada pembayaran atau koreksi lain saat dialog terbuka. Tampilkan data terbaru.
- Kegagalan jaringan yang hasilnya belum pasti diperiksa melalui status operasi,
  bukan memulai operasi baru. Jangan menampilkan berhasil sebelum terkonfirmasi.
- Riwayat historis yang tidak cocok tidak ditebak atau diubah massal. Kesalahan
  menampilkan ketidakcocokan yang perlu diperbaiki, bukan permintaan ACC owner.

## Batas Implementasi Dan Rilis

Titik integrasi utama: src/pages/Order.jsx, editor Dashboard, src/hooks/useStore.js,
komponen editor invoice, cetak/ekspor, laporan keuangan, dan operasi database
invoice. Editor item baru memakai bentuk snapshot items kasir yang sudah ada;
jangan merombak halaman kasir atau master produk. Jalur edit lama di Dashboard
harus memakai operasi yang sama agar tidak menimpa paid/DP atau melewati validasi.
Gunakan pola operasi pembayaran
yang ada sebagai rujukan; kandidat 010 bukan bukti bahwa alur ini sudah aktif.
Kontrak baru harus hidup berdampingan dengan pencatatan penerimaan dan mencegah
jalur lama melewati validasinya. Jangan melonggarkan RLS atau memberi RPC keuangan
berprivilege kepada pengguna anonim demi kompatibilitas login lama.

Catatan pemeriksaan 12 September masih menyatakan login server, recovery owner,
backup lengkap database beserta Storage, dan uji pemulihan belum terbukti siap.
Kondisi tersebut harus diverifikasi ulang, bukan dianggap masih sama atau sudah
selesai pada 24 September. Rilis produksi memerlukan alur akun yang bekerja,
backup/pemulihan teruji, integrasi seluruh penulis invoice dan rencana rollback.
Ini persyaratan rilis pengembang, bukan persetujuan owner untuk setiap invoice.

Setelah rancangan ini disetujui, susun rencana implementasi dan pengujian. Deployment
dilakukan otomatis setelah seluruh syarat rilis lulus sesuai permintaan pengguna.
Tidak ada penghapusan atau koreksi transaksi produksi selama pengembangan/uji.

## Kriteria Penerimaan

- Kasir/admin sah menyelesaikan koreksi atau pembatalan tanpa sesi/ACC owner.
- Ganti produk, jumlah pecahan meter/yard, harga, diskon, catatan dan jatuh tempo
  mempertahankan nomor invoice dan uang diterima; cetak menampilkan isi terbaru.
- Contoh: total 500000 dan DP 200000, diedit menjadi total 400000, menghasilkan
  tagihan 200000 dan tetap satu invoice. Edit menjadi 150000 menghasilkan tagihan
  nol dan kelebihan pembayaran 50000, bukan mengurangi paid menjadi 150000.
- Produk nonaktif/hilang dan harga katalog yang berubah tidak merusak snapshot lama.
- Hapus tanpa pembayaran, hapus catatan salah input, dan hapus pesanan batal
  dengan uang nyata menghasilkan angka yang sesuai jenis tindakan, bukan satu
  perlakuan yang selalu menghilangkan uang diterima.
- Pengguna anonim, nonaktif, akun lain dan book di luar izin ditolak oleh server.
- Salah input tanpa uang nyata, batal tanpa DP, batal dengan DP, cicilan campuran,
  invoice lunas, refund sebagian/penuh, serta koreksi kelebihan bayar diuji.
- Dua kasir bersamaan, klik ulang, kegagalan di setiap tahap simpan, respons hilang,
  pergantian sesi, dan pengiriman ulang setelah muat halaman tidak merusak saldo.
- Identitas, alasan, snapshot dan seluruh riwayat uang tetap dapat ditelusuri.
- Total invoice, tagihan customer, jurnal, arus uang dan ekspor saling cocok.
- Uji UI mobile/desktop memakai data sintetis; uji konkurensi memakai koneksi
  database terpisah. Tes simulasi saja tidak dianggap bukti transaksi atomik.
- Tidak menyatakan selesai sebelum kandidat terintegrasi, diuji dan rilis produksi
  diverifikasi. Keberhasilan tes kandidat saja bukan keberhasilan deployment.
