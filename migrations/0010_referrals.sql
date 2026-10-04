-- 0010: Program referral — kode undangan per user + ledger referral.
-- referral_code dibuat MALAS (lazy): NULL = belum dibuat; di-generate saat user
-- pertama kali meminta kartu referral (GET /api/referral). Partial unique index
-- (precedent: 0005_single_admin_index.sql) menjamin unik sambil mengizinkan
-- banyak baris NULL.

ALTER TABLE users ADD COLUMN referral_code TEXT;

CREATE UNIQUE INDEX idx_users_referral_code ON users(referral_code) WHERE referral_code IS NOT NULL;

-- Satu akun hanya bisa dihitung sebagai invitee SEKALI sepanjang masa:
-- UNIQUE(invitee_id) adalah kunci anti-abuse di level DB. Setiap baris = satu
-- hadiah +1 hari untuk referrer DAN invitee (diberikan di rute register).
CREATE TABLE referrals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  referrer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invitee_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_referrals_referrer ON referrals(referrer_id);
