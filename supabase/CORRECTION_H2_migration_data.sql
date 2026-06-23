-- =====================================================================
-- KOREKSI DATA H2 — Migrasi gelondongan & loan_cash (Skupy POS)
-- =====================================================================
-- Tujuan: merapikan angka Omset/Laba/Neraca TANPA mengubah rumus.
-- SEMUA pakai SOFT DELETE (deleted_at). Tidak ada hard delete.
-- JALANKAN BAGIAN PREVIEW DULU. Bagian KOREKSI sengaja di-comment —
-- buka comment HANYA setelah Anda yakin nilainya benar.
-- =====================================================================

-- ───────── 1) PREVIEW: lihat baris yang bermasalah ─────────
-- a. Migrasi pemasukan & pengeluaran gelondongan
SELECT type, name, method, count(*) AS jml, sum(round(amount)) AS total
FROM public.migration_details
WHERE deleted_at IS NULL AND type IN ('old_income','old_expense')
GROUP BY type, name, method
ORDER BY total DESC;

-- b. Saldo awal (modal vs pinjaman)
SELECT type, method, sum(round(amount)) AS total
FROM public.migration_details
WHERE deleted_at IS NULL AND type IN ('modal','loan_cash')
GROUP BY type, method;

-- c. Apakah loan_cash punya pasangan Hutang Bank?
SELECT count(*) AS jml_bank_loans, COALESCE(sum(round(sisa_pokok)),0) AS sisa_pokok
FROM public.bank_loans WHERE deleted_at IS NULL AND status='aktif';

-- =====================================================================
-- ───────── 2) KOREKSI (buka comment sesuai kebutuhan) ─────────
-- =====================================================================

-- OPSI A — Migrasi gelondongan hanya untuk SEED SALDO (bukan omset/biaya nyata)
--   Hapus dua lump (income & expense), lalu catat NET-nya sebagai Modal Disetor
--   supaya SALDO TIDAK BERUBAH tapi Omset & Total Pengeluaran tidak lagi
--   menggelembung. Ganti <NET> dengan (old_income − old_expense).
--   Contoh: 4.143.647.663 − 4.127.558.777 = 16.088.886
--
-- BEGIN;
--   UPDATE public.migration_details SET deleted_at = now()
--    WHERE deleted_at IS NULL AND type IN ('old_income','old_expense');
--   INSERT INTO public.migration_details (type, name, amount, method, trx_date)
--   VALUES ('modal', 'Saldo Awal (net migrasi)', 16088886, 'transfer', CURRENT_DATE);
-- COMMIT;
--
--   ➜ Setelah ini: Omset & Total Pengeluaran turun ~4 M (lebih jujur),
--     Saldo tetap, Laba jadi realistis. Modal Disetor naik = net.

-- OPSI B — loan_cash adalah PINJAMAN yang harus dibayar (bukan modal)
--   Catat sebagai Hutang Bank supaya Neraca benar (Kekayaan turun sebesar
--   pinjaman, Hutang Bank naik). loan_cash tetap di saldo awal (kas masuk),
--   tapi kini ADA liabilitas penyeimbang. Ganti nilai sesuai pinjaman riil.
--
-- BEGIN;
--   INSERT INTO public.bank_loans
--     (nama_bank, jenis_pinjaman, plafon, sisa_pokok, tanggal_mulai, status, keterangan)
--   VALUES
--     ('(Nama Bank)', 'Pinjaman Modal', 640960190, 640960190, CURRENT_DATE, 'aktif',
--      'Penyeimbang loan_cash migrasi (audit H2)');
-- COMMIT;
--
--   ➜ Jika loan_cash sebenarnya MODAL SENDIRI (bukan utang), JANGAN jalankan B;
--     cukup ubah type 'loan_cash' → 'modal':
--   UPDATE public.migration_details SET type='modal'
--    WHERE deleted_at IS NULL AND type='loan_cash';

-- =====================================================================
-- 3) VERIFIKASI setelah koreksi — pastikan Saldo tetap & angka masuk akal
-- =====================================================================
-- SELECT (acc_dashboard('2000-01-01', CURRENT_DATE)) ->> 'saldo_kas'  AS kas,
--        (acc_dashboard('2000-01-01', CURRENT_DATE)) ->> 'saldo_rekening' AS bank,
--        (acc_dashboard('2000-01-01', CURRENT_DATE)) ->> 'penjualan'   AS omset,
--        (acc_dashboard('2000-01-01', CURRENT_DATE)) ->> 'hutang_bank' AS hutang_bank;
