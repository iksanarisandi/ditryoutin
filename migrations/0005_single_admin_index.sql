-- Keamanan: menjamin maksimal SATU akun admin di database.
-- Menutup celah race dua POST /api/setup bersamaan yang sama-sama lolos
-- cek "adminExists" lalu membuat dua admin berbeda.
-- CATATAN: migrasi ini gagal jika database sudah berisi lebih dari satu admin —
-- demote/hapus admin berlebih terlebih dahulu.
CREATE UNIQUE INDEX idx_users_single_admin ON users(role) WHERE role='admin';
