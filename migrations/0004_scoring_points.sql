-- 0004: Skor poin (5 per jawaban benar) + passing grade total paket.
-- Skor attempt berubah makna: dari persen (0-100) menjadi poin (correct x 5).
-- Data lama dikonversi: poin = persen x jumlah soal x 5 / 100.

ALTER TABLE exam_packages ADD COLUMN passing_grade_total REAL;

-- minimum_score kini dalam poin (kategori >20 soal bisa >100 poin) -> rebuild tabel
-- karena CHECK lama membatasi 0-100.
CREATE TABLE passing_grades_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  package_id INTEGER NOT NULL REFERENCES exam_packages(id) ON DELETE CASCADE,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  minimum_score REAL NOT NULL CHECK (minimum_score >= 0 AND minimum_score <= 1000),
  UNIQUE (package_id, category_id)
);

-- Konversi aturan lama (persen -> poin) memakai jumlah soal live per kategori.
INSERT INTO passing_grades_new (package_id, category_id, minimum_score)
SELECT pg.package_id, pg.category_id,
       ROUND(pg.minimum_score * 5 * (SELECT COUNT(*) FROM questions q
         WHERE q.package_id = pg.package_id AND q.category_id = pg.category_id
           AND q.deleted_at IS NULL) / 100.0, 1)
FROM passing_grades pg;

DROP TABLE passing_grades;
ALTER TABLE passing_grades_new RENAME TO passing_grades;
CREATE INDEX idx_passing_grades_package_id ON passing_grades(package_id);

-- Konversi skor attempt lama (persen -> poin). Riwayat tetap konsisten
-- dengan hasil baru yang dihitung langsung sebagai correct x 5.
UPDATE attempts SET score = ROUND(score * (correct_count + wrong_count + unanswered_count) * 5 / 100.0, 1)
WHERE status = 'submitted' AND score IS NOT NULL;
