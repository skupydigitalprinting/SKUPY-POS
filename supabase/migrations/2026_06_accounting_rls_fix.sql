-- ═══════════════════════════════════════════════════════════════════
-- FIX: "permission denied for table accounting_entries" saat checkout
-- ═══════════════════════════════════════════════════════════════════
-- Penyebab: trigger auto-jurnal berjalan dengan hak user pemanggil (anon),
-- yang TIDAK punya privilege INSERT ke accounting_entries → seluruh INSERT
-- transaksi POS ikut rollback → checkout gagal.
--
-- Solusi:
--   (A) Trigger function dibuat SECURITY DEFINER → berjalan sebagai pemilik
--       fungsi (postgres), jadi bisa menulis jurnal tanpa peduli role kasir.
--   (B) Setiap fungsi dibungkus EXCEPTION handler → kalau ada error apa pun
--       di akuntansi, hanya RAISE WARNING dan transaksi POS TETAP berhasil
--       (akuntansi best-effort, checkout tidak pernah gagal karenanya).
--   (C) GRANT privilege tabel akuntansi ke anon/authenticated untuk halaman
--       Accounting (baca laporan + input expense/purchase/supplier).
--
-- Catatan akses peran: aplikasi memakai SATU anon key (tanpa Supabase Auth
-- per-user), jadi DB tidak bisa membedakan owner/staff/kasir. Pembatasan
-- peran (kasir tidak boleh buka menu Accounting) DITERAPKAN DI APLIKASI
-- (sidebar + gating route). Auto-posting jurnal dari checkout tetap jalan
-- untuk semua peran lewat SECURITY DEFINER.
--
-- Idempotent. Jalankan SETELAH 2026_06_accounting_module.sql &
-- 2026_06_accounting_suppliers.sql. Supabase → SQL Editor → Run.
-- ═══════════════════════════════════════════════════════════════════

-- ───────────────── (A)+(B) Recreate trigger functions ─────────────────

CREATE OR REPLACE FUNCTION public.acc_fn_post_transaction()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_total numeric; v_paid numeric; v_rem numeric; v_cash text; v_date date;
BEGIN
  IF (TG_OP = 'DELETE') THEN
    DELETE FROM public.accounting_entries WHERE source_type='sale' AND source_id=OLD.id;
    DELETE FROM public.cash_movements     WHERE source_type='sale' AND source_id=OLD.id;
    RETURN OLD;
  END IF;
  DELETE FROM public.accounting_entries WHERE source_type='sale' AND source_id=NEW.id;
  DELETE FROM public.cash_movements     WHERE source_type='sale' AND source_id=NEW.id;
  IF (COALESCE(NEW.order_status,'') = 'dibatalkan') THEN RETURN NEW; END IF;
  v_total := round(COALESCE(NEW.total,0));
  v_paid  := round(COALESCE(NEW.paid,0));
  v_rem   := greatest(0, v_total - v_paid);
  v_cash  := public.acc_cash_code(NEW.payment_method);
  v_date  := COALESCE(NEW.created_at::date, now()::date);
  IF v_total <= 0 THEN RETURN NEW; END IF;
  INSERT INTO public.accounting_entries(entry_date,source_type,source_id,invoice_no,account_code,debit,credit,description,cashier_id)
  VALUES (v_date,'sale',NEW.id,NEW.invoice_no,'4000',0,v_total,'Penjualan '||COALESCE(NEW.invoice_no,''),NEW.cashier_id);
  IF v_paid > 0 THEN
    INSERT INTO public.accounting_entries(entry_date,source_type,source_id,invoice_no,account_code,debit,credit,description,cashier_id)
    VALUES (v_date,'sale',NEW.id,NEW.invoice_no,v_cash,v_paid,0,'Penerimaan penjualan',NEW.cashier_id);
    INSERT INTO public.cash_movements(moved_at,direction,method,amount,source_type,source_id,invoice_no,note,cashier_id)
    VALUES (COALESCE(NEW.created_at,now()),'in',COALESCE(NEW.payment_method,'cash'),v_paid,'sale',NEW.id,NEW.invoice_no,'Penjualan',NEW.cashier_id);
  END IF;
  IF v_rem > 0 THEN
    INSERT INTO public.accounting_entries(entry_date,source_type,source_id,invoice_no,account_code,debit,credit,description,cashier_id)
    VALUES (v_date,'sale',NEW.id,NEW.invoice_no,'1200',v_rem,0,'Piutang penjualan',NEW.cashier_id);
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'acc_fn_post_transaction dilewati: %', SQLERRM;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END; $$;

