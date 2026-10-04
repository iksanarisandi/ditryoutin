# Tryout UPKP

Platform tryout berbayar untuk persiapan **UPKP Imipas** (Kementerian Imigrasi dan Pemasyarakatan). Dibangun sesuai PRD: ringan, murah dijalankan, tanpa framework frontend.

**Live:** https://ditryout.in

## Stack

| Lapisan | Teknologi |
|---|---|
| Runtime | Cloudflare Workers (Hono) |
| Database | Cloudflare D1 (SQLite) + raw SQL, tanpa ORM |
| Auth | Cookie session (HttpOnly), hash password **Argon2id** (@noble/hashes, JS murni) |
| Pembayaran | Pakasir API v2 (QRIS) — atau mode manual: QRIS pribadi + verifikasi admin via WA |
| Frontend | HTML + CSS + vanilla JS (static assets via Workers Assets) |

## Setup Lokal

```bash
npm install
cp .dev.vars.example .dev.vars   # lalu isi nilainya (lihat bawah)
npm run db:local                 # terapkan migrasi D1 lokal
npm run seed:local               # (opsional) paket demo 10 soal
npm run dev                      # http://localhost:8787
```

### Variabel environment (`.dev.vars` lokal / `wrangler secret` produksi)

| Nama | Wajib | Keterangan |
|---|---|---|
| `SESSION_SECRET` | ✅ | Kunci HMAC untuk hash token session di DB. String acak ≥ 32 karakter. |
| `PAKASIR_API_KEY` | ✅ (mode pakasir) | API key dari dashboard Pakasir. |
| `PAKASIR_PROJECT` | ✅ (mode pakasir) | Slug project Pakasir (`ditryoutin`). |
| `PAKASIR_WEBHOOK_SECRET` | ✅ (mode pakasir) | Secret webhook dari detail project Pakasir. Dipakai untuk verifikasi header `X-Secret`. |
| `SETUP_SECRET` | ⬜ (disarankan produksi) | Mengunci halaman `/setup` (bootstrap admin pertama). |
| `TURNSTILE_SITE_KEY` | ⬜ (disarankan produksi) | Site key Cloudflare Turnstile untuk captcha register/login (publik, boleh di frontend). |
| `TURNSTILE_SECRET_KEY` | ⬜ (disarankan produksi) | Secret key Turnstile — verifikasi token di server. Aktif hanya jika site key juga terisi. |

Dua var non-rahasia diatur langsung di `wrangler.jsonc` → `vars`:

| Nama | Keterangan |
|---|---|
| `PAYMENT_MODE` | `pakasir` = gateway otomatis (mode produksi, aktif); `manual` = QRIS pribadi + konfirmasi WA (fallback bila gateway bermasalah). |
| `SHOW_MANUAL_PAYMENT` | `true` = tampilkan tombol **Bayar Manual** di halaman bayar (`method='manual'` di `POST /api/payments/create` ditolak server selain `true`, kecuali `PAYMENT_MODE=manual`). Default `false` — disembunyikan. |
| `MANUAL_WA` | Nomor WA admin (format internasional tanpa `+`, mis. `6282347303153`). Dipakai untuk konfirmasi pembayaran manual **dan** tombol "Kendala pembayaran?" di halaman bayar gateway (`support_wa`). |

> **Jangan pernah** menaruh nilai rahasia di kode, wrangler.jsonc, atau file yang di-commit. Semua rahasia hanya hidup di `.dev.vars` (sudah di-gitignore) dan Cloudflare secrets.

## Deploy

```bash
# 1. set secret produksi
wrangler secret put SESSION_SECRET        # string acak ≥32 char
wrangler secret put PAKASIR_API_KEY
wrangler secret put PAKASIR_PROJECT       # ditryoutin
wrangler secret put PAKASIR_WEBHOOK_SECRET # X-Secret dari detail project Pakasir
wrangler secret put SETUP_SECRET          # acak, dipakai sekali untuk /setup
wrangler secret put TURNSTILE_SITE_KEY     # opsional: captcha register/login
wrangler secret put TURNSTILE_SECRET_KEY   # opsional: pasangan site key

# 2. migrasi database produksi
npm run db:remote

# 3. buat bucket R2 materi (sekali, sebelum deploy pertama dengan fitur materi)
npx wrangler r2 bucket create tryout-upkp-materi

# 4. deploy
npm run deploy

# 5. bootstrap admin (sekali)
#    buka https://ditryout.in/setup
#    isi SETUP_SECRET + email/password admin.
#    Halaman ini mati permanen setelah admin pertama dibuat.
```

