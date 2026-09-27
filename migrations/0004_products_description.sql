-- Deskripsi produk akses: label psikologis per tier (coba / intensif / jangka panjang).
ALTER TABLE products ADD COLUMN description TEXT;

-- Susunan baru: hanya 3 paket aktif. Produk lama dinonaktifkan, bukan dihapus —
-- riwayat pembayaran tetap menunjuk ke nama & harga aslinya.
UPDATE products SET active=0 WHERE active=1;

INSERT INTO products (name, price, duration_days, active, description) VALUES
  ('Coba & Uji Kemampuan', 9000, 3, 1, 'Coba fitur tryout & ukur kemampuan awalmu.'),
  ('Persiapan Intensif', 29000, 30, 1, 'Pilihan untuk latihan rutin menjelang UPKP & UDIN.'),
  ('Persiapan Jangka Panjang', 69000, 180, 1, 'Akses lebih lama untuk latihan bertahap dan berulang.');
