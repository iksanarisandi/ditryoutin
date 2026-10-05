-- Pengaturan runtime yang bisa diubah dari panel admin tanpa deploy ulang.
-- Saat ini dipakai untuk: payment_mode (pakasir | hybrid | manual) — toggle
-- di Admin → Transaksi. Nilai di sini menimpa env var PAYMENT_MODE /
-- SHOW_MANUAL_PAYMENT (env menjadi baseline default sebelum di-toggle).
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