### Konfigurasi webhook Pakasir (setelah deploy)

1. Buka detail project di dashboard Pakasir → salin **Webhook Secret**.
2. `wrangler secret put PAKASIR_WEBHOOK_SECRET` dengan nilai tersebut.
3. Set URL webhook di dashboard Pakasir ke:
   `https://ditryout.in/api/payments/webhook`
   (Hati-hati **double slash** `//api/...` — router tidak mencocokkannya sehingga webhook 404 mentah. Worker kini menormalisasi path `//…` sebagai toleransi, tapi tetap gunakan URL bersih di dashboard.)

Tanpa webhook, pembayaran tetap tuntas lewat **polling** (`GET /api/payments/:id` mengecek status ke Pakasir dengan throttle 4,5 detik/transaksi/isolat) — webhook hanya membuatnya lebih cepat dan andal. Tambahan jaring pengaman: **cron harian** merekonsiliasi semua payment pending ber-transaksi ke API Pakasir (maks 50 tertua/run), sehingga user yang membayar lalu menutup aplikasi tanpa kembali tetap mendapat aksesnya paling lambat sehari.

## Mode pembayaran manual (fallback bila gateway bermasalah)

Gateway Pakasir sudah **produksi** — tombol utama halaman bayar adalah **Bayar via QRIS** (otomatis). Alur manual disembunyikan secara default dan bisa diaktifkan dua cara:

- **Per-transaksi**: set `SHOW_MANUAL_PAYMENT=true` di `wrangler.jsonc` → tombol **Bayar Manual** tampil kembali di tiap kartu paket (server juga menerima `method='manual'` lagi).
- **Global**: `PAYMENT_MODE=manual` memaksa semua transaksi ke alur manual (tombol manual otomatis tampil).

Alur manual saat aktif:

1. User memilih produk → sistem membuat referensi (`TO-XXXX`) **tanpa memanggil Pakasir** (`method='manual'`).
2. Halaman pembayaran menampilkan QRIS pribadi (`public/img/qris.jpg`, aset lokal) + nominal tepat + tombol **Konfirmasi via WhatsApp** dengan pesan otomatis berisi referensi & produk.
3. User scan + bayar, lalu klik tombol WA ke admin (`MANUAL_WA` di `wrangler.jsonc`).
4. Admin cek mutasi QRIS → panel **Admin → Transaksi → Tandai Lunas** pada baris pending.
5. Aksi admin menjalankan `settlePayment` idempoten yang sama dengan webhook — akses langsung diperpanjang, transaksi tercatat `paid` dan masuk statistik pendapatan. Halaman user yang terbuka otomatis pindah ke layar sukses (polling 6 detik).

Catatan: payment manual tidak pernah auto-expire — uang bisa saja sudah masuk sebelum admin sempat memverifikasi.

## Skrip npm

| Skrip | Fungsi |
|---|---|
| `npm run dev` | Server pengembangan lokal |
| `npm run deploy` | Deploy ke Cloudflare Workers |
| `npm run typecheck` | Cek tipe TypeScript |
| `npm run db:local` / `db:remote` | Terapkan migrasi D1 lokal/produksi |
| `npm run seed:local` | Seed paket demo 10 soal (hanya lokal) |

## Struktur

```
migrations/          Skema D1 (0001 tabel, 0002 index, 0003 seed produk+kategori)
scripts/seed-local.sql   Data demo lokal
src/
  index.ts           Assembly app + routing
  routes/            auth, setup, packages, attempts, results, payments, materials, admin/*
  services/          pakasir, scoring, payments, importer
  middleware/        auth (session), security (CSRF origin guard)
  utils/             hash (argon2id), session, validate, response
public/              Frontend vanilla (css/, js/, *.html, admin/*.html)
```

## Format import soal (JSON)

Upload lewat panel admin → **Import JSON**. Contoh:

```json
{
  "title": "UPKP Imipas Paket 2",
  "category": "UPKP",
  "questions": [
    {
      "question": "Pancasila adalah ...",
      "options": { "A": "...", "B": "...", "C": "...", "D": "...", "E": "..." },
      "answer": "C",
      "category": "TWK",
      "explanation": "Karena ..."
    }
  ]
}
```

Field `category` pada soal opsional (kategori turunan); `answer` harus `A`–`E`. Mode `preview` memvalidasi tanpa menulis; mode `commit` menulis atomik (bisa append atau replace soal lama, soft-delete). Maks 500 soal per import.

