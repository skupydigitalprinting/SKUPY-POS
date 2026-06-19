#!/usr/bin/env bash
# =====================================================================
# clone-app.sh — Duplikat Skupy POS jadi aplikasi baru dengan branding sendiri.
#
# Cara pakai:
#   ./clone-app.sh <slug-kebab> [opsi]
#
# Contoh dasar:
#   ./clone-app.sh tokoku-pos
#
# Contoh lengkap (mengisi semua nama):
#   ./clone-app.sh tokoku-pos \
#     --display "Toko Ku POS" \
#     --short   "TOKOKU" \
#     --shop    "Toko Ku Printing"
#
# Hasil :
#   ../tokoku-pos/      folder baru siap pakai
#
# Yang dilakukan script:
#   1. Copy seluruh folder source (kecuali node_modules, .git, dist, *.zip)
#   2. Replace 'skupy-pos' → slug baru
#   3. Replace 'Skupy POS' → nama display
#   4. Replace 'Skupy Printing' → nama toko default
#   5. Replace 'SKUPY' (wordmark) → short brand
#   6. Reset package-lock + .env supaya project bersih
#   7. Print instruksi langkah selanjutnya
# =====================================================================

set -euo pipefail

# ─── Parse arguments ────────────────────────────────────────────────
if [ $# -lt 1 ] || [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  cat <<EOF
Usage: ./clone-app.sh <slug-kebab> [--display "..."] [--short "..."] [--shop "..."]

Slug harus kebab-case (huruf kecil + tanda hubung), contoh: tokoku-pos

Opsi:
  --display TEXT    Nama display aplikasi.  Default: derived dari slug ("Tokoku Pos")
  --short   TEXT    Wordmark UPPERCASE.     Default: derived dari slug ("TOKOKU")
  --shop    TEXT    Nama toko untuk invoice. Default: "<Display> Printing"

Contoh:
  ./clone-app.sh tokoku-pos
  ./clone-app.sh tokoku-pos --display "Toko Ku POS" --short "TOKOKU"
EOF
  exit 1
fi

SLUG="$1"
shift || true

# Validasi slug — harus kebab-case
if ! echo "$SLUG" | grep -Eq '^[a-z][a-z0-9-]*$'; then
  echo "ERROR: slug harus kebab-case (huruf kecil + tanda hubung)."
  echo "Contoh yang benar: tokoku-pos, kasir-warung, retail-app"
  echo "Anda mengisi:     $SLUG"
  exit 1
fi

# ─── Derive defaults dari slug ──────────────────────────────────────
# tokoku-pos → "Tokoku Pos"
default_display() {
  echo "$1" | awk -F'-' '{
    for (i=1; i<=NF; i++) {
      $i = toupper(substr($i, 1, 1)) substr($i, 2)
    }
    print
  }' OFS=" "
}

# tokoku-pos → "TOKOKU" (ambil bagian pertama)
default_short() {
  echo "$1" | awk -F'-' '{ print toupper($1) }'
}

# tokoku-pos → "tokoku" (lowercase, untuk session key + email default)
default_lower() {
  echo "$1" | awk -F'-' '{ print tolower($1) }'
}

DISPLAY=""
SHORT=""
SHOP=""

while [ $# -gt 0 ]; do
  case "$1" in
    --display) DISPLAY="$2"; shift 2 ;;
    --short)   SHORT="$2";   shift 2 ;;
    --shop)    SHOP="$2";    shift 2 ;;
    *) echo "ERROR: opsi tidak dikenal: $1"; exit 1 ;;
  esac
done

[ -z "$DISPLAY" ] && DISPLAY="$(default_display "$SLUG")"
[ -z "$SHORT" ]   && SHORT="$(default_short "$SLUG")"
[ -z "$SHOP" ]    && SHOP="$DISPLAY Printing"

# Title-cased nama (untuk teks selain wordmark): ambil kata pertama dari display
TITLE_BRAND="$(echo "$DISPLAY" | awk '{ print $1 }')"

# Lowercase brand (untuk session key dan email default — biar tidak bentrok
# antara dua aplikasi yang dijalankan di domain/localhost yang sama)
LOWER_BRAND="$(default_lower "$SLUG")"

# ─── Path setup ─────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$SCRIPT_DIR"
DEST_DIR="$(cd "$SCRIPT_DIR/.." && pwd)/$SLUG"

if [ -e "$DEST_DIR" ]; then
  echo "ERROR: folder $DEST_DIR sudah ada. Hapus dulu atau pilih nama lain."
  exit 1
fi

# ─── Summary sebelum copy ───────────────────────────────────────────
cat <<EOF

╭─ Clone Skupy POS ─────────────────────────────────────────────────
│  Slug         : $SLUG
│  Display      : $DISPLAY
│  Wordmark     : $SHORT
│  Nama toko    : $SHOP
│  Lowercase    : $LOWER_BRAND  (untuk session key + email)
│  Source       : $SRC_DIR
│  Destination  : $DEST_DIR
╰────────────────────────────────────────────────────────────────────

