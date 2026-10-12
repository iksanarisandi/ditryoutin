-- Gateway alternatif Duitku (QRIS) berdampingan dengan Pakasir.
-- 1) Kolom pembeda baris antar gateway: 'pakasir' | 'duitku' | NULL (manual).
--    txn_id untuk Duitku = referensi gateway Duitku; cek status memakai
--    reference transaksi kita (= merchantOrderId yang dikirim saat create).
-- 2) Nilai payment_mode 'pakasir' di-rename 'gateway' — setelah ada dua
--    gateway, nilai yang menyebut satu merek menyesatkan. Kode menerima
--    alias lama (parsePaymentMode) agar tab admin lama tetap aman POST.
ALTER TABLE payments ADD COLUMN gateway TEXT;
UPDATE payments SET gateway = 'pakasir' WHERE txn_id IS NOT NULL;
UPDATE settings SET value = 'gateway' WHERE key = 'payment_mode' AND value = 'pakasir';
