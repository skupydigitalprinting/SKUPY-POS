-- ═══════════════════════════════════════════════════════════════════
-- HUTANG BANK: nomor urut pembayaran (payment_number)
-- ═══════════════════════════════════════════════════════════════════
-- "Pembayaran ke-" otomatis berurutan per pinjaman, hanya menghitung
-- pembayaran aktif (deleted_at IS NULL). Idempotent.
-- Jalankan di Supabase → SQL Editor (kapan saja setelah modul accounting).
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE public.bank_loan_payments ADD COLUMN IF NOT EXISTS payment_number integer;

-- Backfill nomor urut berdasarkan tanggal bayar per loan (yang aktif saja)
WITH ordered AS (
  SELECT id, row_number() OVER (PARTITION BY loan_id ORDER BY paid_at, created_at) AS rn
  FROM public.bank_loan_payments
  WHERE deleted_at IS NULL
)
UPDATE public.bank_loan_payments b
   SET payment_number = o.rn
  FROM ordered o
 WHERE o.id = b.id;

NOTIFY pgrst, 'reload schema';
