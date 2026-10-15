# Tryout UPKP

Platform tryout berbayar untuk persiapan **UPKP Imipas** (Kementerian Imigrasi dan Pemasyarakatan). Dibangun sesuai PRD: ringan, murah dijalankan, tanpa framework frontend.

**Live:** https://ditryout.in

**Dokumentasi lain:** [`AGENTS.md`](AGENTS.md) (panduan kerja untuk AI agent/maintainer: peta file, invarian, checklist, jebakan) · [`docs/API.md`](docs/API.md) (semua endpoint) · [`docs/DATABASE.md`](docs/DATABASE.md) (skema D1 & aturan migrasi) · `prd.txt` (PRD asli).

## Stack

| Lapisan | Teknologi |
|---|---|
| Runtime | Cloudflare Workers (Hono) |
| Database | Cloudflare D1 (SQLite) + raw SQL, tanpa ORM |
| Auth | Cookie session (HttpOnly), hash password **Argon2id** (@noble/hashes, JS murni) |
| Pembayaran | Dua gateway QRIS dinamis: **Pakasir** (utama) & **Duitku** (aktif via toggle admin, fallback otomatis) — atau mode manual: QRIS pribadi + verifikasi admin via WA |
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
| `PAKASIR_API_KEY` | ✅ (gateway pakasir) | API key dari dashboard Pakasir. |
| `PAKASIR_PROJECT` | ✅ (gateway pakasir) | Slug project Pakasir (`ditryoutin`). |
| `PAKASIR_WEBHOOK_SECRET` | ✅ (gateway pakasir) | Secret webhook dari detail project Pakasir. Dipakai untuk verifikasi header `X-Secret`. |
| `DUITKU_API_KEY` | ⬜ (gateway duitku) | API key Duitku (sandbox: dashboard sandbox.duitku.com; produksi: passport.duitku.com). Signature HMAC-SHA256, tanpa webhook secret. |
| `SETUP_SECRET` | ⬜ (disarankan produksi) | Mengunci halaman `/setup` (bootstrap admin pertama). |
| `TURNSTILE_SITE_KEY` | ⬜ (disarankan produksi) | Site key Cloudflare Turnstile untuk captcha register/login (publik, boleh di frontend). |
| `TURNSTILE_SECRET_KEY` | ⬜ (disarankan produksi) | Secret key Turnstile — verifikasi token di server. Aktif hanya jika site key juga terisi. |
| `RESEND_API_KEY` | ⬜ (wajib untuk lupa password & notifikasi email) | API key Resend — kirim email reset password, sambutan pendaftaran, bukti bayar, pengingat belum bayar + sinkron pendaftar baru ke Contacts Resend (bahan broadcast). Domain pengirim `ditryout.in` harus Verified di Resend. Kosong = email tidak terkirim (alur tetap jalan, error di log). |

Var non-rahasia diatur langsung di `wrangler.jsonc` → `vars`:

| Nama | Keterangan |
|---|---|
| `PAYMENT_MODE` | `gateway` = gateway otomatis (mode produksi; nilai lama `pakasir` di-rename migration 0015, alias lama tetap diterima); `manual` = QRIS pribadi + konfirmasi WA (fallback bila kedua gateway bermasalah). |
| `SHOW_MANUAL_PAYMENT` | `true` = tampilkan tombol **Bayar Manual** di halaman bayar (`method='manual'` di `POST /api/payments/create` ditolak server selain `true`, kecuali `PAYMENT_MODE=manual`). Default `false` — disembunyikan. |
| `MANUAL_WA` | Nomor WA admin (format internasional tanpa `+`, mis. `6282347303153`). Dipakai untuk konfirmasi pembayaran manual **dan** tombol "Kendala pembayaran?" di halaman bayar gateway (`support_wa`). |
| `ACTIVE_GATEWAY` | Gateway utama transaksi QRIS baru: `pakasir` (default) \| `duitku`. Bila gateway utama error saat create, otomatis dialihkan ke gateway satunya (bila layak: terkonfigurasi + bukan sandbox di host produksi). Toggle admin menimpa nilai ini. |
| `DUITKU_MERCHANT_CODE` | merchantCode Duitku (sandbox `DS…`, produksi `D…`). |
| `DUITKU_SANDBOX` | `true` = pakai sandbox.duitku.com. Sandbox **tidak pernah** dipakai untuk transaksi user di host produksi (diblokir di kode); uji penuh di localhost (preview `*.workers.dev` sudah dimatikan: `workers_dev: false`). |
| `DUITKU_QRIS_METHOD` | Daftar preferensi channel QRIS Duitku, dipisah koma — default `SQ,NQ,SP` (`SQ` = Nusapay, `NQ` = Nobu, `SP` = ShopeePay — tiga channel TERPISAH di katalog Duitku walau NusaPay produk Bank Nobu; semua interoperabel antar app QRIS). Channel pertama yang tersedia yang dipakai — channel aktif per merchant bisa beda, cek `getpaymentmethod` via smoke test. |
| `EMAIL_DAILY_LIMIT` | Kuota email harian paket Resend — default `100` (paket Free). Dasar penjaga kuota email notifikasi (lihat "Email notifikasi"). Naikkan bila paket Resend di-upgrade. |
| `DUITKU_FEE_PCT` | Fee QRIS Duitku (%) yang ditanggung merchant — default `0.7` (MDR QRIS). Di-pass-through ke pembeli via gross-up: tagihan = harga + fee (dibulatkan ceil ke rupiah), dana masuk merchant tetap = harga produk; `payments.amount` menyimpan harga dasar, `total_payment`/`fee` nominal bayar (pola sama Pakasir). `0`/kosong = tanpa markup. |

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
wrangler secret put DUITKU_API_KEY         # gateway alternatif (key sandbox dulu utk uji;
                                           # ganti key produksi saat go-live Duitku)
