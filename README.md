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
| `PAKASIR_PROJECT` | ✅ (mode pakasir) | Slug project Pakasir (`tryout-upkp`). |
| `PAKASIR_WEBHOOK_SECRET` | ⬜ | Secret webhook dari detail project Pakasir. Dipakai untuk verifikasi header `X-Secret`. |
| `SETUP_SECRET` | ⬜ (disarankan produksi) | Mengunci halaman `/setup` (bootstrap admin pertama). |
| `TURNSTILE_SITE_KEY` | ⬜ (disarankan produksi) | Site key Cloudflare Turnstile untuk captcha register/login (publik, boleh di frontend). |
| `TURNSTILE_SECRET_KEY` | ⬜ (disarankan produksi) | Secret key Turnstile — verifikasi token di server. Aktif hanya jika site key juga terisi. |

Dua var non-rahasia diatur langsung di `wrangler.jsonc` → `vars`:

| Nama | Keterangan |
|---|---|
| `PAYMENT_MODE` | `manual` = QRIS pribadi + konfirmasi WA (mode transisi selama Pakasir sandbox); `pakasir` = gateway otomatis. |
| `MANUAL_WA` | Nomor WA admin untuk konfirmasi pembayaran manual (format internasional tanpa `+`, mis. `6282347303153`). |

> **Jangan pernah** menaruh nilai rahasia di kode, wrangler.jsonc, atau file yang di-commit. Semua rahasia hanya hidup di `.dev.vars` (sudah di-gitignore) dan Cloudflare secrets.

## Deploy

```bash
# 1. set secret produksi
wrangler secret put SESSION_SECRET        # string acak ≥32 char
wrangler secret put PAKASIR_API_KEY
wrangler secret put PAKASIR_PROJECT       # tryout-upkp
wrangler secret put SETUP_SECRET          # acak, dipakai sekali untuk /setup
wrangler secret put TURNSTILE_SITE_KEY     # opsional: captcha register/login
wrangler secret put TURNSTILE_SECRET_KEY   # opsional: pasangan site key

# 2. migrasi database produksi
npm run db:remote

# 3. deploy
npm run deploy

# 4. bootstrap admin (sekali)
#    buka https://ditryout.in/setup
#    isi SETUP_SECRET + email/password admin.
#    Halaman ini mati permanen setelah admin pertama dibuat.
```

### Konfigurasi webhook Pakasir (setelah deploy)

1. Buka detail project di dashboard Pakasir → salin **Webhook Secret**.
2. `wrangler secret put PAKASIR_WEBHOOK_SECRET` dengan nilai tersebut.
3. Set URL webhook di dashboard Pakasir ke:
   `https://ditryout.in/api/payments/webhook`

Tanpa webhook, pembayaran tetap tuntas lewat **polling** (`GET /api/payments/:id` mengecek status ke Pakasir dengan throttle 4,5 detik/transaksi/isolat) — webhook hanya membuatnya lebih cepat dan andal.

## Mode pembayaran manual (transisi selama Pakasir sandbox)

Selama project Pakasir masih sandbox (QRIS tidak memindahkan uang nyata), `PAYMENT_MODE=manual` membuat alur bayar menjadi:

1. User memilih produk → sistem membuat referensi (`TO-XXXX`) **tanpa memanggil Pakasir** (`method='manual'`).
2. Halaman pembayaran menampilkan QRIS pribadi (`public/img/qris.jpg`, aset lokal) + nominal tepat + tombol **Konfirmasi via WhatsApp** dengan pesan otomatis berisi referensi & produk.
3. User scan + bayar, lalu klik tombol WA ke admin (`MANUAL_WA` di `wrangler.jsonc`).
4. Admin cek mutasi QRIS → panel **Admin → Transaksi → Tandai Lunas** pada baris pending.
5. Aksi admin menjalankan `settlePayment` idempoten yang sama dengan webhook — akses langsung diperpanjang, transaksi tercatat `paid` dan masuk statistik pendapatan. Halaman user yang terbuka otomatis pindah ke layar sukses (polling 6 detik).

Catatan: payment manual tidak pernah auto-expire — uang bisa saja sudah masuk sebelum admin sempat memverifikasi.

### Kembali ke mode otomatis setelah Pakasir lolos produksi

1. `wrangler.jsonc` → `"vars": { "PAYMENT_MODE": "pakasir", ... }` (WA bisa dibiarkan).
2. Salin **Webhook Secret** dari detail project Pakasir → `npx wrangler secret put PAKASIR_WEBHOOK_SECRET`.
3. Set URL webhook di dashboard Pakasir: `https://ditryout.in/api/payments/webhook`.
4. `npm run deploy`, lalu selesaikan pembayaran manual pending (Tandai Lunas) sebelum berganti — transaksi lama tetap bisa ditandai kapan saja.

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
  routes/            auth, setup, packages, attempts, results, payments, admin/*
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
- **Bersih-bersih otomatis:** cron harian (03:17 WIB) menghapus session kedaluwarsa.
- **Batas transaksi pending:** maksimal 5 payment `pending` per user (anti-spam tulis D1).
- **Cache edge:** `/api/products` di-cache 60 detik — landing page ramai tidak menghantam D1.
- **Header keamanan:** `X-Frame-Options`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`, HSTS — untuk respons Worker via middleware, untuk aset statis via `public/_headers`.
- **CSRF:** cookie `SameSite=Lax` + middleware Origin check untuk POST/PUT/DELETE (webhook dikecualikan, dilindungi `X-Secret` timing-safe).
- **Admin bootstrap:** halaman `/setup` hanya aktif selama belum ada admin; dikunci `SETUP_SECRET` di produksi. Kredensial admin tidak pernah tersimpan di file/kode mana pun.

## Operasional harian (admin)

- **Reset password user:** Admin → Users → Reset Password. Password sementara 12 karakter **ditampilkan sekali** saja; semua session user tersebut dibatalkan.
- **Perpanjang akses manual:** Admin → Users → detail → Perpanjang Akses (1–3650 hari).
- **Sembunyikan produk/paket:** matikan flag aktif (data histori tetap aman).
- **Hapus soal:** soft delete — histori attempt tetap utuh.
