import { Hono } from 'hono';
import { fail, ok } from '../../utils/response';
import { requireAdmin } from '../../middleware/auth';
import { clamp, toInt, trimStr } from '../../utils/validate';
import { readJson } from '../../utils/body';
import type { AppEnv } from '../../types';

// Materi bacaan PDF: byte file di R2 (MATERI_BUCKET), metadata di D1.
// Unggah = satu-satunya endpoint multipart di aplikasi (lihat POST / di bawah).

// Batas ukuran file PDF per unggah (25 MB) + margin field form → 26 MB body.
export const MAX_MATERIAL_FILE_SIZE = 25 * 1024 * 1024;
const MAX_UPLOAD_BODY = MAX_MATERIAL_FILE_SIZE + 1024 * 1024;

// Header "%PDF-" boleh didahului sedikit byte sampah pada PDF hasil ekspor
// aneh — pindai 1 KB pertama, bukan cek offset 0 mentah.
function looksLikePdf(buf: ArrayBuffer): boolean {
  const n = Math.min(buf.byteLength, 1024);
  const b = new Uint8Array(buf, 0, n);
  for (let i = 0; i + 4 < n; i++) {
    if (b[i] === 0x25 && b[i + 1] === 0x50 && b[i + 2] === 0x44 && b[i + 3] === 0x46 && b[i + 4] === 0x2d) {
      return true; // %PDF-
    }
  }
  return false;
}

// Nama file asli hanya dipakai untuk nama unduhan (Content-Disposition),
// tidak pernah untuk key R2 atau path mana pun — bersihkan karakter berbahaya.
function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const clean = base
    .replace(/[\r\n"\\]/g, '')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .trim()
    .slice(0, 200);
  return clean || 'materi.pdf';
}

// ===================== KATEGORI MATERI =====================
// Kategori khusus materi (terpisah dari kategori soal TWK/TKT/…).
const adminMaterialCategories = new Hono<AppEnv>();
adminMaterialCategories.use('*', requireAdmin);

adminMaterialCategories.get('/', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT c.*, (SELECT COUNT(*) FROM materials m WHERE m.category_id=c.id) AS material_count
     FROM material_categories c ORDER BY c.name`,
  ).all();
  return ok(c, { categories: rows.results ?? [] });
});

adminMaterialCategories.post('/', async (c) => {
  const body = await readJson(c);
  if (!body) return fail(c, 'Body tidak valid');
  const name = trimStr(body.name, 100);
  const active = body.active === undefined ? 1 : body.active ? 1 : 0;
  if (!name) return fail(c, 'Nama kategori wajib diisi', 422);
  try {
    const res = await c.env.DB.prepare('INSERT INTO material_categories (name, active) VALUES (?, ?)')
      .bind(name, active)
      .run();
    return ok(c, { id: Number(res.meta.last_row_id) }, 201);
  } catch (e) {
    if (String(e).includes('UNIQUE')) return fail(c, 'Kategori dengan nama tersebut sudah ada', 409);
    throw e;
  }
});

adminMaterialCategories.put('/:id', async (c) => {
  const id = toInt(c.req.param('id'), 0);
  const body = await readJson(c);
  if (!body) return fail(c, 'Body tidak valid');
  const name = trimStr(body.name, 100);
  const active = body.active === undefined ? 1 : body.active ? 1 : 0;
  if (!name) return fail(c, 'Nama kategori wajib diisi', 422);
  try {
    const res = await c.env.DB.prepare('UPDATE material_categories SET name=?, active=?, updated_at=? WHERE id=?')
      .bind(name, active, new Date().toISOString(), id)
      .run();
    if (!res.meta.changes) return fail(c, 'Kategori tidak ditemukan', 404);
    return ok(c, { updated: true });
  } catch (e) {
    if (String(e).includes('UNIQUE')) return fail(c, 'Kategori dengan nama tersebut sudah ada', 409);
    throw e;
  }
});

adminMaterialCategories.delete('/:id', async (c) => {
  const id = toInt(c.req.param('id'), 0);
  const used = await c.env.DB.prepare('SELECT id FROM materials WHERE category_id=? LIMIT 1')
    .bind(id)
    .first();
  if (used) return fail(c, 'Kategori masih dipakai materi. Pindahkan atau hapus materinya dulu.', 409);
  const res = await c.env.DB.prepare('DELETE FROM material_categories WHERE id=?').bind(id).run();
  if (!res.meta.changes) return fail(c, 'Kategori tidak ditemukan', 404);
  return ok(c, { deleted: true });
});

// ===================== MATERI =====================
const adminMaterials = new Hono<AppEnv>();
adminMaterials.use('*', requireAdmin);

adminMaterials.get('/', async (c) => {
  const categoryId = toInt(c.req.query('category_id'), 0);
  const q = trimStr(c.req.query('q'), 100);
  const page = clamp(toInt(c.req.query('page'), 1), 1, 10000);
  const per = 20;

  const conds: string[] = [];
  const binds: unknown[] = [];
  if (categoryId > 0) {
    conds.push('m.category_id=?');
    binds.push(categoryId);
  }
  if (q) {
    conds.push('(m.title LIKE ? OR m.description LIKE ?)');
    binds.push(`%${q}%`, `%${q}%`);
  }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';

  const totalRow = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM materials m ${where}`)
    .bind(...binds)
    .first<{ n: number }>();
  const rows = await c.env.DB.prepare(
    `SELECT m.*, c.name AS category_name
     FROM materials m JOIN material_categories c ON c.id=m.category_id
     ${where} ORDER BY m.id DESC LIMIT ? OFFSET ?`,
  )
    .bind(...binds, per, (page - 1) * per)
    .all();
  const cats = await c.env.DB.prepare(
    'SELECT id, name, active FROM material_categories ORDER BY name',
  ).all();
  return ok(c, {
    materials: rows.results ?? [],
    total: totalRow?.n ?? 0,
    page,
    per_page: per,
    categories: cats.results ?? [],
  });
});

