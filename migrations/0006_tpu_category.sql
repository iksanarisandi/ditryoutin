-- 0006: Kategori TPU dibuat untuk jenis ujian Ujian Dinas agar import soal berikutnya
-- bisa memakainya. TKT hanya ada di UPKP; TPU hanya ada di Ujian Dinas (komponen berbeda).

INSERT OR IGNORE INTO categories (name, exam_type, active) VALUES ('TPU', 'Ujian Dinas', 1);
