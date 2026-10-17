# Panduan Agent — Tryout UPKP (https://ditryout.in)

File ini = titik masuk untuk SEMUA AI agent (Claude Code, Droid, Codex, Cursor, dll.). `CLAUDE.md` hanya meng-import file ini.

Platform tryout berbayar untuk persiapan UPKP Imipas. Cloudflare Worker (Hono + TypeScript), D1 (raw SQL tanpa ORM), R2 untuk PDF materi, Durable Object untuk rate limit, frontend HTML/vanilla JS di `public/` (tanpa build step). **Situs ini LIVE dan menerima uang nyata.**

## Urutan baca

1. **File ini** — aturan kerja, peta "ubah X → file Y", invarian, jebakan.
2. `README.md` — setup, env vars, deploy, mode pembayaran, keputusan teknis, backup.
3. `docs/API.md` — semua endpoint (method, path, auth, fungsi).
4. `docs/DATABASE.md` — skema D1, status & makna kolom, aturan migrasi.
5. `prd.txt` — PRD asli (konteks bisnis; kode sudah berkembang melampauinya — kode menang bila berbeda).

Komentar di `src/services/*` dan `src/routes/payments.ts` menjelaskan **mengapa**; baca sebelum mengubah logika pembayaran/skor.

## Perintah

```bash
npm run dev         # wrangler dev (lihat jebakan di bawah) → http://localhost:8787
npm run typecheck   # WAJIB lolos sebelum commit
npm run deploy      # wrangler deploy = LANGSUNG PRODUKSI (uang nyata)
npm run db:local    # migrasi D1 lokal    |  npm run db:remote  # migrasi D1 produksi
npm run seed:local  # paket demo 10 soal (lokal saja)
```

Belum ada test suite menyeluruh. Verifikasi = `npm run typecheck` + uji manual via `npm run dev` (lihat "Verifikasi" di bawah). Khusus ekspor kontak admin, jalankan `node scripts/test-contact-export.mjs` (Node ≥22.13, SQLite in-memory tanpa akses produksi).

Smoke test Duitku (diagnostik utama gateway kedua):

```bash
# bash / git-bash
DUITKU_MERCHANT_CODE=DSxxxx DUITKU_API_KEY=xxx node scripts/duitku-smoke.mjs            # sandbox
DUITKU_MERCHANT_CODE=D25142 DUITKU_API_KEY=xxx node scripts/duitku-smoke.mjs --prod     # produksi
```

```powershell
# PowerShell (mesin dev utama = Windows)
$env:DUITKU_MERCHANT_CODE='D25142'; $env:DUITKU_API_KEY='xxx'; node scripts/duitku-smoke.mjs --prod
```

Output: inquiry per channel (`--method=SQ,NQ,SP` menguji urutan tertentu), daftar channel AKTIF merchant (`getpaymentmethod`), dan `transactionStatus`. Jalankan `--prod` setelah mengubah apa pun tentang channel/signature Duitku. Key produksi = rahasia: minta user menjalankannya sendiri.

## Peta cepat: mau ubah X → sentuh file ini

