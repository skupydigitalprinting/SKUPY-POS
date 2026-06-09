-- ═══════════════════════════════════════════════════════════════════
-- SUPPLIER DEBT FIXES — konsolidasi trigger Hutang Supplier (VERSI FINAL)
-- Jalankan PALING AKHIR setelah semua migrasi accounting lain.
-- Idempotent — aman dijalankan berulang kali.
--
-- Memperbaiki:
--   1. Versi lama acc_fn_post_supplier_payment (logika increment
--      `paid = paid + amount`, tanpa cek deleted_at) yang dulu ada di
--      2026_06_accounting_rls_fix.sql bisa menimpa versi baru. Dengan
--      trigger AFTER INSERT OR UPDATE OR DELETE, edit / soft-delete
--      pembayaran malah MENAMBAH paid (dobel) dan mem-posting ulang
--      jurnal. File ini memasang ulang versi benar: paid dihitung
--      ulang dari SUM pembayaran non-deleted (idempotent).
--   2. deleteSupplierDebt di frontend tidak atomik (2 request).
--      → RPC acc_delete_supplier_debt: soft-delete hutang + seluruh
--      pembayarannya dalam SATU transaksi database.
-- ═══════════════════════════════════════════════════════════════════

-- Pastikan kolom yang dibutuhkan ada (no-op kalau sudah).
ALTER TABLE public.supplier_debt_payments ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE public.supplier_debt_payments ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();
ALTER TABLE public.supplier_debts ADD COLUMN IF NOT EXISTS deleted_at     timestamptz;
ALTER TABLE public.supplier_debts ADD COLUMN IF NOT EXISTS payment_method text DEFAULT 'transfer';
ALTER TABLE public.supplier_debts ADD COLUMN IF NOT EXISTS updated_at     timestamptz DEFAULT now();

-- ═══════ SUPPLIER DEBT (akrual: Dr Persediaan 1300 / Cr Hutang 2000) ═══════
-- Soft-deleted debt → jurnal dihapus & tidak dihitung.
CREATE OR REPLACE FUNCTION public.acc_fn_post_supplier_debt()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_total numeric;
BEGIN
  IF (TG_OP='DELETE') THEN
    DELETE FROM public.accounting_entries WHERE source_type='supplier_debt' AND source_id=OLD.id;
    RETURN OLD;
  END IF;
  NEW.remaining := greatest(0, round(coalesce(NEW.total,0)) - round(coalesce(NEW.paid,0)));
  NEW.status := CASE WHEN NEW.remaining <= 0 THEN 'lunas' ELSE 'aktif' END;
  BEGIN
    DELETE FROM public.accounting_entries WHERE source_type='supplier_debt' AND source_id=NEW.id;
    v_total := round(coalesce(NEW.total,0));
    IF v_total > 0 AND NEW.deleted_at IS NULL THEN
      INSERT INTO public.accounting_entries(entry_date,source_type,source_id,account_code,debit,credit,description)
      VALUES (coalesce(NEW.created_at::date, now()::date),'supplier_debt',NEW.id,'1300',v_total,0,'Pembelian kredit '||coalesce(NEW.supplier,''));
      INSERT INTO public.accounting_entries(entry_date,source_type,source_id,account_code,debit,credit,description)
      VALUES (coalesce(NEW.created_at::date, now()::date),'supplier_debt',NEW.id,'2000',0,v_total,'Hutang ke '||coalesce(NEW.supplier,''));
    END IF;
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'supplier_debt journal: %', SQLERRM; END;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS acc_trg_supplier_debt ON public.supplier_debts;
CREATE TRIGGER acc_trg_supplier_debt
BEFORE INSERT OR UPDATE OF total, paid, deleted_at OR DELETE ON public.supplier_debts
FOR EACH ROW EXECUTE FUNCTION public.acc_fn_post_supplier_debt();