wrangler secret put RESEND_API_KEY         # email lupa password, notifikasi + kontak broadcast

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

Tanpa webhook, pembayaran tetap tuntas lewat **polling** (`GET /api/payments/:id` mengecek status ke Pakasir dengan throttle 4,5 detik/transaksi/isolat) — webhook hanya membuatnya lebih cepat dan andal. Tambahan jaring pengaman: **cron harian** merekonsiliasi semua payment pending ber-transaksi ke API gateway masing-masing (maks 50 tertua/run per Pakasir + 25 per Duitku), sehingga user yang membayar lalu menutup aplikasi tanpa kembali tetap mendapat aksesnya paling lambat sehari.

### Gateway Duitku (alternatif QRIS)

Duitku adalah gateway kedua — **LIVE di produksi sejak 14 Okt 2026** (QRIS Nusapay `SQ`; settle uang nyata terverifikasi). Dipilih via toggle admin (Gateway Aktif), fallback otomatis bila gateway utama error saat create. QRIS Duitku berlaku **30 menit** (vs 24 jam Pakasir).

**Kode channel QRIS — tiga channel TERPISAH, katalog sandbox ≠ produksi:**

| Kode | Channel | Status di merchant `D25142` (14 Okt 2026) |
|---|---|---|
| `SQ` | Nusapay | ✅ aktif — dipakai saat ini |
| `NQ` | Nobu | hanya muncul di sandbox; ditolak produksi |
| `SP` | ShopeePay | belum aktif |

NusaPay memang produk QRIS Bank Nobu, tapi di katalog Duitku keduanya channel **berbeda** — jangan digabung (inilah sumber salah kode 14 Okt: komentar lama menulis "NQ = Nusapay/Nobu"). `DUITKU_QRIS_METHOD="SQ,NQ,SP"` = daftar preferensi berurutan: channel pertama yang diterima yang dipakai; mengaktifkan/mematikan channel di dashboard Duitku tidak perlu deploy ulang.

**Diagnosa error `Payment channel not available`** (HTTP 404 saat inquiry): artinya channel belum aktif untuk merchant — BUKAN salah signature/kredensial. Lihat channel yang benar-benar aktif via `getpaymentmethod` (bagian dari smoke test): output-nya juga menguji inquiry per channel (`--method=SQ`) dan `transactionStatus`.

**Fee QRIS 0,7% (MDR) — pass-through ke pembeli:** Duitku memotong fee dari settlement merchant, jadi tagihan di-gross-up agar dana masuk tetap = harga produk: `DUITKU_FEE_PCT="0.7"` (wrangler.jsonc) → tagihan = `ceil(harga/(1-0,7%))`, mis. 9.000 → bayar **9.064**. `payments.amount` menyimpan harga dasar; `total_payment`/`fee` menyimpan tagihan + selisih (pola sama dengan fee Pakasir — halaman bayar otomatis menulis "termasuk biaya layanan Rp X"). Set `0`/kosong untuk menanggung fee sendiri. Verifikasi callback & polling membandingkan **nominal tagihan** (`total_payment`), bukan harga dasar.