| Tugas | File utama | Catatan |
|---|---|---|
| Endpoint baru / routing | `src/index.ts` (mount + middleware global), `src/routes/*.ts` | Daftarkan juga di `docs/API.md` |
| Endpoint admin | `src/routes/admin/*.ts`, mount di blok `ADMIN` `src/index.ts` | Router admin sudah `requireAdmin` |
| Logika pembayaran (create, polling, webhook, callback) | `src/routes/payments.ts` | Settle SELALU lewat `settlePayment` |
| Settle, perpanjang akses, rekonsiliasi, TTL | `src/services/payments.ts` | Idempoten — jangan dibuat baca-ubah-tulis |
| Klien gateway | `src/services/pakasir.ts`, `src/services/duitku.ts` | Duitku: guard sandbox/host, fee gross-up |
| Mode pembayaran / gateway aktif (toggle admin) | `src/services/settings.ts`, `src/routes/admin/settings.ts` | Tabel `settings` menimpa env |
| Skor & kelulusan | `src/services/scoring.ts`, `src/services/passing-grades.ts` | 5 poin/benar; hasil dibekukan saat submit |
| Alur ujian (mulai, autosave, submit) | `src/routes/attempts.ts` | Jangan kirim `correct_answer` sebelum submit |
| Hasil & pembahasan | `src/routes/results.ts` | Pembahasan hanya setelah submit |
| Kartu "Bagikan Hasil" (gambar Story WA/IG) | `public/js/share-card.js`, tombol di `public/result.html` | Dirender di browser (canvas 1080x1920), tanpa beban Worker; teks bagikan memuat link referral dari `GET /api/referral` |
| Auth, register, lupa password | `src/routes/auth.ts`, `src/utils/session.ts`, `src/utils/hash.ts` | Turnstile dicek sebelum argon2 |
| Login dengan Google | `src/routes/google-auth.ts`, `src/services/google.ts`, `TO.renderGoogleAuth` di `public/js/app.js` | Efek samping akun baru lewat `afterSignup()` (`src/services/signup.ts`); redirect URI jangan dari `c.req.url` |
| Referral | `src/services/referrals.ts`, `src/routes/referral.ts` | Diskon 10% invitee; bonus +3 hari saat lunas pertama |
| Day streak | `src/services/streak.ts`, dicatat di `scoreAndFinalize` (`src/services/scoring.ts`) & `GET /api/materials/:id`, kartu di `public/dashboard.html` | Tanggal WITA; satu `UPDATE` atomik maks 1x/hari; gagal tidak boleh menggagalkan submit |
| Papan peringkat | `src/services/leaderboard.ts`, `src/routes/leaderboard.ts`, `public/leaderboard.html`, chip peringkat di `public/result.html` | Percobaan pertama per paket aktif + bonus lulus; top-N di-cache edge (tanpa data per-user) |
| Email (transport, kuota, template, reset password, kontak broadcast) | `src/services/resend.ts` | Semua email lewat `sendEmail()` (kuota + `email_log`); gagal tidak boleh membatalkan alur |
| Email notifikasi (sambutan, bukti bayar, pengingat belum bayar) | `src/services/notifications.ts`, `sendAbandonedPaymentReminders` di `src/services/payments.ts` | Bukti bayar dikirim dari `settlePayment`; kuota Resend Free 100/hari (`EMAIL_DAILY_LIMIT`) |
| Rate limit | `src/middleware/ratelimit.ts` (angka), `src/do/ratelimit.ts` (counter DO) | Fail-open bila DO error |
| CSRF / header keamanan | `src/middleware/security.ts`, `public/_headers` | Aset statis TIDAK lewat Worker |
| Import/export soal JSON | `src/services/importer.ts`, `src/routes/admin/questions.ts`, `src/routes/admin/catalog.ts` | Import maks 500 soal (8 MB); export `GET /api/admin/packages/:id/export` menghasilkan JSON identik format import |
| Materi PDF (R2) | `src/routes/materials.ts`, `src/routes/admin/materials.ts`, `public/js/reader.js` | Cache `private` saja |
| Cron | `scheduled` di akhir `src/index.ts`, jadwal di `wrangler.jsonc` | Harian 03:17 WIB (bersih-bersih + rekonsiliasi); `*/15` = pengingat belum bayar (string harus sama dengan `REMINDER_CRON`) |
| Skema DB | `migrations/NNNN_*.sql` (file BARU) | Lihat aturan migrasi di bawah |
| Halaman user | `public/*.html` + `public/js/app.js` (`window.TO`) | Vanilla JS inline per halaman |
| Halaman admin | `public/admin/*.html` + `public/js/admin.js` (`window.ADM`) | Tambah item di `NAV` `admin.js` |
| Artikel SEO | `public/artikel/*.html`, `public/artikel/index.html`, `public/sitemap.xml` | Lihat checklist artikel |
| Landing page, statistik publik, popup bukti sosial | `public/index.html`, `public/js/social-proof.js`, `/api/site-stats`, `/api/recent-results` di `src/index.ts` | Di-cache edge |
| Gaya | `public/css/style.css` (satu file) | Tidak ada framework CSS |
| Env/binding baru | `src/types.ts` (`Env`), `wrangler.jsonc` (`vars`), `.dev.vars.example`, tabel env di `README.md` | Rahasia → `wrangler secret` |

## Alur request (urutan middleware di `src/index.ts`)

