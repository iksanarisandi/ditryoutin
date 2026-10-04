-- 0011: Model referal berubah — hadiah pengundang tidak lagi keluar saat
-- pendaftaran, melainkan saat transaksi PERTAMA invitee lunas (anti-abuse:
-- setiap hadiah selalu didahului uang masuk). Yang diundang tetap tidak
-- dibayar-bayari di muka; keuntungannya pindah ke diskon pembelian pertama
-- (diterapkan di rute payments/create).
--
-- rewarded_at NULL = transaksi pertama invitee belum lunas (hadiah menunggu).
-- Baris lama (model daftar-versi-lama) SUDAH dihadiahkan +1 hari saat register
-- -> backfill agar claim baru tidak memberi +3 hari lagi (tidak dobel).

ALTER TABLE referrals ADD COLUMN rewarded_at TEXT;

UPDATE referrals SET rewarded_at = created_at WHERE rewarded_at IS NULL;