- Callback Duitku (server-ke-server, form-urlencoded + signature HMAC-SHA256): `https://ditryout.in/api/payments/duitku/callback` — juga dikirim per-transaksi saat create (URL mengikuti origin request, jadi uji localhost/preview otomatis memakai URL host itu sendiri).
- Verifikasi callback: signature + merchantCode + binding `reference` gateway + amount, lalu double-check ke API status — pola sama dengan webhook Pakasir.
- Polling status Duitku dibatasi 15 detik/transaksi (Duitku memblokir IP ~1 jam bila terlalu rapat).
- Go-live (SELESAI 12–14 Okt 2026, sebagai catatan): `wrangler secret put DUITKU_API_KEY` → `DUITKU_MERCHANT_CODE=D25142` + `DUITKU_SANDBOX="false"` di wrangler.jsonc → deploy → smoke `--prod` (signature HMAC-SHA256 diterima) → tunggu Duitku mengaktifkan channel QRIS → konfirmasi via `getpaymentmethod` → toggle **Gateway Aktif → Duitku** di panel admin.
- Smoke test cepat kapan pun: `DUITKU_MERCHANT_CODE=… DUITKU_API_KEY=… node scripts/duitku-smoke.mjs [--prod] [--method=SQ,NQ,SP]`.

## Mode pembayaran manual (fallback bila gateway bermasalah)

Gateway Pakasir sudah **produksi** — tombol utama halaman bayar adalah **Bayar via QRIS** (otomatis). Alur manual disembunyikan secara default. Cara mengubah mode (urutan prioritas):

1. **Toggle admin (utama, tanpa deploy)**: **Admin → Transaksi → Mode Pembayaran** — tiga pilihan: `Gateway otomatis` (gateway), `Gateway + tombol Bayar Manual` (hybrid), `Manual saja / dipaksa` (manual → banner gangguan tampil + tombol gateway disembunyikan). Di kartu yang sama ada **Gateway Aktif** (Pakasir/Duitku) untuk memilih gateway utama. Tersimpan di tabel `settings` D1 dan berlaku untuk transaksi baru langsung (halaman bayar mengikuti maks. 1 menit karena cache edge `/api/products`).
2. **Env var (baseline)**: dipakai hanya bila belum pernah di-toggle — `PAYMENT_MODE=manual` atau `SHOW_MANUAL_PAYMENT=true` di `wrangler.jsonc` + deploy.

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
| `npm run deploy` | Deploy ke Cloudflare Workers (**langsung produksi**) |
| `npm run typecheck` | Cek tipe TypeScript — satu-satunya pemeriksaan otomatis (belum ada test suite) |
| `npm run db:local` / `db:remote` | Terapkan migrasi D1 lokal/produksi |
| `npm run seed:local` | Seed paket demo 10 soal (hanya lokal) |
| `node scripts/duitku-smoke.mjs [--prod] [--method=SQ,NQ,SP]` | Smoke test Duitku (butuh env `DUITKU_MERCHANT_CODE` + `DUITKU_API_KEY`) |

## Struktur

