# Skema Database (D1) — Tryout UPKP

Database: `tryout-upkp-db` (binding `DB`, SQLite di Cloudflare D1). Raw SQL tanpa ORM. Sumber kebenaran skema = `migrations/*.sql` (berurutan). Dokumen ini adalah ringkasan; bila ragu, baca migrasinya.

## Aturan umum

- **Timestamp**: TEXT ISO-8601 UTC `YYYY-MM-DDTHH:MM:SS.sssZ` — di kode selalu `new Date().toISOString()`, default kolom `strftime('%Y-%m-%dT%H:%M:%fZ','now')`. Lebar tetap → perbandingan string = perbandingan waktu (dipakai di `WHERE expires_at > ?`). Jangan menulis format lain.
- **Boolean**: INTEGER 0/1 (`active`, `passed`, `marked_review`, `is_correct`, `auto_submitted`).
- **Uang**: INTEGER rupiah utuh (tanpa sen).
- **Hapus**: data yang direferensikan histori tidak dihapus — `questions` soft delete (`deleted_at`), produk/paket/kategori dinonaktifkan (`active=0`); endpoint DELETE menolak (409) bila sudah punya histori.
- **Skor**: poin, 5 per jawaban benar (`POINTS_PER_CORRECT`); maksimum = jumlah soal × 5.

## Tabel

### `users`
Akun peserta & admin.

| Kolom | Catatan |
|---|---|
| `email` | UNIQUE, dinormalisasi lowercase |
| `password_hash` | Argon2id (`src/utils/hash.ts`) |
| `role` | `'user' \| 'admin'` — partial unique index `idx_users_single_admin` = maks 1 admin |
| `access_expires_at` | Batas akses tryout; NULL = belum pernah beli. Akses aktif ⇔ > sekarang |
| `access_started_at` | Awal periode akses berjalan (direset bila akses sempat habis) |
| `failed_attempts`, `locked_until` | Lockout login (5 gagal → 15 menit) |
| `referral_code` | Dibuat malas saat `GET /api/referral`; unique bila tidak NULL |

### `sessions`
Satu baris per login. `token_hash` = HMAC-SHA256(token, `SESSION_SECRET`) — token mentah hanya di cookie. TTL 30 hari. Login baru menghapus sesi lama user (satu perangkat). Cron harian menghapus yang kedaluwarsa.

### `password_reset_tokens`
Token reset (hash saja), berlaku 1 jam, sekali pakai (`used_at`). Permintaan baru menghapus token lama user; cron menyapu yang kedaluwarsa.

### `products`
Produk = **paket masa akses** (bukan paket soal): `name`, `price`, `duration_days`, `description`, `active`. Diubah via panel admin, bukan migrasi.

### `payments`

| Kolom | Catatan |
|---|---|
| `reference` | UNIQUE, format `TO-<base36 waktu>-<acak>`; = `order_id` Pakasir / `merchantOrderId` Duitku |
| `txn_id` | ID transaksi di gateway (Pakasir txn_id / Duitku `reference`); NULL = manual atau gagal create |
| `gateway` | `'pakasir' \| 'duitku' \| NULL` (NULL = manual / baris lama tanpa gateway) |
| `method` | `'qris' \| 'manual'` |
| `amount` | Harga dasar yang ditagihkan aplikasi (harga produk, setelah diskon referral) |
| `total_payment`, `fee` | Nominal yang DIBAYAR pembeli & selisih fee gateway (Duitku: gross-up `DUITKU_FEE_PCT`) |
| `qr_string`, `payment_url`, `expires_at` | Snapshot respons gateway (halaman bayar tidak memanggil API ulang) |
| `status` | `pending → paid \| expired \| failed`. `paid` hanya lewat `settlePayment()` (idempoten) |
| `paid_at` | Waktu lunas — dasar laporan pendapatan per tanggal |

Batas: maks 5 `pending` per user. Pending gateway kedaluwarsa (Duitku 30 menit, Pakasir/umum 24 jam); pending manual tidak pernah auto-expire.

### `exam_packages`
Paket soal tryout: `title`, `exam_type` (`'UPKP'`, `'Ujian Dinas'`, …), `duration_minutes` (1–600), `active`, `passing_grade_total` (poin, opsional).

### `categories`
Kategori soal per `exam_type` (UNIQUE `(name, exam_type)`), `sort_order` = urutan tampil saat ujian (TWK=1, TKT/TPU=2, TSI=3, TKP=4, Literasi Digital=5, baru=100).

### `questions`
Soal pilihan ganda A–E milik satu paket & kategori. `correct_answer` & `explanation` RAHASIA sampai attempt submit. `deleted_at` = soft delete (semua query peserta memfilter `deleted_at IS NULL`).

### `passing_grades`
Aturan minimal skor per (paket, kategori) dalam poin (0–1000). Prioritas kelulusan: aturan kategori (semua yang muncul di attempt harus terpenuhi) → `passing_grade_total` paket → tanpa status (`passed` NULL). Default per jenis ujian: `src/services/passing-grades.ts`.

### `attempts`

| Kolom | Catatan |
|---|---|
| `status` | `'in_progress' \| 'submitted' \| 'expired'` (praktiknya: in_progress → submitted; waktu habis = auto-submit) |
| `expires_at` | `started_at + duration_minutes`. Attempt kedaluwarsa difinalisasi **malas** saat pemiliknya memanggil `/me`, `/attempts/*` — bukan oleh cron, jadi bisa tetap `in_progress` bila user tidak kembali |
| `score`, `correct_count`, `wrong_count`, `unanswered_count`, `passed`, `duration_seconds` | Diisi saat submit (immutable) |
| `category_scores` | JSON array `[{ category_id, name, correct, wrong, unanswered, total, score, max_score }]` |
| `auto_submitted` | 1 bila disubmit karena waktu habis |

