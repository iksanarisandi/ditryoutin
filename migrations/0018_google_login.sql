-- Login dengan Google (OpenID Connect).
-- google_sub = klaim "sub" dari ID token Google (ID akun permanen; email
-- akun Google bisa berubah, sub tidak). NULL = belum pernah masuk via Google.
-- email_verified_at = kapan kepemilikan email terbukti (login Google dengan
-- email_verified=true, atau reset password lewat tautan email). NULL = belum.
ALTER TABLE users ADD COLUMN google_sub TEXT;
ALTER TABLE users ADD COLUMN email_verified_at TEXT;
CREATE UNIQUE INDEX idx_users_google_sub ON users(google_sub) WHERE google_sub IS NOT NULL;