1. Normalisasi path `//…` → dispatch ulang.
2. Paksa HTTPS (hanya bila `x-forwarded-proto: http` — edge Cloudflare asli).
3. Rate limit `/api/*` 300/menit per IP (`RATE_LIMIT_API`) — sebelum query sesi.
4. `attachUser` — cookie sesi → `c.get('user')` (format token dicek dulu sebelum D1).
5. Rate limit tulis `/api/*` (non-GET, di luar auth/setup) 90/menit per user/IP.
6. `originGuard` (CSRF; webhook & callback gateway dikecualikan) → `securityHeaders`.
7. Router per modul. Guard per router: `requireAuth`, `requireActiveAccess` (user harus punya akses aktif; admin bebas), `requireAdmin`.

Aset `public/` di-serve langsung oleh Workers Assets **tanpa** melewati Worker — Worker hanya menangani path yang tidak cocok dengan file statis (`/api/*`, 404).

Format respons API SELALU `{ success: true, data }` atau `{ success: false, error }` via `ok()` / `fail()` di `src/utils/response.ts`. Frontend `TO.api()` mengandalkan bentuk ini (melempar `Error` dengan `.status` & `.data`).

## Invarian — JANGAN dilanggar

- **Uang**: nominal selalu dari DB (`products.price`), tidak pernah dari client. `payments.amount` = harga dasar (setelah diskon referral); `total_payment`/`fee` = yang DIBAYAR pembeli. Verifikasi callback Duitku membandingkan `total_payment`; webhook Pakasir membandingkan `amount`.
- **Settlement idempoten**: semua jalur (webhook, callback, polling `GET /api/payments/:id`, `/me`, cron, admin "Tandai Lunas") bermuara di `settlePayment()` dengan `UPDATE … WHERE status!='paid'`. Jangan menambah jalur yang memperpanjang akses di luar fungsi ini.
- **Perpanjangan akses atomik**: `extendUserAccess()` = satu statement SQL (`MAX(expiry, now) + hari`). Jangan diganti baca-lalu-tulis di JS.
- **Anti-cheat**: `correct_answer` & `explanation` tidak pernah dikirim sebelum attempt `submitted`. Skor hanya dihitung server.
- **Hasil immutable**: `attempt_questions.is_correct`, `attempts.score`, `category_scores` dibekukan saat submit; edit soal tidak boleh mengubah hasil lama. Soal dihapus = soft delete (`deleted_at`).
- **Timestamp**: semua TEXT ISO-8601 UTC dari `new Date().toISOString()` (lebar tetap → perbandingan string = perbandingan waktu). UI menampilkan WITA (`Asia/Makassar`); "hari ini" admin = WIB. Jangan simpan format lain (satu pengecualian terdokumentasi: `users.streak_last_day` = tanggal WITA `YYYY-MM-DD`).
- **Sandbox Duitku tidak pernah dipakai di host produksi** (`duitkuUsable` + `guardHost`). Host non-produksi memaksa gateway Duitku.
- **Cache edge tidak peduli cookie**: hanya cache respons yang identik untuk semua orang (`/api/products`, `/api/site-stats`, `/api/recent-results`, top-N `/api/leaderboard` lewat key internal). Data per-user / PDF materi = `private` atau tanpa cache.
- **Rahasia**: hanya di `.dev.vars` (gitignored) dan `wrangler secret`. Jangan pernah menulis nilai key di kode, commit, log, atau output. `backups/` berisi data user — jangan pernah di-commit.
- **Satu admin**: partial unique index; `/setup` hanya hidup selama belum ada admin.
- **Rate limit fail-open**: error DO tidak boleh mematikan situs.

## Checklist perubahan umum

**Tambah endpoint**
1. Handler di `src/routes/<modul>.ts` dengan guard yang tepat; validasi input via `src/utils/validate.ts`, body via `readJson()` (`src/utils/body.ts`, batas 64 KB).
2. Mount di `src/index.ts` bila modul baru (admin → di bawah router `admin`).
3. Endpoint tulis yang mahal / bisa disalahgunakan → tambah limiter di `LIMITS` (`src/middleware/ratelimit.ts`).
4. Query D1 lebih dari ~6 sekaligus → `DB.batch([...])`, bukan `Promise.all` (batas koneksi simultan per invokasi).
5. Perbarui `docs/API.md`.

