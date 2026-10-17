# Referensi API — Tryout UPKP

Semua endpoint di bawah `/api/*`, dilayani Worker (`src/index.ts` me-mount router dari `src/routes/`). Aset `public/` tidak lewat Worker.

## Konvensi

- **Respons**: selalu JSON `{ "success": true, "data": … }` atau `{ "success": false, "error": "pesan" }` (`src/utils/response.ts`). Pengecualian: `GET /api/materials/:id/file` (byte PDF). Beberapa 409/410 attempt menambahkan field (`attempt_id`, `result_id`) di samping `error`.
- **Auth**: cookie sesi `HttpOnly; SameSite=Lax` (30 hari, satu perangkat per akun — login baru menghapus sesi lama). Guard:
  - `publik` — tanpa login.
  - `user` — `requireAuth` (401 bila tidak login).
  - `akses` — `requireActiveAccess`: user harus punya `access_expires_at` > sekarang (403 bila tidak); admin selalu lolos.
  - `admin` — `requireAdmin` (403 bila bukan admin).
- **CSRF**: request non-GET dengan header `Origin` harus sama dengan `Host` (kecuali webhook/callback gateway).
- **Body**: JSON maks 64 KB (`readJson`), import soal maks 8 MB, unggah materi multipart maks 25 MB/file.
- **Rate limit** (Durable Object, `src/middleware/ratelimit.ts`): semua `/api/*` 300/menit/IP; non-GET di luar auth/setup 90/menit/user; per endpoint di tabel. 429 + `Retry-After: 60`.
- **Admin dipaginasi**: query `page` (mulai 1); respons memuat `total`, `page`, `per_page`.

## Publik (didefinisikan langsung di `src/index.ts`)

| Method | Path | Guard | Fungsi |
|---|---|---|---|
| GET | `/api/products` | publik | Produk akses aktif + `manual_available`, `manual_forced` (mode pembayaran). Cache edge 60 dtk |
| GET | `/api/site-stats` | publik | Jumlah paket aktif, soal, user (landing). Cache edge 3 jam (`SITE_STATS_TTL`) |
| GET | `/api/recent-results` | publik | Feed bukti sosial: lulus / sedang mengerjakan / pembelian, 30 hari, hanya nama depan. Cache edge 60 dtk |
| GET | `/wa?ref=` | publik | Redirect 302 ke `wa.me/<MANUAL_WA>` dengan pesan "kendala pembayaran" (+ `Ref:` bila `ref` berformat `TO-…`). Dipakai email agar semua tautan tetap di domain `ditryout.in`. Tanpa `MANUAL_WA` → `/` |

## Auth — `src/routes/auth.ts` (`/api/auth`)

| Method | Path | Guard | Fungsi |
|---|---|---|---|
| GET | `/captcha` | publik | Konfigurasi halaman login/daftar: site key Turnstile (kosong = captcha nonaktif) + `google` (tombol Login Google aktif) |
| POST | `/register` | publik, 6/mnt/IP | `{ name, email, password, turnstile_token?, ref? }` — buat akun + sesi; `ref` = kode referral (salah = diabaikan diam-diam); sinkron kontak Resend + email sambutan (waitUntil) |
| POST | `/login` | publik, 12/mnt/IP | `{ email, password, turnstile_token? }` — lockout 5 gagal/15 mnt (password benar tetap bisa masuk); email tak terdaftar dikunci virtual (anti-enumeration) |
| POST | `/logout` | user | Hapus sesi ini |
| GET | `/me` | user | Profil + status akses (`access.active`, `days_left`, `is_admin`, `has_access`) + `streak` (`current`, `best`, `last_day`, `active_today`, `today` — tanggal WITA). Efek samping: finalisasi attempt kedaluwarsa + rekonsiliasi payment pending (maks 1x/15 dtk/user) |
| POST | `/heartbeat` | user | Cek sesi masih valid (dipakai halaman ujian; tanpa efek samping) |
| POST | `/forgot-password` | publik, 5/15 mnt/IP + 3/15 mnt/email | `{ email }` — kirim tautan reset (Resend). Respons selalu netral |
| POST | `/reset-password` | publik, 6/10 mnt/IP | `{ token, password }` — token sekali pakai 1 jam; sukses = hapus semua sesi user + buka lockout + tandai `email_verified_at` |