// Unggah materi — multipart/form-data: title, description, category_id,
// pages (opsional, hasil hitung pdf.js di klien), file (PDF ≤ 25 MB).
adminMaterials.post('/', async (c) => {
  // Tolak body oversized SEBELUM buffering (parseBody mem-buffer seluruh body).
  const cl = parseInt(c.req.header('content-length') ?? '', 10);
  if (Number.isFinite(cl) && cl > MAX_UPLOAD_BODY) {
    return fail(c, 'Ukuran file melebihi batas 25 MB', 413);
  }

  let body: Record<string, string | File>;
  try {
    body = await c.req.parseBody();
  } catch {
    return fail(c, 'Body tidak valid');
  }

  const title = trimStr(body['title'], 200);
  if (!title) return fail(c, 'Judul wajib diisi', 422);
  const description = trimStr(body['description'], 1000);
  const categoryId = toInt(body['category_id'], 0);
  const cat = await c.env.DB.prepare('SELECT id FROM material_categories WHERE id=?')
    .bind(categoryId)
    .first();
  if (!cat) return fail(c, 'Kategori tidak ditemukan', 422);
  const pages = clamp(toInt(body['pages'], 0), 0, 50000);

  const file = body['file'];
  if (!(file instanceof File)) return fail(c, 'File PDF wajib dilampirkan', 422);
  if (file.size > MAX_MATERIAL_FILE_SIZE) return fail(c, 'Ukuran file melebihi batas 25 MB', 413);
  const buf = await file.arrayBuffer();
  if (!looksLikePdf(buf)) return fail(c, 'File bukan PDF valid', 422);

  // Key UUID: konten per key immutable, bebas kolisi & injeksi nama file.
  const key = 'materi/' + crypto.randomUUID() + '.pdf';
  await c.env.MATERI_BUCKET.put(key, buf, { httpMetadata: { contentType: 'application/pdf' } });

  try {
    const res = await c.env.DB.prepare(
      `INSERT INTO materials (category_id, title, description, file_key, original_filename, file_size, page_count)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(categoryId, title, description, key, sanitizeFilename(file.name), file.size, pages > 0 ? pages : null)
      .run();
    return ok(c, { id: Number(res.meta.last_row_id) }, 201);
  } catch (e) {
    // Baris gagal masuk DB — hapus objek R2 yang barusan diunggah agar tidak yatim.
    c.executionCtx.waitUntil(c.env.MATERI_BUCKET.delete(key).catch(() => {}));
    throw e;
  }
});

// Ubah metadata saja (ganti file = hapus lalu unggah ulang).
adminMaterials.put('/:id', async (c) => {
  const id = toInt(c.req.param('id'), 0);
  const body = await readJson(c);
  if (!body) return fail(c, 'Body tidak valid');
  const title = trimStr(body.title, 200);
  if (!title) return fail(c, 'Judul wajib diisi', 422);
  const description = trimStr(body.description, 1000);
  const categoryId = toInt(body.category_id, 0);
  const cat = await c.env.DB.prepare('SELECT id FROM material_categories WHERE id=?')
    .bind(categoryId)
    .first();
  if (!cat) return fail(c, 'Kategori tidak ditemukan', 422);
  const active = body.active === undefined ? 1 : body.active ? 1 : 0;

  const res = await c.env.DB.prepare(
    'UPDATE materials SET title=?, description=?, category_id=?, active=?, updated_at=? WHERE id=?',
  )
    .bind(title, description, categoryId, active, new Date().toISOString(), id)
    .run();
  if (!res.meta.changes) return fail(c, 'Materi tidak ditemukan', 404);
  return ok(c, { updated: true });
});

adminMaterials.delete('/:id', async (c) => {
  const id = toInt(c.req.param('id'), 0);
  const row = await c.env.DB.prepare('SELECT file_key FROM materials WHERE id=?')
    .bind(id)
    .first<{ file_key: string }>();
  if (!row) return fail(c, 'Materi tidak ditemukan', 404);
  await c.env.DB.prepare('DELETE FROM materials WHERE id=?').bind(id).run();
  try {
    // Hapus key yang tak ada adalah no-op di R2 — aman meski race dengan cron.
    await c.env.MATERI_BUCKET.delete(row.file_key);
  } catch (e) {
    // Gagal membersihkan R2 bukan berarti gagal hapus — objek yatim disapu cron harian.
    console.error('[materi] pembersihan R2 gagal untuk', row.file_key, e);
  }
  return ok(c, { deleted: true });
});

export { adminMaterials, adminMaterialCategories };
