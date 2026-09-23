-- Seed dasar (idempotent): produk akses + kategori UPKP
INSERT OR IGNORE INTO products (name, price, duration_days, active) VALUES
  ('Akses 7 Hari', 20000, 7, 1),
  ('Akses 6 Bulan', 50000, 180, 1);

INSERT OR IGNORE INTO categories (name, exam_type, active) VALUES
  ('TWK', 'UPKP', 1),
  ('TKT', 'UPKP', 1),
  ('TSI', 'UPKP', 1),
  ('TKP Bahasa Inggris', 'UPKP', 1),
  ('Literasi Digital', 'UPKP', 1);
