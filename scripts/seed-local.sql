-- Seed LOKAL SAJA (jalankan via: npm run seed:local)
-- Paket demo + 10 soal contoh untuk mengetes alur ujian. Tidak untuk production.

INSERT INTO exam_packages (title, exam_type, description, duration_minutes, active)
SELECT 'UPKP Imipas Paket 1 (Demo)', 'UPKP',
       'Paket demonstrasi berisi 10 soal contoh lintas kategori. Ganti dengan soal asli via import JSON.',
       20, 1
WHERE NOT EXISTS (SELECT 1 FROM exam_packages WHERE title = 'UPKP Imipas Paket 1 (Demo)');

-- Passing grade demo: setiap kategori minimal 60
INSERT OR IGNORE INTO passing_grades (package_id, category_id, minimum_score)
SELECT p.id, c.id, 60 FROM exam_packages p, categories c
WHERE p.title = 'UPKP Imipas Paket 1 (Demo)' AND c.exam_type = 'UPKP';

WITH v(cat, question, a, b, c, d, e, ans, exp) AS (VALUES
  ('TWK', 'Pancasila pertama kali disampaikan oleh Ir. Soekarno dalam sidang BPUPKI pada tanggal...', '1 Juni 1945', '22 Juni 1945', '17 Agustus 1945', '18 Agustus 1945', '29 Mei 1945', 'A', 'Ir. Soekarno menyampaikan gagasan dasar negara dalam pidato 1 Juni 1945 di sidang BPUPKI.'),
  ('TWK', 'Semboyan Bhinneka Tunggal Ika tercantum pada...', 'Lambang negara Garuda Pancasila', 'Pasal 1 UUD 1945', 'Pembukaan UUD 1945 alinea keempat', 'Sila ketiga Pancasila', 'UUD 1945 Pasal 32', 'A', 'Semboyan tertulis pada pita yang dicengkeram Garuda Pancasila, dirancang oleh Sultan Hamid II.'),
  ('TWK', 'Konvensi hukum laut PBB yang mengakui konsep Negara Kepulauan (archipelagic state) bagi Indonesia adalah...', 'Geneva Convention 1958', 'Vienna Convention 1961', 'UNCLOS 1982', 'Montego Bay 1975', 'Tokyo Convention 1967', 'C', 'UNCLOS 1982 di Montego Bay mengakui ZEE dan konsep negara kepulauan yang diperjuangkan Indonesia melalui Djuanda Declaration 1957.'),
  ('TKT', 'Setelah pemekaran Kementerian Hukum dan HAM, bidang imigrasi dan pemasyarakatan kini dibawahi oleh...', 'Kementerian Hukum', 'Kementerian Imigrasi dan Pemasyarakatan', 'Kementerian Koordinator Bidang Hukum', 'Kementerian Dalam Negeri', 'Kementerian Keamanan Nasional', 'B', 'Kementerian Imigrasi dan Pemasyarakatan dibentuk berdasarkan Peraturan Presiden No. 191 Tahun 2024 tentang penataan kementerian lembaga negara.'),
  ('TKT', 'Gagasan bahwa pidana penjara di Indonesia diarahkan untuk membina, bukan mengeksekusi (membinasakan) narapidana, pertama kali dikemukakan oleh...', 'Prof. Baharuddin Lopa', 'Sahardjo', 'Soepomo', 'Ali Said', 'Muladi', 'B', 'Menteri Kehakiman Sahardjo (1962) menggagas falsafah pemasyarakatan yang menempatkan narapidana sebagai anggota masyarakat yang hilang kemerdekaannya sementara.'),
  ('TSI', 'Salah satu faktor penghambat integrasi nasional Indonesia adalah...', 'Semangat gotong royong', 'Kesenjangan ekonomi antardaerah', 'Sikap toleransi antarumat beragama', 'Musyawarah untuk mufakat', 'Pengamalan Pancasila', 'B', 'Kesenjangan pembangunan dan ekonomi antardaerah dapat memicu kecemburuan sosial yang melemahkan kohesi nasional.'),
  ('TSI', 'Politik luar negeri Indonesia berasaskan...', 'Bebas aktif', 'Netral pasif', 'Blok barat', 'Non-blok militan', 'Isolasi regional', 'A', 'Indonesia menganut politik luar negeri bebas aktif: bebas menentukan sikap tanpa memihak blok kekuatan mana pun, dan aktif berpartisipasi dalam perdamaian dunia.'),
  ('TSI', 'Upaya paling tepat memperkuat persatuan di tengah keberagaman budaya Indonesia adalah...', 'Memaksakan budaya daerah tertentu sebagai budaya nasional', 'Membatasi pertunjukan seni daerah', 'Memperkuat toleransi dan dialog antarbudaya', 'Menyeragamkan bahasa daerah', 'Menutup akses budaya asing sepenuhnya', 'C', 'Keberagaman dikelola dengan toleransi dan dialog sehingga menjadi perekat, bukan pemicu perpecahan.'),
  ('TKP Bahasa Inggris', 'Choose the grammatically correct sentence.', 'She have been working here for five years.', 'She has been working here for five years.', 'She has been work here for five years.', 'She is been working here for five years.', 'She are working here since five years.', 'B', 'Present perfect continuous untuk subjek "she" memakai "has been + verb-ing" dengan "for" untuk durasi.'),
  ('Literasi Digital', 'Langkah pertama yang tepat saat menerima pesan berantai berisi informasi mencurigakan adalah...', 'Segera meneruskan ke semua grup agar orang lain waspada', 'Memverifikasi kebenarannya melalui sumber resmi sebelum menyebarkan', 'Menyimpan lalu menghapus tanpa membaca', 'Mengubah sedikit isi lalu meneruskan', 'Memercayai jika dikirim oleh kerabat dekat', 'B', 'Verifikasi ke sumber resmi (situs lembaga terkait, cek fakta) mencegah penyebaran hoaks; jangan meneruskan sebelum yakin.')
)
INSERT INTO questions (package_id, category_id, question, option_a, option_b, option_c, option_d, option_e, correct_answer, explanation)
SELECT p.id, c.id, v.question, v.a, v.b, v.c, v.d, v.e, v.ans, v.exp
FROM exam_packages p, v, categories c
WHERE c.name = v.cat AND c.exam_type = 'UPKP'
  AND p.title = 'UPKP Imipas Paket 1 (Demo)'
  AND NOT EXISTS (SELECT 1 FROM questions q WHERE q.package_id = p.id);