## Keputusan teknis penting

- **Anti-cheat ujian:** `correct_answer` & `explanation` tidak pernah dikirim ke browser sebelum attempt disubmit. Skor dihitung 100% di server; frontend tidak pernah dipercaya.
- **Skor poin (migrasi 0004):** jawaban benar = 5 poin, salah/kosong = 0. Skor total & per kategori dalam poin; maksimum = jumlah soal × 5 (bukan lagi persen 0-100). Passing grade punya dua mode: aturan per kategori (prioritas, semua yang terisi harus terpenuhi) atau `passing_grade_total` paket (dipakai hanya jika tidak ada aturan kategori); keduanya kosong → hasil tanpa status kelulusan.
- **Snapshot skor:** `is_correct` dibekukan saat submit — edit soal setelahnya tidak mengubah hasil lama.
- **Waktu:** semua timestamp DB memakai ISO-8601 UTC (`toISOString()`); UI menampilkan WITA (`Asia/Makassar`). Penjumlahan durasi dihitung di JS, bukan fungsi datetime SQLite.
- **Session:** token acak 256-bit dikirim via cookie HttpOnly; DB menyimpan HMAC-SHA256(token) sehingga kebocoran DB saja tidak bisa memalsukan session. Login baru menghapus session lama (satu device per akun).
- **Pembayaran idempoten:** settle memakai `UPDATE ... WHERE status!='paid'` bersyarat; webhook ganda tidak menggandakan perpanjangan akses. Webhook juga memverifikasi ulang status ke API Pakasir.
- **Akses berbayar:** perpanjangan dihitung dari `max(sekarang, expiry saat ini)` — bayar duluan saat masih aktif menumpuk, tidak mengganti.
- **Rate limit berlapis via Durable Object (`src/do/ratelimit.ts`):** semua `/api/*` 300/menit per IP; login/lupa-password/setup 12/menit per IP; register 6/menit per IP; endpoint tulis lain 90/menit per user. Counter fixed-window kuat-konsisten per key (satu instance DO per limiter+key). Jika DO error, fail-open (situs tidak mati). CATATAN: binding `ratelimit` bawaan Cloudflare pernah dicoba tapi tidak enforce pada akun ini (selalu success=true) — karena itu dipakai DO. Untuk flood yang lebih besar, tambahkan WAF Rate Limiting rule di dashboard Cloudflare (blokir `contains "/api/auth/"` > 10/menit per IP) — itu menahan serangan SEBELUM menyentuh Worker.
- **Lockout per-akun:** 5 login gagal → akun terkunci 15 menit (dikombinasi dengan rate limit IP agar tidak bisa dipakai mengunci akun orang lain secara massal).
- **Turnstile (captcha) register/login:** aktif otomatis jika `TURNSTILE_SITE_KEY`+`TURNSTILE_SECRET_KEY` terisi; dicek SEBELUM verifikasi argon2 agar request tanpa captcha tidak bisa membakar CPU.
- **Batas ukuran body:** semua body JSON dibatasi 64 KB (`src/utils/body.ts`) — import soal admin 8 MB. Mencegah OOM isolate dari body raksasa.
- **Satu admin maksimal:** partial unique index `users(role) WHERE role='admin'` (migrasi 0005) menutup race setup bersamaan.
- **Bersih-bersih otomatis:** cron harian (03:17 WIB) menghapus session kedaluwarsa, merekonsiliasi payment pending, dan menyapu objek R2 materi yatim (unggah gagal di tengah / delete yang gagal bersih; objek < 1 jam dilewati agar tak bertabrakan dengan unggahan yang sedang berjalan).
- **Materi bacaan PDF:** byte file di R2 (`MATERI_BUCKET`, key `materi/{uuid}.pdf` immutable), metadata di D1 (`material_categories` + `materials`, migrasi 0009). Semua user login boleh membaca (tanpa langganan); admin unggah/hapus lewat `/admin/materials.html`. File di-serve HANYA lewat `GET /api/materials/:id/file` yang cek sesi (aset statis mem-bypass Worker) dengan cache `private` browser-only — cache edge tidak peduli cookie dan akan membocorkan PDF ke anonim. ETag dari (id, ukuran) + dukungan Range. Unggah = satu-satunya endpoint multipart: pre-check Content-Length 26 MB, batas 25 MB/file, validasi magic bytes `%PDF-`; jumlah halaman dihitung pdf.js di klien sebelum unggah. Pembaca `/baca.html` memakai pdf.js v4 legacy yang di-vendor di `public/js/vendor/` (perbarui: `npm i -D pdfjs-dist@<versi>` lalu salin ulang `legacy/build/pdf*.min.mjs`).
- **Batas transaksi pending:** maksimal 5 payment `pending` per user (anti-spam tulis D1).
- **Batas bayar QRIS: 24 jam** sejak transaksi dibuat (`PAKASIR_TTL_MS`). Pakasir tidak mengirim `expired_at` pada transaksinya, jadi aplikasi yang menjamin batasnya: lewat 24 jam transaksi ditandai `expired`; halaman bayar menampilkan hitungan mundur dari nilai efektif `min(expired_at gateway, dibuat+24 jam)` via `effectiveExpiryIso()`. Pembayaran manual tidak pernah auto-expire.
- **Cache edge:** `/api/products` di-cache 60 detik — landing page ramai tidak menghantam D1.
- **Header keamanan:** `X-Frame-Options`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`, HSTS — untuk respons Worker via middleware, untuk aset statis via `public/_headers`.
- **CSRF:** cookie `SameSite=Lax` + middleware Origin check untuk POST/PUT/DELETE (webhook dikecualikan, dilindungi `X-Secret` timing-safe).
- **Admin bootstrap:** halaman `/setup` hanya aktif selama belum ada admin; dikunci `SETUP_SECRET` di produksi. Kredensial admin tidak pernah tersimpan di file/kode mana pun.

## Operasional harian (admin)

- **Reset password user:** Admin → Users → Reset Password. Password sementara 12 karakter **ditampilkan sekali** saja; semua session user tersebut dibatalkan.
- **Perpanjang akses manual:** Admin → Users → detail → Perpanjang Akses (1–3650 hari).
- **Sembunyikan produk/paket:** matikan flag aktif (data histori tetap aman).
- **Hapus soal:** soft delete — histori attempt tetap utuh.

## Backup & pemulihan

Lapisan-lapisannya (dari kecil ke besar kemalasan):

- **Time Travel D1 (otomatis, bawaan):** seluruh database dapat dikembalikan ke titik waktu mana pun dalam **30 hari terakhir** — tanpa setup apa pun. Ini pelindung utama untuk salah migration/salah hapus yang disadari cepat.
- **Backup mingguan offsite (otomatis):** workflow `.github/workflows/backup-d1.yml` jalan tiap **Senin 02:43 WIB** — `wrangler d1 export` produksi → gzip (~1–2 MB) → **artifact GitHub** dengan retensi 90 hari (± 13 salinan). Artifact TIDAK masuk git; isi repo dan push/pull tidak pernah tersentuh file backup. Kredensial: repo secret `CLOUDFLARE_API_TOKEN` (Cloudflare API token, scope Account → D1 → Edit — export menolak token read-only). Catatan: GitHub mematikan cron repo yang tak ada aktivitas 60 hari — push sesekali. Bisa juga dijalankan manual: tab Actions → Backup D1 → Run workflow.
- **Backup manual lokal:** `npx wrangler d1 export tryout-upkp-db --remote --output=backups/nama.sql --skip-confirmation` — folder `backups/` sudah di-gitignore (berisi data user, jangan pernah di-commit). **R2 materi PDF tidak termasuk** dump ini; pelindungnya: aktifkan object versioning bucket `tryout-upkp-materi` (dashboard R2) agar terhapus/timpa masih bisa dipulihkan.

**Cara pemulihan:**

- *Kecelakaan < 30 hari* (paling umum): `npx wrangler d1 time-travel restore tryout-upkp-db --timestamp "2026-01-01T00:00:00Z"` — interaktif, konfirmasi sebelum menimpa. Cari titik aman via `npx wrangler d1 time-travel info tryout-upkp-db --timestamp=...`.
- *Bencana total / > 30 hari* (DB terhapus, akun bermasalah): unduh artifact dari GitHub → `gunzip d1-backup-YYYY-MM-DD.sql.gz` → buat DB baru `npx wrangler d1 create tryout-upkp-db` → impor `npx wrangler d1 execute <DB-BARU> --remote --file=d1-backup-YYYY-MM-DD.sql` → terapkan ulang migrasi bila perlu (`npm run db:remote` idempoten) → ganti `database_id` di `wrangler.jsonc` → `npm run deploy`. Simpan dump bekas di luar git.
