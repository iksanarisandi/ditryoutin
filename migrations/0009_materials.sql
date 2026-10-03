-- 0009: Materi bacaan PDF (admin mengunggah, semua user login bisa membaca).
-- Byte file disimpan di R2 bucket "tryout-upkp-materi" (binding MATERI_BUCKET);
-- tabel ini hanya metadata. file_key = "materi/{uuid}.pdf", konten per key
-- immutable (ganti file = unggah ulang sebagai materi baru).

CREATE TABLE material_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE materials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id INTEGER NOT NULL REFERENCES material_categories(id),
  title TEXT NOT NULL,
  description TEXT,
  file_key TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  file_size INTEGER NOT NULL CHECK (file_size > 0),
  page_count INTEGER,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_materials_category ON materials(category_id);
CREATE INDEX idx_materials_created ON materials(created_at DESC);