```
AGENTS.md / CLAUDE.md  Panduan AI agent (CLAUDE.md hanya meng-import AGENTS.md)
docs/                  API.md (endpoint), DATABASE.md (skema D1)
migrations/            Skema D1 berurutan 0001…0017 (detail: docs/DATABASE.md)
scripts/
  seed-local.sql       Data demo lokal
  duitku-smoke.mjs     Smoke test gateway Duitku (sandbox/produksi)
.github/workflows/     backup-d1.yml — backup mingguan D1 → artifact GitHub
wrangler.jsonc         Binding (D1, R2, DO, assets), vars non-rahasia, cron, custom domain
src/
  index.ts             Middleware global, endpoint publik (products, site-stats,
                       recent-results), mount router, cron `scheduled`
  types.ts             Tipe Env (semua binding + env var) & SessionUser
  routes/              auth, setup, packages, attempts, results, payments,
                       materials, referral, admin/{overview,users,catalog,
                       questions,materials,settings}
  services/            payments (settle/akses/rekonsiliasi), pakasir, duitku,
                       settings (mode & gateway aktif), scoring, passing-grades,
                       importer, referrals, resend (kirim email + kuota + template),
                       notifications (sambutan, bukti bayar, pengingat), turnstile, qr (SVG)
  middleware/          auth (sesi & guard), security (CSRF + header), ratelimit
  do/ratelimit.ts      Durable Object counter rate limit
  utils/               hash (argon2id), session, validate, body (batas ukuran), response
public/                Frontend vanilla, di-serve Workers Assets (tanpa build)
  *.html               Halaman user (index, dashboard, exam, result, payment, materi, baca, …)
  admin/*.html         Panel admin
  artikel/*.html       Artikel SEO statis (+ sitemap.xml, robots.txt)
  js/app.js            Helper global `window.TO` (api, esc, format, header, auth)
  js/admin.js          Shell admin `window.ADM` (sidebar NAV, pager)
  js/reader.js         Pembaca PDF (pdf.js di js/vendor/)
  js/social-proof.js   Popup bukti sosial di landing
  _headers             Header keamanan aset statis
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
- **Rate limit berlapis via Durable Object (`src/do/ratelimit.ts`, angka di `LIMITS` `src/middleware/ratelimit.ts`):** semua `/api/*` 300/menit per IP; login & setup 12/menit per IP; register 6/menit per IP; lupa password 5/15 menit per IP + 3/15 menit per email; reset password 6/10 menit per IP; endpoint tulis lain 90/menit per user; unduh PDF materi 150/menit per user; rekonsiliasi pembayaran via `/me` maks 1x/15 detik per user. Counter fixed-window kuat-konsisten per key (satu instance DO per limiter+key). Jika DO error, fail-open (situs tidak mati). CATATAN: binding `ratelimit` bawaan Cloudflare pernah dicoba tapi tidak enforce pada akun ini (selalu success=true) — karena itu dipakai DO. Untuk flood yang lebih besar, tambahkan WAF Rate Limiting rule di dashboard Cloudflare (blokir `contains "/api/auth/"` > 10/menit per IP) — itu menahan serangan SEBELUM menyentuh Worker.
- **Lockout per-akun:** 5 login gagal → akun terkunci 15 menit untuk percobaan password SALAH berikutnya (password benar tetap bisa masuk, agar orang lain tidak bisa mengunci akun korban). Email tak terdaftar mendapat kunci virtual yang sama (counter DO) supaya respons tidak membocorkan email mana yang terdaftar.
- **Lupa password:** `POST /api/auth/forgot-password` mengirim tautan via Resend (`RESEND_API_KEY`) berisi token sekali pakai berlaku 1 jam (DB hanya menyimpan hash, tabel `password_reset_tokens`). Respons selalu netral. Reset sukses = semua sesi user dihapus + lockout dibuka.
- **Program referral:** setiap user punya kode undangan (dibuat saat pertama dibuka di dashboard, link `register.html?ref=KODE`). Yang diundang mendapat diskon 10% pada pembelian pertama yang lunas; pengundang mendapat +3 hari akses saat transaksi pertama invitee lunas (bukan saat daftar — akun palsu tidak menghasilkan apa pun). Satu akun hanya bisa jadi invitee sekali (`referrals.invitee_id` UNIQUE). Konstanta di `src/services/referrals.ts`.
- **Kontak broadcast:** pendaftar baru disinkron ke Contacts Resend (fire-and-forget, tidak pernah menggagalkan registrasi).
- **Email notifikasi (Resend, `src/services/notifications.ts` + template di `src/services/resend.ts`):**
  - *Sambutan* saat daftar (waitUntil): benefit platform + daftar paket aktif dan harga dari `products` (harga sudah dipotong bila daftar lewat undangan).
  - *Bukti bayar* dari `settlePayment()` — hanya pemenang `UPDATE … WHERE status!='paid'`, jadi semua jalur settle (webhook, callback, polling, `/me`, cron, admin "Tandai Lunas") tercakup tanpa dobel. Isi: produk, referensi, total dibayar (`total_payment`), masa akses baru (WITA).
  - *Pengingat belum bayar* via cron `*/15 * * * *`: transaksi QRIS berumur 1–12 jam yang belum lunas, hanya transaksi TERAKHIR user, maks 1 per user per 24 jam, dilewati bila user sudah membayar transaksi lain sejak itu. Pending dicek dulu ke gateway (cegah "belum bayar" untuk yang sebenarnya sudah lunas). Tagihan Pakasir yang masih aktif → tautan lanjut bayar; yang kedaluwarsa → tautan buat tagihan baru. Jam tenang 22:00–07:00 WITA (ditahan sampai pagi).
  - *Penjaga kuota*: kuota Resend dipakai bersama semua jenis email. Dihitung rolling 24 jam dari tabel `email_log` terhadap `EMAIL_DAILY_LIMIT`: sambutan berhenti di 70%, pengingat 85%, bukti bayar 95%; reset password tidak pernah dibatasi aplikasi. Log `[resend] kuota <jenis> dilewati` = kuota menipis → pertimbangkan upgrade paket Resend.
  - Anti-dobel = unique index `(kind, payment_id)` di `email_log`. Gagal kirim tidak di-retry (status `failed`) dan tidak pernah menggagalkan alur utama.
  - Halaman daftar menampilkan keterangan "gunakan email aktif" + saran salah ketik domain (`gmial.com` → `gmail.com`) di browser — email salah = bounce yang merusak reputasi pengirim.
- **Landing page dinamis:** statistik publik `/api/site-stats` (cache edge 3 jam) dan popup bukti sosial `/api/recent-results` (cache 60 detik; hanya nama depan, 30 hari terakhir).
- **Animasi angka:** `TO.animateCounts()` dipakai harga paket di halaman bayar, harga & biaya per hari di landing, serta statistik paket/soal/kategori/pengguna. Count-up 0,9 detik dimulai sekali saat angka terlihat di layar, mengikuti format rupiah/pemisah ribuan Indonesia dan preferensi minim gerak. Pembaca layar selalu mendapat nilai final; nominal tagihan QRIS tidak dianimasikan.
- **Artikel SEO:** halaman statis di `public/artikel/` (URL tanpa `.html`), didaftarkan di `public/artikel/index.html` dan `public/sitemap.xml`.
- **Turnstile (captcha) register/login:** aktif otomatis jika `TURNSTILE_SITE_KEY`+`TURNSTILE_SECRET_KEY` terisi; dicek SEBELUM verifikasi argon2 agar request tanpa captcha tidak bisa membakar CPU.
- **Batas ukuran body:** semua body JSON dibatasi 64 KB (`src/utils/body.ts`) — import soal admin 8 MB. Mencegah OOM isolate dari body raksasa.
- **Satu admin maksimal:** partial unique index `users(role) WHERE role='admin'` (migrasi 0005) menutup race setup bersamaan.
- **Bersih-bersih otomatis:** cron harian (03:17 WIB) menghapus session kedaluwarsa, menghapus `email_log` > 90 hari, merekonsiliasi payment pending, dan menyapu objek R2 materi yatim (unggah gagal di tengah / delete yang gagal bersih; objek < 1 jam dilewati agar tak bertabrakan dengan unggahan yang sedang berjalan).
- **Materi bacaan PDF:** byte file di R2 (`MATERI_BUCKET`, key `materi/{uuid}.pdf` immutable), metadata di D1 (`material_categories` + `materials`, migrasi 0009). Semua user login boleh membaca (tanpa langganan); admin unggah/hapus lewat `/admin/materials.html`. File di-serve HANYA lewat `GET /api/materials/:id/file` yang cek sesi (aset statis mem-bypass Worker) dengan cache `private` browser-only — cache edge tidak peduli cookie dan akan membocorkan PDF ke anonim. ETag dari (id, ukuran) + dukungan Range. Unggah = satu-satunya endpoint multipart: pre-check Content-Length 26 MB, batas 25 MB/file, validasi magic bytes `%PDF-`; jumlah halaman dihitung pdf.js di klien sebelum unggah. Pembaca `/baca.html` memakai pdf.js v4 legacy yang di-vendor di `public/js/vendor/` (perbarui: `npm i -D pdfjs-dist@<versi>` lalu salin ulang `legacy/build/pdf*.min.mjs`).
- **Batas transaksi pending:** maksimal 5 payment `pending` per user (anti-spam tulis D1).
- **Pilihan paket di halaman pembayaran:** harga dasar Rp29.000 diberi label **Paling Populer**, Rp69.000 **Paling Hemat** (tetap sesuai meski ada diskon referral).
- **Batas bayar QRIS: 24 jam** sejak transaksi dibuat (`PAKASIR_TTL_MS`). Pakasir tidak mengirim `expired_at` pada transaksinya, jadi aplikasi yang menjamin batasnya: lewat 24 jam transaksi ditandai `expired`; halaman bayar menampilkan hitungan mundur dari nilai efektif `min(expired_at gateway, dibuat+24 jam)` via `effectiveExpiryIso()`. Pembayaran manual tidak pernah auto-expire.
- **Cache edge:** `/api/products` & `/api/recent-results` 60 detik, `/api/site-stats` 3 jam — landing page ramai tidak menghantam D1. Hanya respons yang identik untuk semua pengunjung yang boleh di-cache edge (cache edge mengabaikan cookie).
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
