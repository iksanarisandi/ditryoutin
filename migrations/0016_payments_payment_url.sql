-- Simpan paymentUrl Duitku (halaman bayar/simulator) agar link tetap ada
-- setelah refresh halaman — di sandbox ini satu-satunya cara "membayar"
-- (QR sandbox tidak bisa discan aplikasi nyata).
ALTER TABLE payments ADD COLUMN payment_url TEXT;
