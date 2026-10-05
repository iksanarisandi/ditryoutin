-- Urutan kategori saat mengerjakan ujian: seperti CAT BKN asli, kategori tampil
-- berkelompok dan berurutan (semua TWK dulu, lalu TKT, dst.) — soal tetap
-- diacak DI DALAM kategorinya per attempt (lihat routes/attempts.ts).
-- Kategori baru default 100 = tampil setelah kategori bawaan; urutan antar
-- kategori dengan sort_order sama ditentukan alfabetis nama.

ALTER TABLE categories ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 100;

-- UPKP Imipas: TWK, TKT, TSI, TKP Bahasa Inggris, Literasi Digital
UPDATE categories SET sort_order = 1 WHERE name = 'TWK';
UPDATE categories SET sort_order = 2 WHERE exam_type = 'UPKP' AND name = 'TKT';
UPDATE categories SET sort_order = 3 WHERE name = 'TSI';
UPDATE categories SET sort_order = 4 WHERE exam_type = 'UPKP' AND name LIKE 'TKP%';
UPDATE categories SET sort_order = 5 WHERE name = 'Literasi Digital';

-- Ujian Dinas: TWK, TPU, TSI
UPDATE categories SET sort_order = 2 WHERE exam_type = 'Ujian Dinas' AND name = 'TPU';
