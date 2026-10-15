-- Log email keluar (Resend). Tiga fungsi sekaligus:
-- 1) penjaga kuota harian — kuota Resend dipakai bersama semua jenis email,
--    jadi email prioritas rendah (sambutan) berhenti dulu sebelum kuota habis
--    agar reset password & bukti bayar tetap terkirim;
-- 2) anti-dobel — satu email per (jenis, payment) lewat unique index parsial;
-- 3) audit (status sending/sent/failed).
-- Sengaja tanpa FOREIGN KEY: log tidak boleh menghalangi penghapusan data lain.
CREATE TABLE email_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  user_id INTEGER,
  payment_id INTEGER,
  status TEXT NOT NULL DEFAULT 'sending',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE UNIQUE INDEX idx_email_log_kind_payment ON email_log(kind, payment_id) WHERE payment_id IS NOT NULL;
CREATE INDEX idx_email_log_created_at ON email_log(created_at);
CREATE INDEX idx_email_log_user_kind ON email_log(user_id, kind);

-- Cron pengingat (tiap 15 menit) memilih payment per status + rentang umur;
-- tanpa ini seluruh histori status 'expired' dipindai tiap run.
CREATE INDEX idx_payments_status_created ON payments(status, created_at);
