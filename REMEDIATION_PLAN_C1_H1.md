# RENCANA PERBAIKAN — Keputusan & Plan

Status keputusan owner (audit follow-up):
- **H1 (multi-book accounting): DIBATALKAN.** Accounting tetap GLOBAL (gabungan
  semua book). Hanya Omset/Customer/Piutang yang per-book. Biaya bersama (sewa,
  gaji) tetap global. → Tidak ada perubahan `acc_dashboard`. Risiko nol.
  - Konsekuensi: temuan **M2** (Dashboard Owner Laba pakai omset global) menjadi
    **bukan bug** — memang konsisten dengan keputusan "accounting global".
  - **M1** (Credibook "Total Pengeluaran" global) tetap berlaku & memang sesuai
    desain; label "semua book" sudah ada di kartu.
- **C1 (keamanan): rencanakan Tahap 2 — Supabase Auth + RLS per peran** (plan
  saja, belum dieksekusi; perlu jadwal & QA penuh).

---

## C1 — RENCANA TAHAP 2: Supabase Auth + RLS per peran

Sasaran: hentikan akses bebas via anon key. Setiap user login sebagai identitas
Supabase Auth; database menegakkan peran (owner/admin/kasir) lewat RLS — bukan
hanya React.

### A. Skema & data
1. Aktifkan **Supabase Auth** (Email atau Phone). Untuk login berbasis username
   yang ada sekarang: petakan `username@skupy.local` → email sintetis, atau
   migrasi ke email asli.
2. Tabel `profiles`:
   ```sql
   create table public.profiles (
     user_id uuid primary key references auth.users(id) on delete cascade,
     admin_id uuid,              -- link ke baris admins lama (opsional)
     role text not null default 'kasir',  -- owner|admin|kasir
     created_at timestamptz default now()
   );
   ```
3. Helper peran (dipakai semua policy):
   ```sql
   create or replace function public.current_role() returns text
   language sql stable security definer as $$
     select role from public.profiles where user_id = auth.uid()
   $$;
   ```
4. Migrasi user lama: untuk tiap baris `admins`, buat `auth.users` + `profiles`
   (role disalin). Simpan mapping `profiles.admin_id`.

### B. RLS per tabel (ganti `USING(true)`)
Pola umum (contoh `transactions`):
```sql
alter table public.transactions enable row level security;
drop policy if exists "anon all transactions" on public.transactions;

-- Baca: owner & admin semua; kasir hanya book yang ditugaskan (admin_book_access)
create policy trx_select on public.transactions for select using (
  public.current_role() in ('owner','admin')
  or exists (select 1 from public.admin_book_access a
             where a.admin_id = (select admin_id from public.profiles where user_id=auth.uid())
               and a.book_id = transactions.book_id)
);
-- Tulis: owner/admin bebas; kasir hanya INSERT (checkout) untuk book-nya
create policy trx_insert on public.transactions for insert with check (
  public.current_role() in ('owner','admin','kasir')
);
-- Hapus/Update sensitif: owner saja (atau admin terbatas)
create policy trx_update on public.transactions for update using (
  public.current_role() in ('owner','admin')
);
create policy trx_delete on public.transactions for delete using (
  public.current_role() = 'owner'
);
```
Terapkan pola serupa:
- **Accounting (expenses, purchases, supplier_debts, bank_loans, kasbon, assets,
  prepaid_rents, migration_details, acc_dashboard RPC):** SELECT/INSERT/UPDATE/
  DELETE hanya `owner` (admin opsional). Kasir: **tanpa akses**.
- **credibook_income, debts, debt_payments:** owner/admin penuh; kasir sesuai book.
- **customers, products:** owner/admin tulis; kasir baca + insert customer.
- **settings, admins, profiles, master data, bank accounts:** owner saja.
- **acc_dashboard / RPC sensitif:** `REVOKE EXECUTE ... FROM anon;`
  `GRANT EXECUTE ... TO authenticated;` + cek `current_role()='owner'` di dalam,
  atau bungkus dengan wrapper yang menolak non-owner.

### C. Perubahan frontend (terukur, bukan refactor besar)
1. `src/lib/supabase.js`: tetap createClient, tapi tambahkan alur
   `supabase.auth.signInWithPassword(...)` di `login()` (`useStore`).
2. `loadSession()` → pakai `supabase.auth.getSession()` + listener
   `onAuthStateChange`. Peran diambil dari `profiles`.
3. Semua query yang sekarang anon otomatis berjalan sebagai user terautentikasi
   (header JWT dikirim Supabase client). Tidak perlu ubah query satu-satu.
4. Gating UI yang ada tetap dipertahankan sebagai lapisan UX (defense in depth).

### D. Rollout aman
1. Buat policy baru **berdampingan** (mode shadow) di staging.
2. Migrasi user → auth + profiles.
3. Uji tiap peran: owner (full), admin (sesuai book), kasir (hanya kasir/order,
   tidak bisa baca accounting via API).
4. Setelah lolos: `DROP POLICY "anon all ..."` di semua tabel, cabut hak anon.
5. Sediakan akun owner darurat + prosedur reset.

### E. Risiko & mitigasi
- Risiko: salah satu policy terlalu ketat → fitur gagal senyap. Mitigasi: uji
  matriks peran × tabel sebelum mencabut policy lama; simpan rollback.
- Tidak menyentuh rumus akuntansi sama sekali (hanya akses).

### Estimasi langkah eksekusi (saat disetujui)
1. Migrasi `profiles` + helper `current_role()` + seed dari `admins`.
2. Alur `auth.signInWithPassword` di `login()` + session listener.
3. Policy per tabel (batch: penjualan → piutang → accounting → master).
4. Revoke anon + uji peran.
5. Go-live.

> Semua di atas adalah RENCANA. Beri aba-aba bila ingin saya mulai dari langkah 1
> (migrasi `profiles` + helper) — itu langkah paling aman & fondasi untuk sisanya.