CREATE OR REPLACE FUNCTION public.acc_fn_post_expense()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_amt numeric; v_cash text;
BEGIN
  IF (TG_OP='DELETE') THEN
    DELETE FROM public.accounting_entries WHERE source_type='expense' AND source_id=OLD.id;
    DELETE FROM public.cash_movements     WHERE source_type='expense' AND source_id=OLD.id;
    RETURN OLD;
  END IF;
  DELETE FROM public.accounting_entries WHERE source_type='expense' AND source_id=NEW.id;
  DELETE FROM public.cash_movements     WHERE source_type='expense' AND source_id=NEW.id;
  v_amt := round(COALESCE(NEW.amount,0));
  v_cash := public.acc_cash_code(NEW.method);
  IF v_amt <= 0 THEN RETURN NEW; END IF;
  INSERT INTO public.accounting_entries(entry_date,source_type,source_id,account_code,debit,credit,description,cashier_id)
  VALUES (NEW.expense_date,'expense',NEW.id,'6000',v_amt,0,COALESCE(NEW.category,'Beban')||' '||COALESCE(NEW.note,''),NEW.cashier_id);
  INSERT INTO public.accounting_entries(entry_date,source_type,source_id,account_code,debit,credit,description,cashier_id)
  VALUES (NEW.expense_date,'expense',NEW.id,v_cash,0,v_amt,'Pembayaran beban',NEW.cashier_id);
  INSERT INTO public.cash_movements(moved_at,direction,method,amount,source_type,source_id,note,cashier_id)
  VALUES (NEW.expense_date,'out',COALESCE(NEW.method,'cash'),v_amt,'expense',NEW.id,COALESCE(NEW.category,'Beban'),NEW.cashier_id);
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'acc_fn_post_expense dilewati: %', SQLERRM;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END; $$;

CREATE OR REPLACE FUNCTION public.acc_fn_post_purchase()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_amt numeric; v_cash text;
BEGIN
  IF (TG_OP='DELETE') THEN
    DELETE FROM public.accounting_entries WHERE source_type='purchase' AND source_id=OLD.id;
    DELETE FROM public.cash_movements     WHERE source_type='purchase' AND source_id=OLD.id;
    RETURN OLD;
  END IF;
  DELETE FROM public.accounting_entries WHERE source_type='purchase' AND source_id=NEW.id;
  DELETE FROM public.cash_movements     WHERE source_type='purchase' AND source_id=NEW.id;
  v_amt := round(COALESCE(NEW.amount,0));
  v_cash := public.acc_cash_code(NEW.method);
  IF v_amt <= 0 THEN RETURN NEW; END IF;
  INSERT INTO public.accounting_entries(entry_date,source_type,source_id,account_code,debit,credit,description)
  VALUES (NEW.purchase_date,'purchase',NEW.id,'1300',v_amt,0,'Pembelian '||COALESCE(NEW.item,''));
  IF COALESCE(NEW.is_credit,false) THEN
    INSERT INTO public.accounting_entries(entry_date,source_type,source_id,account_code,debit,credit,description)
    VALUES (NEW.purchase_date,'purchase',NEW.id,'2000',0,v_amt,'Pembelian kredit '||COALESCE(NEW.supplier,''));
  ELSE
    INSERT INTO public.accounting_entries(entry_date,source_type,source_id,account_code,debit,credit,description)
    VALUES (NEW.purchase_date,'purchase',NEW.id,v_cash,0,v_amt,'Pembayaran pembelian');
    INSERT INTO public.cash_movements(moved_at,direction,method,amount,source_type,source_id,note)
    VALUES (NEW.purchase_date,'out',COALESCE(NEW.method,'cash'),v_amt,'purchase',NEW.id,COALESCE(NEW.item,'Pembelian'));
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'acc_fn_post_purchase dilewati: %', SQLERRM;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END; $$;

-- Supplier debt & supplier payment:
-- DEFINISI FUNGSI LAMA DIHAPUS DARI FILE INI (sebelumnya logika increment
-- `paid = paid + amount` tanpa cek deleted_at). Kalau file ini dijalankan
-- ulang SETELAH 2026_06_accounting_history_softdelete.sql, fungsi lama
-- menimpa versi baru sementara trigger tetap menyala di UPDATE → edit /
-- soft-delete pembayaran membuat `paid` dobel dan jurnal ganda.
-- Versi final fungsi + trigger ada di 2026_06_supplier_debt_fixes.sql —
-- jalankan file itu PALING AKHIR.

-- ───────────────── (C) GRANT privilege tabel + RPC ─────────────────
GRANT USAGE ON SCHEMA public TO anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  public.accounts,
  public.accounting_entries,
  public.cash_movements,
  public.expenses,
  public.purchases,
  public.assets,
  public.liabilities,
  public.suppliers,
  public.supplier_debts,
  public.supplier_debt_payments
TO anon, authenticated;

GRANT EXECUTE ON FUNCTION public.acc_summary(date, date)      TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.acc_recap_admin(date, date)  TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.acc_cash_code(text)          TO anon, authenticated;

-- Pastikan RLS aktif + policy "anon all" ada (sefamili dgn tabel POS lain)
ALTER TABLE public.accounting_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cash_movements     ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN CREATE POLICY "anon all accounting_entries" ON public.accounting_entries FOR ALL USING (true) WITH CHECK (true); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY "anon all cash_movements"     ON public.cash_movements     FOR ALL USING (true) WITH CHECK (true); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

NOTIFY pgrst, 'reload schema';