## Login dengan Google — `src/routes/google-auth.ts` (`/api/auth/google`)

Navigasi top-level (bukan `fetch`): semua respons berupa redirect 302. Gagal → kembali ke `/login.html` atau `/register.html` dengan `?google_error=<cancelled|expired|failed|unverified|conflict|exists|limited|unavailable>` (pesan di `TO.googleErrorMessage()`).

| Method | Path | Guard | Fungsi |
|---|---|---|---|
| GET | `/` | publik | `?from=login\|register&next=&ref=` — set cookie alur `g_oauth` (state + PKCE verifier + next/ref, 10 menit, `Path=/api/auth/google`) lalu redirect ke Google. `www.` dialihkan dulu ke apex |
| GET | `/callback` | publik, 20/10 mnt/IP | Cek `state` = cookie, tukar `code` (PKCE) di Google, wajib `email_verified`. Urutan cocok: `google_sub` → email (akun lama ditautkan hanya bila Google otoritatif atas email itu — Gmail atau klaim `hd` Workspace, selain itu `exists`; password akun yang emailnya belum terbukti dimatikan, kecuali admin) → buat akun baru (referral + kontak Resend + email sambutan). Buat sesi, redirect ke `next` / dashboard |

## Setup — `src/routes/setup.ts` (`/api/setup`)

| Method | Path | Guard | Fungsi |
|---|---|---|---|
| GET | `/` | publik | `{ needed }` — true bila belum ada admin |
| POST | `/` | publik, 12/mnt/IP | `{ secret, name, email, password }` — buat admin pertama; mati permanen setelah ada admin. `secret` wajib bila `SETUP_SECRET` diset |

## Paket & ujian

`src/routes/packages.ts` (`/api/packages`), `src/routes/attempts.ts` (`/api/attempts`), `src/routes/results.ts` (`/api/results`).

| Method | Path | Guard | Fungsi |
|---|---|---|---|
| GET | `/api/packages` | user | Paket aktif + ringkasan user (jumlah soal, attempt_count, last/best score, ever_passed, kategori) |
| GET | `/api/packages/:id` | user | Detail paket + jumlah soal, kategori, aturan passing grade |
| POST | `/api/attempts` | akses | `{ package_id }` — mulai ujian; snapshot urutan soal (kategori berurutan `sort_order`, soal diacak di dalamnya). 409 + `attempt_id` bila masih ada ujian berjalan |
| GET | `/api/attempts/active` | user | Ujian yang sedang berjalan (tombol "Lanjutkan") atau `null` |
| GET | `/api/attempts/:id` | user (pemilik/admin) | Soal + jawaban tersimpan + sisa waktu — TANPA kunci jawaban. Bila sudah selesai → `{ status: 'submitted', result_id }` |
| POST | `/api/attempts/:id/answer` | user (pemilik/admin) | `{ question_id, answer: 'A'..'E' \| null, marked_review? }` — autosave. 410 + auto-submit bila waktu habis |
| POST | `/api/attempts/:id/submit` | user (pemilik/admin) | Selesaikan + hitung skor di server (idempoten). Minimal 10 soal terjawab (atau semua soal bila paket < 10) → hari ini tercatat di day streak |
| GET | `/api/results` | user | Riwayat attempt `submitted` milik sendiri |
| GET | `/api/results/:id` | user (pemilik/admin) | Hasil + skor per kategori + pembahasan (hanya setelah submit) + `ranking` `{ rank, total, first_attempt_id, first_score, is_first }` = peringkat percobaan pertama pemilik di paket ini (`null` untuk admin) |

## Pembayaran — `src/routes/payments.ts` (`/api/payments`)

