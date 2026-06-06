-- ═══════════════════════════════════════════════════════════════════
-- SINKRONISASI Piutang ⇄ Accounting (single source of truth)
-- ═══════════════════════════════════════════════════════════════════
-- Memastikan angka di Accounting IDENTIK dengan menu Piutang & Dashboard:
--   • Piutang Usaha (acc)   == Total Piutang Aktif (Piutang)  → Σ sisa semua debts
--   • Sudah Bayar           == Σ debts.paid (DP + semua cicilan)
--   • Arus Kas Bersih       == uang yang BENAR-BENAR diterima (DP + cicilan +
--                              penjualan tunai), TANPA double-count cicilan.
--
-- Kunci anti double-count: untuk tiap transaksi, "penerimaan awal" (DP/lunas) =
--   paid − Σ(cicilan invoice itu). Cicilan dihitung terpisah dari debt_payments.
--   → DP hutang diperlakukan sebagai Cash (POS tidak menyimpan metode DP).
--
-- Idempotent. Supabase → SQL Editor → Run (setelah migrasi accounting lain).
-- ═══════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.acc_dashboard(p_from date, p_to date)
RETURNS json LANGUAGE sql STABLE AS $$
  WITH cic_all AS (
    SELECT invoice_no, sum(round(amount)) AS cic
    FROM public.debt_payments WHERE invoice_no IS NOT NULL GROUP BY invoice_no
  ),
  -- transaksi valid dalam periode + penerimaan awal (paid − cicilan)
  txp AS (
    SELECT t.payment_method, round(t.total) AS total,
           GREATEST(0, round(t.paid) - COALESCE(ca.cic,0)) AS init_paid
    FROM public.transactions t
    LEFT JOIN cic_all ca ON ca.invoice_no = t.invoice_no
    WHERE COALESCE(t.order_status,'') <> 'dibatalkan'
      AND t.created_at::date BETWEEN p_from AND p_to
  ),
  -- transaksi valid s/d p_to (untuk saldo kumulatif)
  txall AS (
    SELECT t.payment_method,
           GREATEST(0, round(t.paid) - COALESCE(ca.cic,0)) AS init_paid
    FROM public.transactions t
    LEFT JOIN cic_all ca ON ca.invoice_no = t.invoice_no
    WHERE COALESCE(t.order_status,'') <> 'dibatalkan'
      AND t.created_at::date <= p_to
  ),
  dpp  AS (SELECT * FROM public.debt_payments WHERE paid_at::date BETWEEN p_from AND p_to),
  dpall AS (SELECT * FROM public.debt_payments WHERE paid_at::date <= p_to)
  SELECT json_build_object(
    'penjualan',        (SELECT COALESCE(sum(total),0) FROM txp),
    -- Arus kas / uang masuk = penerimaan awal (DP hutang dianggap cash) + cicilan
    'uang_masuk_total', (SELECT COALESCE(sum(init_paid),0) FROM txp) + (SELECT COALESCE(sum(round(amount)),0) FROM dpp),
    'cash',     (SELECT COALESCE(sum(init_paid),0) FROM txp WHERE payment_method IN ('cash','hutang'))
                + (SELECT COALESCE(sum(round(amount)),0) FROM dpp WHERE payment_method='cash'),
    'transfer', (SELECT COALESCE(sum(init_paid),0) FROM txp WHERE payment_method='transfer')
                + (SELECT COALESCE(sum(round(amount)),0) FROM dpp WHERE payment_method='transfer'),
    'qris',     (SELECT COALESCE(sum(init_paid),0) FROM txp WHERE payment_method='qris')
                + (SELECT COALESCE(sum(round(amount)),0) FROM dpp WHERE payment_method='qris'),
    'cicilan',  (SELECT COALESCE(sum(round(amount)),0) FROM dpp),
    -- Penerimaan piutang (DP hutang + cicilan) = "Sudah Bayar" periode
    'penerimaan_piutang', (SELECT COALESCE(sum(init_paid),0) FROM txp WHERE payment_method='hutang')
                          + (SELECT COALESCE(sum(round(amount)),0) FROM dpp),

    -- UANG KELUAR
    'pengeluaran_total', (SELECT COALESCE(sum(round(amount)),0) FROM public.expenses WHERE expense_date BETWEEN p_from AND p_to)
                         + (SELECT COALESCE(sum(round(amount)),0) FROM public.purchases WHERE COALESCE(is_credit,false)=false AND purchase_date BETWEEN p_from AND p_to),
    'pembelian_bahan',   (SELECT COALESCE(sum(round(amount)),0) FROM public.purchases WHERE purchase_date BETWEEN p_from AND p_to)
                         + (SELECT COALESCE(sum(round(amount)),0) FROM public.expenses WHERE category='Pembelian Bahan' AND expense_date BETWEEN p_from AND p_to),
    'gaji',        (SELECT COALESCE(sum(round(amount)),0) FROM public.expenses WHERE category IN ('Gaji','Gaji Karyawan') AND expense_date BETWEEN p_from AND p_to),
    'operasional', (SELECT COALESCE(sum(round(amount)),0) FROM public.expenses WHERE category NOT IN ('Gaji','Gaji Karyawan','Pembelian Bahan') AND expense_date BETWEEN p_from AND p_to),

    -- PIUTANG (identik dgn menu Piutang: Σ sisa semua debts, tanpa filter status)
    'piutang_aktif', (SELECT COALESCE(sum(greatest(0, round(total_debt)-round(paid))),0) FROM public.debts),
    'sudah_bayar',   (SELECT COALESCE(sum(round(paid)),0) FROM public.debts),
    'hutang_supplier', (SELECT COALESCE(sum(greatest(0, round(total)-round(paid))),0) FROM public.supplier_debts WHERE status='aktif'),

    -- SALDO KAS & REKENING (kumulatif s/d p_to, dari model yang sama)
    'saldo_kas', (
      (SELECT COALESCE(sum(init_paid),0) FROM txall WHERE payment_method IN ('cash','hutang'))
      + (SELECT COALESCE(sum(round(amount)),0) FROM dpall WHERE payment_method='cash')
      - (SELECT COALESCE(sum(round(amount)),0) FROM public.expenses WHERE method='cash' AND expense_date <= p_to)
      - (SELECT COALESCE(sum(round(amount)),0) FROM public.purchases WHERE method='cash' AND COALESCE(is_credit,false)=false AND purchase_date <= p_to)
    ),
    'saldo_rekening', (
      (SELECT COALESCE(sum(init_paid),0) FROM txall WHERE payment_method IN ('transfer','qris'))
      + (SELECT COALESCE(sum(round(amount)),0) FROM dpall WHERE payment_method IN ('transfer','qris'))
      - (SELECT COALESCE(sum(round(amount)),0) FROM public.expenses WHERE method='transfer' AND expense_date <= p_to)
      - (SELECT COALESCE(sum(round(amount)),0) FROM public.purchases WHERE method='transfer' AND COALESCE(is_credit,false)=false AND purchase_date <= p_to)
    ),

    'modal_barang', (SELECT COALESCE(sum(round(amount)),0) FROM public.purchases WHERE purchase_date BETWEEN p_from AND p_to)
                    + (SELECT COALESCE(sum(round(amount)),0) FROM public.expenses WHERE category='Pembelian Bahan' AND expense_date BETWEEN p_from AND p_to)
  );
$$;
GRANT EXECUTE ON FUNCTION public.acc_dashboard(date, date) TO anon, authenticated;

-- ───────────────── Tombol "Sinkronkan Accounting" ─────────────────
-- Repost ulang seluruh jurnal otomatis (untuk audit) dengan menyentuh kembali
-- baris sumber. Dashboard sendiri sudah live (derive dari tabel POS), ini
-- merapikan accounting_entries/cash_movements bila ada drift lama.
CREATE OR REPLACE FUNCTION public.acc_resync()
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.transactions SET total = total WHERE TRUE;
  BEGIN UPDATE public.expenses  SET amount = amount WHERE TRUE; EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN UPDATE public.purchases SET amount = amount WHERE TRUE; EXCEPTION WHEN OTHERS THEN NULL; END;
  -- Rekalkulasi sisa hutang supplier
  BEGIN UPDATE public.supplier_debts SET total = total WHERE TRUE; EXCEPTION WHEN OTHERS THEN NULL; END;
  RETURN json_build_object('ok', true);
EXCEPTION WHEN OTHERS THEN
  RETURN json_build_object('ok', false, 'error', SQLERRM);
END; $$;
GRANT EXECUTE ON FUNCTION public.acc_resync() TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
