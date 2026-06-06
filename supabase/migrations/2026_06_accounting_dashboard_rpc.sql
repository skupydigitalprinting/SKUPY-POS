-- ═══════════════════════════════════════════════════════════════════
-- RPC acc_dashboard — ringkasan keuangan SEDERHANA untuk owner.
-- Tanpa istilah debit/kredit/akun. Sumber: tabel POS langsung (transactions,
-- debt_payments, debts) + expenses/purchases/supplier_debts → konsisten dgn POS
-- & otomatis terupdate saat invoice dihapus (tidak ada data hantu).
--
-- Idempotent. Supabase → SQL Editor → Run (setelah migrasi accounting lain).
-- ═══════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.acc_dashboard(p_from date, p_to date)
RETURNS json LANGUAGE sql STABLE AS $$
  WITH txp AS (
    SELECT * FROM public.transactions
    WHERE COALESCE(order_status,'') <> 'dibatalkan'
      AND created_at::date BETWEEN p_from AND p_to
  ),
  dpp AS (
    SELECT * FROM public.debt_payments
    WHERE paid_at::date BETWEEN p_from AND p_to
  )
  SELECT json_build_object(
    -- UANG MASUK
    'penjualan',        (SELECT COALESCE(sum(round(total)),0) FROM txp),
    'uang_masuk_total', (SELECT COALESCE(sum(round(paid)),0)  FROM txp)
                        + (SELECT COALESCE(sum(round(amount)),0) FROM dpp),
    'cash',     (SELECT COALESCE(sum(round(paid)),0) FROM txp WHERE payment_method='cash')
                + (SELECT COALESCE(sum(round(amount)),0) FROM dpp WHERE payment_method='cash'),
    'transfer', (SELECT COALESCE(sum(round(paid)),0) FROM txp WHERE payment_method='transfer')
                + (SELECT COALESCE(sum(round(amount)),0) FROM dpp WHERE payment_method='transfer'),
    'qris',     (SELECT COALESCE(sum(round(paid)),0) FROM txp WHERE payment_method='qris')
                + (SELECT COALESCE(sum(round(amount)),0) FROM dpp WHERE payment_method='qris'),
    'cicilan',  (SELECT COALESCE(sum(round(amount)),0) FROM dpp),

    -- UANG KELUAR
    'pengeluaran_total', (SELECT COALESCE(sum(round(amount)),0) FROM public.expenses WHERE expense_date BETWEEN p_from AND p_to)
                         + (SELECT COALESCE(sum(round(amount)),0) FROM public.purchases WHERE COALESCE(is_credit,false)=false AND purchase_date BETWEEN p_from AND p_to),
    'pembelian_bahan',   (SELECT COALESCE(sum(round(amount)),0) FROM public.purchases WHERE purchase_date BETWEEN p_from AND p_to)
                         + (SELECT COALESCE(sum(round(amount)),0) FROM public.expenses WHERE category='Pembelian Bahan' AND expense_date BETWEEN p_from AND p_to),
    'gaji',        (SELECT COALESCE(sum(round(amount)),0) FROM public.expenses WHERE category IN ('Gaji','Gaji Karyawan') AND expense_date BETWEEN p_from AND p_to),
    'operasional', (SELECT COALESCE(sum(round(amount)),0) FROM public.expenses WHERE category NOT IN ('Gaji','Gaji Karyawan','Pembelian Bahan') AND expense_date BETWEEN p_from AND p_to),

    -- PIUTANG & HUTANG (saldo s/d tanggal)
    'piutang_aktif',   (SELECT COALESCE(sum(greatest(0, round(total_debt)-round(paid))),0) FROM public.debts WHERE status='aktif'),
    'hutang_supplier', (SELECT COALESCE(sum(greatest(0, round(total)-round(paid))),0) FROM public.supplier_debts WHERE status='aktif'),

    -- SALDO KAS & REKENING (kumulatif s/d p_to)
    'saldo_kas',      (SELECT COALESCE(sum(CASE WHEN direction='in' THEN amount ELSE -amount END),0) FROM public.cash_movements WHERE method='cash' AND moved_at::date <= p_to),
    'saldo_rekening', (SELECT COALESCE(sum(CASE WHEN direction='in' THEN amount ELSE -amount END),0) FROM public.cash_movements WHERE method IN ('transfer','qris') AND moved_at::date <= p_to),

    -- Untuk laba: modal barang (perkiraan dari pembelian bahan periode)
    'modal_barang', (SELECT COALESCE(sum(round(amount)),0) FROM public.purchases WHERE purchase_date BETWEEN p_from AND p_to)
                    + (SELECT COALESCE(sum(round(amount)),0) FROM public.expenses WHERE category='Pembelian Bahan' AND expense_date BETWEEN p_from AND p_to)
  );
$$;

GRANT EXECUTE ON FUNCTION public.acc_dashboard(date, date) TO anon, authenticated;
NOTIFY pgrst, 'reload schema';
