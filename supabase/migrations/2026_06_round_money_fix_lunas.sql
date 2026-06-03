-- ─────────────────────────────────────────────────────────────
-- Bulatkan kolom uang ke integer rupiah & perbaiki status LUNAS
-- untuk data LAMA yang terkena floating drift.
--
-- Konteks bug:
--   Nominal uang sempat diproses sebagai float, sehingga sisa bisa
--   bernilai mis. 0.000000004 (bukan 0 persis). Akibatnya:
--     • invoice yang sudah dibayar penuh tetap berstatus belum lunas
--     • prefill "bayar full" bisa menampilkan angka kelebihan nol
--   Kode aplikasi sudah diperbaiki (semua uang = integer). Migrasi ini
--   merapikan data yang TERLANJUR tersimpan.
--
-- Aman & idempotent. Cara pakai: Supabase → SQL Editor → Run.
-- ─────────────────────────────────────────────────────────────

-- 1) TRANSACTIONS — bulatkan uang, hitung ulang remaining
UPDATE public.transactions
SET total     = round(total),
    paid      = round(coalesce(paid, 0)),
    dp        = round(coalesce(dp, 0)),
    remaining = GREATEST(0, round(total) - round(coalesce(paid, 0)));

-- Tandai LUNAS bila sisa sudah 0 tapi masih berstatus 'pending'
-- (status workflow lain seperti 'proses'/'selesai' tidak diutak-atik).
UPDATE public.transactions
SET status = 'lunas'
WHERE remaining <= 0 AND status = 'pending';

-- 2) DEBTS — bulatkan uang, hitung ulang remaining
UPDATE public.debts
SET total_debt = round(total_debt),
    paid       = round(coalesce(paid, 0)),
    remaining  = GREATEST(0, round(total_debt) - round(coalesce(paid, 0)));

-- Tandai LUNAS bila sisa sudah 0
UPDATE public.debts
SET status = 'lunas'
WHERE remaining <= 0 AND status = 'aktif';

-- 3) CUSTOMERS — hitung ulang total_debt dari SUM(debts.remaining yang aktif)
UPDATE public.customers c
SET total_debt = COALESCE((
  SELECT SUM(d.remaining)
  FROM public.debts d
  WHERE d.customer_id = c.id AND d.status = 'aktif'
), 0);

-- Refresh cache schema PostgREST
NOTIFY pgrst, 'reload schema';