| Method | Path | Guard | Fungsi |
|---|---|---|---|
| POST | `/create` | user | `{ product_id, method?: 'manual' }` — nominal dari DB (diskon referral 10% bila berhak). Mode manual → `{ manual: { qr_url, wa } }`; gateway → `{ gateway, txn, qr_svg, support_wa }`. Urutan gateway: aktif (toggle) lalu fallback; host non-produksi memaksa Duitku. Maks 5 pending/user (429) |
| GET | `/:id` | user (pemilik/admin) | Status + polling ke gateway (Pakasir ≥4,5 dtk, Duitku ≥15 dtk per transaksi), auto-expire. Dipolling halaman bayar |
| POST | `/webhook` | header `X-Secret` | Webhook Pakasir — JSON `{ order_id, txn_id, amount, status, completed_at }`; cocokkan `txn_id` + `amount`, double-check API status, lalu `settlePayment` |
| POST | `/duitku/callback` | signature HMAC | Callback Duitku — form-urlencoded; cek `merchantCode`, signature, `reference`, nominal = `total_payment`, double-check API status. `resultCode=01` → expired |

## Referral & materi

| Method | Path | Guard | Fungsi |
|---|---|---|---|
| GET | `/api/referral` | user | Kode undangan (dibuat malas), link `register.html?ref=…`, jumlah diundang/membeli, hari bonus, `invitee_discount` |
| GET | `/api/materials` | user | `?category_id=&q=` — daftar materi aktif + kategori |
| GET | `/api/materials/:id` | user | Metadata satu materi. Efek samping: hari ini tercatat di day streak (waitUntil) |
| GET | `/api/materials/:id/file` | user, 150/mnt/user | Byte PDF dari R2 (Range + ETag, cache `private`); `?download=1` = attachment |

## Papan peringkat — `src/routes/leaderboard.ts` (`/api/leaderboard`)

Poin = Σ skor percobaan pertama tiap paket aktif + 100 (`PASS_BONUS`) per paket yang lulus di percobaan itu; papan dipisah `upkp` / `udin` / `lainnya`; admin tidak ikut. Logika di `src/services/leaderboard.ts`.

| Method | Path | Guard | Fungsi |
|---|---|---|---|
| GET | `/` | user | `{ boards: [{ key, label, total, entries: [{ rank, name, hidden, points, passed_count, package_count, streak }] }], top, pass_bonus, refresh_minutes, generated_at }` — top 50 per papan, nama "Depan I." / "Peserta". Tanpa user_id. Cache edge 10 menit lewat key internal `/__cache/leaderboard-v1`; respons ke browser `private, no-store` |
| GET | `/me` | user | `{ is_admin, hidden, standings: { <board>: { rank, total, points, passed_count, package_count } }, streak }` — tanpa cache |
| PUT | `/me` | user | `{ hidden: boolean }` — sembunyikan/tampilkan nama; hapus cache top-N di colo ini |

## Admin — semua `requireAdmin`, prefix `/api/admin`

`src/routes/admin/*`. Halaman admin terkait ada di `public/admin/`.