Satu user hanya boleh punya satu attempt `in_progress`.

### `attempt_questions`
Snapshot urutan soal per attempt (UNIQUE `(attempt_id, question_order)`): `user_answer` (A–E/NULL), `marked_review` (ragu-ragu), `is_correct` (dibekukan saat submit). Tabel terbesar (~93 baris per attempt).

### `referrals`
Ledger undangan: `referrer_id`, `invitee_id` (UNIQUE — satu akun hanya sekali jadi invitee), `rewarded_at` (NULL = transaksi pertama invitee belum lunas). Invitee: diskon 10% pembelian pertama yang lunas; referrer: +3 hari saat itu terjadi (`claimReferralReward` di `settlePayment`).

### `settings`
Key-value runtime yang diubah dari panel admin tanpa deploy; **menimpa env vars**.

| key | value |
|---|---|
| `payment_mode` | `gateway` \| `hybrid` \| `manual` (alias lama `pakasir` = `gateway`) |
| `active_gateway` | `pakasir` \| `duitku` |

### `email_log`
Log email keluar via Resend (migrasi 0017). Tanpa foreign key — log tidak boleh menghalangi penghapusan data lain.

| Kolom | Catatan |
|---|---|
| `kind` | `'reset' \| 'welcome' \| 'receipt' \| 'reminder'` |
| `user_id`, `payment_id` | Penerima & transaksi terkait (`payment_id` NULL untuk reset/sambutan) |
| `status` | `sending → sent \| failed`. `failed` tidak dihitung ke kuota dan tidak di-retry |
| `created_at` | Dasar penjaga kuota rolling 24 jam (`EMAIL_DAILY_LIMIT`) |

Unique index parsial `(kind, payment_id) WHERE payment_id IS NOT NULL` = maks satu bukti bayar/pengingat per transaksi. Cron harian menghapus baris > 90 hari.

### `material_categories`, `materials`
Metadata materi PDF; byte file di R2 `MATERI_BUCKET` dengan key `materi/{uuid}.pdf` (immutable — ganti file = unggah materi baru). `file_size`, `page_count` (dihitung pdf.js di klien).

## Index penting

| Index | Untuk |
|---|---|
| `idx_attempts_user_status_package` | Semua query "attempt milik user" (dashboard, riwayat, finalisasi malas) |
| `idx_attempts_status` | Hitung attempt per status (dashboard admin) |
| `idx_questions_package_id`, `idx_questions_category_id` | Soal per paket/kategori |
| `idx_payments_user_id`, `idx_payments_status` | Pending per user, statistik |
| `idx_payments_status_created` | Cron pengingat belum bayar (status + rentang umur) |
| `idx_email_log_kind_payment` (unique parsial), `idx_email_log_created_at`, `idx_email_log_user_kind` | Anti-dobel email, kuota harian, batas pengingat per user |
| `idx_sessions_expires_at`, `idx_users_access_expires_at` | Cron & statistik akses |
| `idx_users_single_admin`, `idx_users_referral_code` | Partial unique (lihat atas) |

## Migrasi

| File | Isi |
|---|---|
| `0001_initial` | Tabel inti |
| `0002_indexes` | Index dasar |
| `0003_seed` | Produk awal + kategori UPKP |
| `0004_products_description` | `products.description` + susunan 3 produk |
| `0004_scoring_points` | Skor persen → poin, `passing_grade_total`, rebuild `passing_grades` |
| `0005_single_admin_index` | Maks satu admin |
| `0006_tpu_category` | Kategori TPU (Ujian Dinas) |
| `0007_default_passing_grades` | Backfill PG default |
| `0008_attempt_indexes` | Index komposit attempt, hapus index kembar |
| `0009_materials` | Materi PDF |
| `0010_referrals`, `0011_referral_on_payment` | Referral (hadiah saat lunas) |
| `0012_settings` | Tabel settings |
| `0013_category_sort_order` | Urutan kategori ujian |
| `0014_password_reset_tokens` | Reset password via email |
| `0015_payments_gateway_and_mode` | `payments.gateway`, rename mode `pakasir` → `gateway` |
| `0016_payments_payment_url` | `payments.payment_url` (Duitku) |
| `0017_email_log` | Tabel `email_log` (kuota & anti-dobel email notifikasi) + index `payments(status, created_at)` |

Catatan: ada **dua file bernomor `0004`** (sejarah) — wrangler melacak migrasi per nama file di tabel `d1_migrations`, jadi keduanya sudah diterapkan dan tidak boleh di-rename. Migrasi berikutnya: `0018_…`.

Aturan menulis migrasi:
- Selalu file baru; jangan mengedit migrasi yang sudah diterapkan (komentar lama di dalamnya boleh tertinggal — mis. `0012` masih menyebut mode `pakasir`).
- Hindari `CASE … END` dan compound `SELECT` panjang (splitter migrasi wrangler/D1 bermasalah); tulis satu statement per aturan.
- Ubah `CHECK` constraint = rebuild tabel (buat `_new`, salin, drop, rename, buat ulang index) seperti `0004_scoring_points`.
- Seed data produksi idempoten (`INSERT OR IGNORE`, `WHERE NOT EXISTS`).
- Lokal: `npm run db:local`; produksi: `npm run db:remote` (setelah persetujuan user; Time Travel D1 = jaring pengaman 30 hari).