-- ═══════ SUPPLIER PAYMENT (recompute paid dari SUM — idempotent) ═══════
CREATE OR REPLACE FUNCTION public.acc_fn_post_supplier_payment()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_amt numeric; v_cash text; v_debt uuid; v_pid uuid;
BEGIN
  v_pid  := COALESCE(NEW.id, OLD.id);
  v_debt := COALESCE(NEW.supplier_debt_id, OLD.supplier_debt_id);
  -- bersihkan jurnal lama untuk payment ini
  DELETE FROM public.accounting_entries WHERE source_type='supplier_payment' AND source_id=v_pid;
  DELETE FROM public.cash_movements     WHERE source_type='supplier_payment' AND source_id=v_pid;
  -- repost hanya kalau aktif (bukan delete, bukan soft-deleted)
  IF (TG_OP <> 'DELETE') AND NEW.deleted_at IS NULL THEN
    v_amt := round(coalesce(NEW.amount,0));
    v_cash := public.acc_cash_code(NEW.method);
    IF v_amt > 0 THEN
      INSERT INTO public.accounting_entries(entry_date,source_type,source_id,account_code,debit,credit,description,cashier_id)
      VALUES (NEW.paid_at::date,'supplier_payment',NEW.id,'2000',v_amt,0,'Bayar hutang supplier',NEW.cashier_id);
      INSERT INTO public.accounting_entries(entry_date,source_type,source_id,account_code,debit,credit,description,cashier_id)
      VALUES (NEW.paid_at::date,'supplier_payment',NEW.id,v_cash,0,v_amt,'Kas/Bank keluar (hutang supplier)',NEW.cashier_id);
      INSERT INTO public.cash_movements(moved_at,direction,method,amount,source_type,source_id,note,cashier_id)
      VALUES (NEW.paid_at,'out',coalesce(NEW.method,'transfer'),v_amt,'supplier_payment',NEW.id,'Bayar hutang supplier',NEW.cashier_id);
    END IF;
  END IF;
  -- recompute paid parent dari SUM payment non-deleted
  UPDATE public.supplier_debts
    SET paid = (SELECT COALESCE(sum(round(amount)),0) FROM public.supplier_debt_payments WHERE supplier_debt_id=v_debt AND deleted_at IS NULL)
    WHERE id = v_debt;
  RETURN COALESCE(NEW, OLD);
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'supplier_payment: %', SQLERRM;
  RETURN COALESCE(NEW, OLD);
END; $$;

DROP TRIGGER IF EXISTS acc_trg_supplier_payment ON public.supplier_debt_payments;
CREATE TRIGGER acc_trg_supplier_payment
AFTER INSERT OR UPDATE OR DELETE ON public.supplier_debt_payments
FOR EACH ROW EXECUTE FUNCTION public.acc_fn_post_supplier_payment();

-- ═══════ RPC: hapus hutang supplier secara ATOMIK (1 transaksi) ═══════
-- Soft-delete semua pembayaran + hutangnya sekaligus. Trigger payment
-- ikut membersihkan jurnal & cash movement per baris; trigger debt
-- membuang jurnal akrualnya. Kalau salah satu gagal → semua rollback.
CREATE OR REPLACE FUNCTION public.acc_delete_supplier_debt(p_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_now timestamptz := now();
BEGIN
  UPDATE public.supplier_debt_payments
    SET deleted_at = v_now
    WHERE supplier_debt_id = p_id AND deleted_at IS NULL;
  UPDATE public.supplier_debts
    SET deleted_at = v_now
    WHERE id = p_id AND deleted_at IS NULL;
END; $$;

GRANT EXECUTE ON FUNCTION public.acc_delete_supplier_debt(uuid) TO anon, authenticated;

-- Resync saldo paid semua hutang dari SUM pembayaran non-deleted
-- (membetulkan data yang sempat dobel akibat trigger versi lama).
UPDATE public.supplier_debts d
SET paid = COALESCE((
  SELECT sum(round(p.amount)) FROM public.supplier_debt_payments p
  WHERE p.supplier_debt_id = d.id AND p.deleted_at IS NULL
), 0);

NOTIFY pgrst, 'reload schema';
