-- ═══════════════════════════════════════════════════════════════════
-- CUSTOMERS: kepemilikan per kasir (created_by) untuk hak akses tampilan.
-- Idempotent. Tidak mengubah data lama; kolom baru nullable.
--
-- Aturan akses (diterapkan di aplikasi):
--   • Staff Kasir → hanya melihat customer dengan created_by = id-nya.
--   • Staff Admin & Owner → melihat semua customer.
--   • Customer lama (created_by NULL) → tampil ke Owner/Admin, TIDAK ke kasir.
-- Catatan: auth aplikasi memakai tabel admins (anon key), bukan Supabase Auth,
-- sehingga RLS tidak bisa membedakan kasir — filter dilakukan di sisi aplikasi
-- (pola sama dengan scoping transaksi/piutang per kasir yang sudah ada).
-- ═══════════════════════════════════════════════════════════════════
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS created_by      uuid;
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS created_by_name text;
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS created_by_role text;
CREATE INDEX IF NOT EXISTS idx_customers_created_by ON public.customers (created_by);

NOTIFY pgrst, 'reload schema';