**Tambah/ubah skema (migrasi)**
1. File BARU `migrations/NNNN_deskripsi.sql`, nomor = terbesar + 1 (saat ini terakhir `0019`). Jangan pernah mengedit migrasi yang sudah diterapkan.
2. Hindari `CASE … END` dan compound `SELECT … UNION ALL` panjang di file migrasi (splitter wrangler/D1 bermasalah — lihat `0007`). Satu statement per aturan.
3. `npm run db:local` → uji → perbarui `docs/DATABASE.md`. `npm run db:remote` hanya setelah user setuju (produksi).
4. Kode harus aman berjalan **sebelum** migrasi remote diterapkan bila deploy & migrasi tidak bersamaan — atau terapkan migrasi dulu, lalu deploy.

**Tambah halaman frontend**
- User: salin pola halaman yang ada (`<header id="site-header">`, `/js/app.js`, `TO.requireUser()`, `TO.renderHeader()`); escape semua data dinamis dengan `TO.esc()`.
- Admin: `public/admin/<nama>.html`, panggil `ADM.adminInit('/admin/<nama>.html')`, tambahkan `[href, label]` ke `NAV` di `public/js/admin.js`.

**Tambah artikel SEO**
1. Salin artikel yang ada di `public/artikel/` (meta description, canonical tanpa `.html`, OG, JSON-LD Article + Breadcrumb, gtag).
2. Tambahkan ke daftar di `public/artikel/index.html` dan `public/sitemap.xml`; opsional tautan "artikel terkait" di artikel lain / `public/index.html`.

**Ubah harga/produk**: lewat panel admin (Produk Akses), bukan migrasi. Produk yang punya transaksi tidak bisa dihapus — nonaktifkan.

**Ubah apa pun yang menyentuh uang/harga/gateway**: konfirmasi user sebelum deploy; pertimbangkan toggle admin (tanpa deploy) sebagai alternatif.

## Verifikasi

- `npm run typecheck` wajib lolos.
- Uji lokal: `npm run db:local && npm run seed:local && npm run dev`. Bootstrap admin lokal via `http://localhost:8787/setup`.
- Pembayaran lokal: sandbox Duitku (isi `.dev.vars`); callback tidak menjangkau localhost — alur selesai via polling halaman bayar / `payment_url` simulator.
- Query D1 berat: cek rencana via `npx wrangler d1 execute tryout-upkp-db --local --command "EXPLAIN QUERY PLAN …"`. Pemakaian produksi (ukuran DB, rows read 24 jam): `npx wrangler d1 info tryout-upkp-db`.

## Jebakan wrangler dev (penting, sering menggigit)

- **Host di-rewrite**: `c.req.url` dan header `Host` di-rewrite menjadi `ditryout.in` walau dijalankan lokal → host saja TIDAK cukup membedakan dev vs prod. Pembeda yang andal: header `x-forwarded-proto` (selalu diset edge Cloudflare asli, tidak pernah oleh wrangler dev) — lihat `guardHost()` di `src/services/duitku.ts`.
- **`.dev.vars` tidak hot-reload** — edit lalu restart; bunuh dulu pohon proses wrangler/workerd basi (PowerShell/cmd: `taskkill /F /IM workerd.exe`; git-bash: `taskkill //F //IM workerd.exe`).
- **Login/register lokal tanpa Turnstile**: hapus sementara baris `TURNSTILE_` dari `.dev.vars` (Turnstile otomatis nonaktif bila key kosong).
- Host non-produksi **memaksa gateway Duitku** (pembeli produksi mengikuti toggle admin); sandbox Duitku tidak pernah dipakai di host produksi (diblokir di kode).
- `clientIp()` = `'unknown'` di lokal (tanpa `cf-connecting-ip`) → semua request lokal berbagi satu bucket rate limit per IP.

## Operasional produksi

