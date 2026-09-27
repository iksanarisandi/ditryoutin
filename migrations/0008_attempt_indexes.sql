-- Optimasi index (audit skala 2026-09): lookup riwayat attempt per user
-- dan hapus index kembar yang menambah biaya tulis tiap autosave.

-- 1) Index komposit untuk semua query "attempt milik user ini":
--    dashboard /api/packages (6 subquery per paket, filter user+status+package),
--    /api/results (user+submitted, urut submitted_at), /api/attempts/active,
--    dan finalize malas (user+in_progress). Index tunggal lama (user_id saja)
--    membuat SQLite memindai seluruh riwayat user; prefix (user_id, status)
--    index ini langsung menutup query-query itu, kolom package_id menyempitkan
--    subquery dashboard lebih jauh.
CREATE INDEX idx_attempts_user_status_package ON attempts(user_id, status, package_id);

-- 2) Index kembar: kolomnya SAMA PERSIS dengan UNIQUE(attempt_id, question_order)
--    (skema awal) yang otomatis membuat index internal SQLite sendiri. Index ini
--    hanya menambah satu entri tulis di setiap INSERT attempt_questions (mulai
--    ujian) tanpa bisa dipilih planner lebih baik dari unique index-nya.
--    Aman dihapus: tidak ada query yang menunjuknya (tanpa INDEXED BY).
DROP INDEX idx_attempt_questions_attempt_id;
