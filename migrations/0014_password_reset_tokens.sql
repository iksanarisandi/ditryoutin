-- Token reset password yang dikirim via email (Resend). Hanya HASH token yang
-- disimpan — token mentah hanya ada di tautan email. Sekali pakai (used_at),
-- berlaku 1 jam. Permintaan baru menghapus token lama user, jadi tabel tetap
-- ramping; sapuan cron harian membersihkan sisa yang kedaluwarsa.
CREATE TABLE password_reset_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_password_reset_tokens_user ON password_reset_tokens(user_id);
