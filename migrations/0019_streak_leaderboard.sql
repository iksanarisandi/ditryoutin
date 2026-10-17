-- Day streak + leaderboard.
-- streak_last_day = tanggal WITA (YYYY-MM-DD) aktivitas terakhir yang dihitung
-- (submit tryout / buka materi). Sengaja tanggal lokal, bukan ISO UTC: batas
-- hari streak = 00:00 WITA, dan perbandingan string YYYY-MM-DD = urutan tanggal.
-- streak_current disimpan apa adanya; putus/tidaknya dihitung saat dibaca
-- (last_day < kemarin = 0) sehingga tidak butuh cron.
ALTER TABLE users ADD COLUMN streak_current INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN streak_best INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN streak_last_day TEXT;

-- 1 = nama peserta disamarkan ("Peserta") di papan peringkat; posisinya tetap dihitung.
ALTER TABLE users ADD COLUMN leaderboard_hidden INTEGER NOT NULL DEFAULT 0;

-- Peringkat per paket (percobaan pertama tiap peserta di satu paket):
-- WHERE package_id=? AND status='submitted' GROUP BY user_id → covering index.
-- Index tunggal lama (package_id) tercakup prefix index baru → dihapus agar
-- tidak menambah biaya tulis tiap INSERT/UPDATE attempt.
CREATE INDEX idx_attempts_package_status_user ON attempts(package_id, status, user_id);
DROP INDEX IF EXISTS idx_attempts_package_id;