- **Baca D1 remote**: `wrangler d1 execute --remote` biasanya ditolak oleh permission layer; pakai `wrangler d1 export <db> --table=<nama> --no-schema --remote --output=file.sql` (simpan di luar git, mis. `backups/`). Tabel `settings` = sumber kebenaran mode pembayaran (`payment_mode`) & gateway aktif (`active_gateway`) — **toggle admin menimpa env vars**, tanpa deploy.
- **Log live**: `npx wrangler tail --format json` + grep. Create gateway yang sukses TIDAK mengelog apa pun (diam = bagus); kegagalan terlihat sebagai `[duitku] channel <kode> ditolak: <pesan>` dan `[create:fallback] <gateway>`. Prefix log lain: `[settle:referral]`, `[register:referral]`, `[google]` (tukar kode gagal, mis. `invalid_client` = secret salah), `[google:referral]`, `[resend]` (termasuk `[resend] kuota <jenis> dilewati` = kuota harian menipis), `[email:welcome|receipt|reminder]`, `[cron:reminder]`, `[ratelimit]`.
- **Email**: kuota Resend (Free = 100/hari) dipakai bersama semua email; penjaga kuota di `sendEmail()` mendahulukan reset password > bukti bayar > pengingat > sambutan. Jejak kirim di tabel `email_log` (export `--table=email_log` untuk audit).
- **Duitku**: polling status maks 1x/15 detik per transaksi (lebih rapat = blokir IP ~1 jam); QRIS kedaluwarsa 30 menit; callback = form-urlencoded + signature HMAC-SHA256.
- **Pakasir**: polling maks 1x/4,5 detik per transaksi; batas bayar 24 jam ditegakkan aplikasi (Pakasir tidak mengirim `expired_at`); webhook `X-Secret` + double-check API status.
- **Kode channel QRIS Duitku**: `SQ` = Nusapay, `NQ` = Nobu, `SP` = ShopeePay — channel TERPISAH di katalog dan beda antar environment (di merchant ini: `SQ` hanya ada di produksi, `NQ` hanya di sandbox). Error *"Payment channel not available"* = channel belum aktif untuk merchant → cek daftar via smoke test, jangan buru-buru menyalahkan signature.
- **Fee & nominal**: `payments.amount` = harga dasar produk; `total_payment`/`fee` = nominal yang DIBAYAR pembeli (fee gateway di-pass-through via gross-up, `DUITKU_FEE_PCT` — Duitku 0.7%; Pakasir menambah fee sendiri). Verifikasi callback Duitku selalu membandingkan `total_payment`, bukan `amount`.
- **Secret**: hanya via `wrangler secret` / `.dev.vars` (keduanya di luar git) — jangan pernah menaruh nilai key di file kode, commit, atau output. Jika diagnosa butuh key produksi, minta user menjalankannya sendiri atau paste sementara.
- **Deploy = langsung ke pembeli nyata**: untuk perubahan yang menyentuh uang/ harga/ gateway, konfirmasi user dulu sebelum deploy; toggle admin bisa menjadi alternatif tanpa deploy.
- **Plan**: Workers Paid. Kuota D1 tidak jadi kendala pada skala saat ini (≈1k–5k user); tetap hindari query yang memindai tabel besar (`questions`, `attempt_questions`) di endpoint yang sering dipanggil — cache atau index bila perlu.

## Konvensi kode

- TypeScript strict, raw SQL dengan placeholder `?` / `?1` (jangan pernah interpolasi input ke string SQL). Hono `c.env.DB.prepare(...).bind(...)`.
- Komentar bahasa Indonesia, padat, menjelaskan **mengapa** (bukan apa) — ikuti gaya file di `src/services/*`.
- Pesan error untuk user: bahasa Indonesia, sopan, dapat ditindaklanjuti.
- Frontend: vanilla JS, tanpa dependensi/bundler baru. Pakai helper `TO.*` (api, esc, rupiah, fmtDate/fmtDateTime, toast, busy, copy) — jangan duplikasi.
- Jangan menambah dependensi npm tanpa alasan kuat (bundle Worker harus kecil; hash pakai `@noble/hashes` JS murni).
- Commit message bahasa Indonesia, format `Modul: deskripsi singkat` (contoh modul: `Payments Duitku`, `Auth`, `Landing`, `Docs`, `Rate limit`), badan menjelaskan alasan + cara verifikasi, lalu baris `Co-Authored-By:` milik agent yang mengerjakan (mis. `Co-Authored-By: Claude Code <noreply@anthropic.com>` atau trailer factory-droid).
- Statistik transaksi ada di tabel `payments` (kolom `gateway`, `status`, `amount`, `total_payment`, `fee`); user & akses di `users` (`access_expires_at`).
- Perubahan perilaku → perbarui dokumen terkait (`README.md`, `docs/API.md`, `docs/DATABASE.md`, file ini) dalam commit yang sama.