| Method | Path | Fungsi |
|---|---|---|
| GET | `/stats` | Kartu dashboard (9 query dalam satu `DB.batch`) |
| GET | `/payments` | `?status=&from=YYYY-MM-DD&to=YYYY-MM-DD&page=` — daftar transaksi (25/hal) + pendapatan rentang (menurut `paid_at`, WIB) |
| POST | `/payments/:id/mark-paid` | Tandai lunas manual → `settlePayment` (ikut mengirim email bukti bayar) |
| GET | `/results` | `?q=&page=` — semua attempt (25/hal) |
| GET / POST | `/settings/payment-mode` | Baca/ubah `{ mode: 'gateway' \| 'hybrid' \| 'manual' }` (alias lama `pakasir` diterima) |
| GET / POST | `/settings/active-gateway` | Baca (+ status konfigurasi tiap gateway) / ubah `{ gateway: 'pakasir' \| 'duitku' }` |
| GET | `/users` | `?q=&page=` (20/hal) |
| GET | `/users/export` | Khusus Gmail (`@gmail.com`), tanpa admin, seluruh hasil tanpa paginasi/pencarian. `segment=never_paid` (belum ada transaksi lunas & akses tidak aktif), `expired` (pernah lunas & akses tidak aktif), `active` (akses aktif, termasuk akses manual/bonus), atau `all`. `format=preview` → JSON `{ total }`; default `format=csv` → unduhan CSV UTF-8 `EMAIL,FIRSTNAME,LASTNAME` (pengecualian format JSON API). Email dinormalisasi/deduplikasi; nama di-escape dan dilindungi dari formula spreadsheet. `Cache-Control: private, no-store`. Ekspor bukan bukti consent marketing |
| GET | `/users/:id` | Detail + 20 payment + 20 attempt terakhir + statistik referral |
| POST | `/users/:id/reset-password` | Password sementara (ditampilkan sekali) + hapus semua sesi |
| POST | `/users/:id/extend-access` | `{ days: 1..3650 }` |
| GET / POST | `/products` | Daftar / buat `{ name, price, duration_days, description?, active? }` |
| PUT / DELETE | `/products/:id` | Ubah / hapus (409 bila punya transaksi → nonaktifkan) |
| GET / POST | `/packages` | Daftar (+ jumlah soal & attempt) / buat `{ title, exam_type, description?, duration_minutes, active?, passing_grade_total? }` |
| PUT / DELETE | `/packages/:id` | Ubah / hapus (409 bila punya attempt) |
| GET / PUT | `/packages/:id/passing-grades` | Aturan PG per kategori `{ rules: [{ category_id, minimum_score }] }` |
| GET / POST | `/categories` | `?exam_type=` / buat `{ name, exam_type, active? }` |
| PUT / DELETE | `/categories/:id` | Ubah / hapus (ditolak bila masih dipakai soal hidup) |
| GET / POST | `/questions` | `?package_id=&category_id=&q=&page=` (25/hal) / buat soal |
| PUT / DELETE | `/questions/:id` | Ubah / soft delete |
| POST | `/questions/import` | `{ data, mode: 'preview' \| 'commit', package_id?, import_mode?: 'append' \| 'replace', create_categories?, duration_minutes? }` — format JSON di README |
| GET / POST | `/material-categories` | Kategori materi |
| PUT / DELETE | `/material-categories/:id` | |
| GET / POST | `/materials` | `?category_id=&q=&page=` (20/hal) / unggah multipart `title, description, category_id, pages?, file` |
| PUT / DELETE | `/materials/:id` | Ubah metadata / hapus (DB + objek R2) |

## Halaman frontend → endpoint utama

| Halaman | Endpoint |
|---|---|
| semua halaman login | `/api/auth/me` (via `TO.requireUser()` / `TO.fetchMe()` di `public/js/app.js`) |
| `index.html` (landing) | `/api/products`, `/api/site-stats`, `/api/recent-results` (via `public/js/social-proof.js`) |
| `register.html`, `login.html`, `forgot.html`, `reset.html` | `/api/auth/captcha` + endpoint auth masing-masing |
| `dashboard.html` | `/api/packages`, `/api/products`, `/api/attempts/active`, `/api/referral`, `POST /api/attempts` (kartu streak dari `/api/auth/me`) |
| `leaderboard.html` | `/api/leaderboard`, `/api/leaderboard/me`, `PUT /api/leaderboard/me` |
| `exam.html` | `/api/attempts/:id`, `/answer`, `/submit`, `/api/auth/heartbeat` |
| `result.html`, `history.html` | `/api/results`, `/api/results/:id` |
| `payment.html` | `/api/products`, `/api/referral`, `/api/payments/create`, `/api/payments/:id` |
| `materi.html`, `baca.html` | `/api/materials*` (pembaca PDF: `public/js/reader.js`) |
| `setup.html` | `/api/setup` |
| `admin/*.html` | `/api/admin/*` |