EOF

# ─── 1. Copy folder ─────────────────────────────────────────────────
echo "→ Copy source ke $DEST_DIR (excluding node_modules, .git, dist, zips)..."
mkdir -p "$DEST_DIR"

# Gunakan rsync kalau ada (lebih cepat + exclude lebih bersih), fallback ke cp
if command -v rsync >/dev/null 2>&1; then
  rsync -a \
    --exclude='node_modules/' \
    --exclude='.git/' \
    --exclude='dist/' \
    --exclude='*.zip' \
    --exclude='.DS_Store' \
    --exclude='.npm/' \
    --exclude='clone-app.sh' \
    "$SRC_DIR"/ "$DEST_DIR"/
else
  cp -R "$SRC_DIR"/. "$DEST_DIR"/
  ( cd "$DEST_DIR" && rm -rf node_modules .git dist .DS_Store .npm clone-app.sh *.zip 2>/dev/null || true )
fi

# ─── 2. sed wrapper (cross-platform macOS + Linux) ──────────────────
# BSD sed (macOS) butuh "-i ''" sementara GNU sed (Linux) "-i" tanpa ''.
sed_in_place() {
  local pattern="$1"
  local file="$2"
  if [ "$(uname)" = "Darwin" ]; then
    sed -i '' -e "$pattern" "$file"
  else
    sed -i -e "$pattern" "$file"
  fi
}

# Walk files yang perlu di-edit dan jalankan replace untuk semua pattern.
edit_files() {
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    # Skip binary files dan node_modules just in case
    case "$f" in
      */node_modules/*|*.zip|*.png|*.jpg|*.ico) continue ;;
    esac
    [ -f "$f" ] || continue
    # Urutan REPLACE — yang lebih panjang dulu agar tidak saling tumpa.
    sed_in_place "s|Skupy Printing|${SHOP}|g" "$f"
    sed_in_place "s|Skupy POS|${DISPLAY}|g" "$f"
    sed_in_place "s|skupy-pos|${SLUG}|g" "$f"
    sed_in_place "s|SKUPY|${SHORT}|g" "$f"
    # 'Skupy' (mixed-case lain) jadi titlecase pertama dari DISPLAY.
    sed_in_place "s|Skupy|${TITLE_BRAND}|g" "$f"
    # 'skupy' lowercase (session key, email default) — lakukan paling terakhir
    # supaya pola di atas tidak tertukar. Tidak akan double-replace karena
    # 'skupy-pos' sudah ditangani sebelum ini.
    sed_in_place "s|skupy|${LOWER_BRAND}|g" "$f"
  done
}

# ─── 3. Replace di semua file teks ──────────────────────────────────
echo "→ Replace string branding..."
cd "$DEST_DIR"

# Cari file teks yang relevan (extensi yang dipakai project)
find . -type f \( \
  -name "*.js" -o \
  -name "*.jsx" -o \
  -name "*.ts" -o \
  -name "*.tsx" -o \
  -name "*.json" -o \
  -name "*.md" -o \
  -name "*.html" -o \
  -name "*.css" -o \
  -name "*.sql" -o \
  -name "*.sh" -o \
  -name "*.env*" \
\) -not -path "./node_modules/*" -not -path "./.git/*" | edit_files

# ─── 4. Bersihkan file yang tidak relevan untuk project baru ────────
echo "→ Bersihkan artefak lama (package-lock, .env, dll)..."
rm -f package-lock.json yarn.lock pnpm-lock.yaml
rm -f .env  # user akan buat baru dari .env.example
rm -rf .vercel  # kalau ada Vercel link sebelumnya

# Buat .env baru sebagai template kalau .env.example ada
if [ -f ".env.example" ]; then
  cp .env.example .env.template
  echo "  ✓ Copy .env.example → .env.template (rename ke .env setelah isi)"
fi

# ─── 5. Selesai — print next steps ──────────────────────────────────
cat <<EOF

╭─ Selesai ──────────────────────────────────────────────────────────
│ Folder baru : $DEST_DIR
│
│ Langkah selanjutnya:
│   1. cd $DEST_DIR
│   2. Buat project Supabase baru di https://supabase.com
│   3. Jalankan supabase/schema.sql + semua file di supabase/migrations/
│      di SQL Editor project Supabase baru itu
│   4. Edit .env (atau rename .env.template → .env) dan isi:
│        VITE_SUPABASE_URL=...
│        VITE_SUPABASE_ANON_KEY=...
│   5. npm install
│   6. npm run dev   → buka http://localhost:5173
│   7. Login default: admin / admin (ubah segera dari Settings)
│   8. Buka Settings (gear icon kiri-bawah) untuk:
│        - upload logo
│        - ubah nama toko / alamat / telepon / no rekening
│        - tambah admin lain
│
│ Tip: kalau ada bug fix di Skupy POS source, jalankan diff manual
│      atau pakai git fork untuk sinkronisasi berkala.
╰────────────────────────────────────────────────────────────────────

EOF
