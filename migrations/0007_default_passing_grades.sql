-- 0007: Passing grade default per jenis ujian (tingkat 1), dalam poin (5 poin per jawaban benar).
-- UPKP: TWK 100, TKT 60, TSI 30, TKP 20 (termasuk varian TKP Bahasa Inggris).
-- Ujian Dinas: TWK 100, TPU 75, TSI 35.
-- Backfill menerapkan default ke semua paket yang sudah ada, hanya untuk kategori yang
-- dipakai soal hidup di paket itu; INSERT OR IGNORE menjaga aturan yang sudah diatur manual.
-- Catatan: ditulis satu statement per aturan (tanpa CASE / UNION ALL) karena splitter
-- migrasi wrangler salah memisah statement yang mengandung CASE...END, dan D1 menolak
-- compound SELECT dengan banyak cabang.

INSERT OR IGNORE INTO passing_grades (package_id, category_id, minimum_score)
SELECT DISTINCT p.id, c.id, 100 FROM exam_packages p
JOIN questions q ON q.package_id = p.id AND q.deleted_at IS NULL
JOIN categories c ON c.id = q.category_id
WHERE upper(p.exam_type) LIKE '%UJIAN%DINAS%' AND c.name = 'TWK';

INSERT OR IGNORE INTO passing_grades (package_id, category_id, minimum_score)
SELECT DISTINCT p.id, c.id, 75 FROM exam_packages p
JOIN questions q ON q.package_id = p.id AND q.deleted_at IS NULL
JOIN categories c ON c.id = q.category_id
WHERE upper(p.exam_type) LIKE '%UJIAN%DINAS%' AND c.name = 'TPU';

INSERT OR IGNORE INTO passing_grades (package_id, category_id, minimum_score)
SELECT DISTINCT p.id, c.id, 35 FROM exam_packages p
JOIN questions q ON q.package_id = p.id AND q.deleted_at IS NULL
JOIN categories c ON c.id = q.category_id
WHERE upper(p.exam_type) LIKE '%UJIAN%DINAS%' AND c.name = 'TSI';

INSERT OR IGNORE INTO passing_grades (package_id, category_id, minimum_score)
SELECT DISTINCT p.id, c.id, 100 FROM exam_packages p
JOIN questions q ON q.package_id = p.id AND q.deleted_at IS NULL
JOIN categories c ON c.id = q.category_id
WHERE upper(p.exam_type) NOT LIKE '%UJIAN%DINAS%' AND c.name = 'TWK';

INSERT OR IGNORE INTO passing_grades (package_id, category_id, minimum_score)
SELECT DISTINCT p.id, c.id, 60 FROM exam_packages p
JOIN questions q ON q.package_id = p.id AND q.deleted_at IS NULL
JOIN categories c ON c.id = q.category_id
WHERE upper(p.exam_type) NOT LIKE '%UJIAN%DINAS%' AND c.name = 'TKT';

INSERT OR IGNORE INTO passing_grades (package_id, category_id, minimum_score)
SELECT DISTINCT p.id, c.id, 30 FROM exam_packages p
JOIN questions q ON q.package_id = p.id AND q.deleted_at IS NULL
JOIN categories c ON c.id = q.category_id
WHERE upper(p.exam_type) NOT LIKE '%UJIAN%DINAS%' AND c.name = 'TSI';

INSERT OR IGNORE INTO passing_grades (package_id, category_id, minimum_score)
SELECT DISTINCT p.id, c.id, 20 FROM exam_packages p
JOIN questions q ON q.package_id = p.id AND q.deleted_at IS NULL
JOIN categories c ON c.id = q.category_id
WHERE upper(p.exam_type) NOT LIKE '%UJIAN%DINAS%' AND c.name LIKE 'TKP%';
