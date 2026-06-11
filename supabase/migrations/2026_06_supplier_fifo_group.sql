-- =====================================================================
-- Skupy POS — Migration: Pembayaran Gabungan FIFO Hutang Supplier
-- =====================================================================
-- Menambah kolom fifo_group pada supplier_debt_payments. Satu pembayaran
-- gabungan FIFO menulis beberapa baris (1 per nota) dengan fifo_group yang
-- sama, sehingga bisa dihapus sebagai satu batch (membatalkan semua alokasi).
-- Idempotent. Tempel di Supabase → SQL Editor → Run.
-- =====================================================================

ALTER TABLE public.supplier_debt_payments
  ADD COLUMN IF NOT EXISTS fifo_group uuid;

CREATE INDEX IF NOT EXISTS idx_sdp_fifo_group
  ON public.supplier_debt_payments (fifo_group);

NOTIFY pgrst, 'reload schema';
