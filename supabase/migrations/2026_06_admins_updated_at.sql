-- ═══════════════════════════════════════════════════════════════════
-- ADMINS: kolom updated_at untuk fitur Edit Admin (username/nama/role/password)
-- Idempotent. Tabel admins sudah punya: id, username, password, name, role,
-- created_at. Hanya menambahkan updated_at.
-- ═══════════════════════════════════════════════════════════════════
ALTER TABLE public.admins ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

NOTIFY pgrst, 'reload schema';
