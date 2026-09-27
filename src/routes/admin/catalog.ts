import { Hono } from 'hono';
import { fail, ok } from '../../utils/response';
import { requireAdmin } from '../../middleware/auth';
import { clamp, toInt, trimStr } from '../../utils/validate';
import { readJson } from '../../utils/body';
import type { AppEnv } from '../../types';

// ===================== PRODUK AKSES =====================
const adminProducts = new Hono<AppEnv>();
adminProducts.use('*', requireAdmin);

adminProducts.get('/', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT p.*, (SELECT COUNT(*) FROM payments pm WHERE pm.product_id=p.id AND pm.status='paid') AS paid_count
     FROM products p ORDER BY p.price`,
  ).all();
  return ok(c, { products: rows.results ?? [] });
});

function productInput(body: Record<string, unknown>) {
  const name = trimStr(body.name, 100);
  const price = clamp(toInt(body.price, -1), 0, 100000000);
  const durationDays = clamp(toInt(body.duration_days, 0), 1, 3650);
  const description = trimStr(body.description, 200);
  const active = body.active === undefined ? 1 : body.active ? 1 : 0;
  return { name, price, durationDays, description, active };
}

adminProducts.post('/', async (c) => {
  const body = await readJson(c);
  if (!body) return fail(c, 'Body tidak valid');
  const { name, price, durationDays, description, active } = productInput(body);
  if (!name) return fail(c, 'Nama produk wajib diisi', 422);
  if (price < 0) return fail(c, 'Harga tidak valid', 422);

  const res = await c.env.DB.prepare(
    'INSERT INTO products (name, price, duration_days, description, active) VALUES (?, ?, ?, ?, ?)',
  )
    .bind(name, price, durationDays, description, active)
    .run();
  return ok(c, { id: Number(res.meta.last_row_id) }, 201);
});

adminProducts.put('/:id', async (c) => {
  const id = toInt(c.req.param('id'), 0);
  const body = await readJson(c);
  if (!body) return fail(c, 'Body tidak valid');
  const { name, price, durationDays, description, active } = productInput(body);
  if (!name) return fail(c, 'Nama produk wajib diisi', 422);
  if (price < 0) return fail(c, 'Harga tidak valid', 422);

  const res = await c.env.DB.prepare(
    'UPDATE products SET name=?, price=?, duration_days=?, description=?, active=?, updated_at=? WHERE id=?',
  )
    .bind(name, price, durationDays, description, active, new Date().toISOString(), id)
    .run();
  if (!res.meta.changes) return fail(c, 'Produk tidak ditemukan', 404);
  return ok(c, { updated: true });
});

adminProducts.delete('/:id', async (c) => {
  const id = toInt(c.req.param('id'), 0);
  const used = await c.env.DB.prepare('SELECT id FROM payments WHERE product_id=? LIMIT 1')
    .bind(id)
    .first();
  if (used) return fail(c, 'Produk memiliki riwayat transaksi. Nonaktifkan saja.', 409);
  const res = await c.env.DB.prepare('DELETE FROM products WHERE id=?').bind(id).run();
  if (!res.meta.changes) return fail(c, 'Produk tidak ditemukan', 404);
  return ok(c, { deleted: true });
});

// ===================== PAKET TRYOUT =====================
const adminPackages = new Hono<AppEnv>();
adminPackages.use('*', requireAdmin);

adminPackages.get('/', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT p.*,
       (SELECT COUNT(*) FROM questions q WHERE q.package_id=p.id AND q.deleted_at IS NULL) AS question_count,
       (SELECT COUNT(*) FROM attempts a WHERE a.package_id=p.id) AS attempt_count
     FROM exam_packages p ORDER BY p.id`,
  ).all();
  return ok(c, { packages: rows.results ?? [] });
});

// Passing grade total (poin): null = tanpa PG total (dipakai hanya jika tidak ada PG kategori).
function parsePassingGradeTotal(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return -1; // penanda invalid
  return Math.round(Math.min(n, 5000) * 10) / 10;
}

function packageInput(body: Record<string, unknown>) {
  const title = trimStr(body.title, 200);
  const examType = trimStr(body.exam_type, 50) ?? 'UPKP';
  const description = trimStr(body.description, 1000);
  const durationMinutes = clamp(toInt(body.duration_minutes, 0), 1, 600);
  const active = body.active === undefined ? 1 : body.active ? 1 : 0;
  const passingGradeTotal = parsePassingGradeTotal(body.passing_grade_total);
  return { title, examType, description, durationMinutes, active, passingGradeTotal };
}

adminPackages.post('/', async (c) => {
  const body = await readJson(c);
  if (!body) return fail(c, 'Body tidak valid');
  const { title, examType, description, durationMinutes, active, passingGradeTotal } = packageInput(body);
  if (!title) return fail(c, 'Nama paket wajib diisi', 422);
  if (passingGradeTotal === -1) return fail(c, 'Passing grade total harus angka 0-5000', 422);

  const res = await c.env.DB.prepare(
    'INSERT INTO exam_packages (title, exam_type, description, duration_minutes, active, passing_grade_total) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(title, examType, description, durationMinutes, active, passingGradeTotal)
    .run();
  return ok(c, { id: Number(res.meta.last_row_id) }, 201);
});

adminPackages.put('/:id', async (c) => {
  const id = toInt(c.req.param('id'), 0);
  const body = await readJson(c);
  if (!body) return fail(c, 'Body tidak valid');
  const { title, examType, description, durationMinutes, active, passingGradeTotal } = packageInput(body);
  if (!title) return fail(c, 'Nama paket wajib diisi', 422);
  if (passingGradeTotal === -1) return fail(c, 'Passing grade total harus angka 0-5000', 422);

  const res = await c.env.DB.prepare(
    'UPDATE exam_packages SET title=?, exam_type=?, description=?, duration_minutes=?, active=?, passing_grade_total=?, updated_at=? WHERE id=?',
  )
    .bind(title, examType, description, durationMinutes, active, passingGradeTotal, new Date().toISOString(), id)
    .run();
  if (!res.meta.changes) return fail(c, 'Paket tidak ditemukan', 404);
  return ok(c, { updated: true });
});

adminPackages.delete('/:id', async (c) => {
  const id = toInt(c.req.param('id'), 0);
  const used = await c.env.DB.prepare('SELECT id FROM attempts WHERE package_id=? LIMIT 1')
    .bind(id)
    .first();
  if (used) return fail(c, 'Paket sudah punya riwayat pengerjaan. Nonaktifkan saja.', 409);
  await c.env.DB.prepare('DELETE FROM exam_packages WHERE id=?').bind(id).run();
  return ok(c, { deleted: true });
});

// Passing grade per paket: per kategori (poin, prioritas) atau total paket (fallback).
adminPackages.get('/:id/passing-grades', async (c) => {
  const id = toInt(c.req.param('id'), 0);
  const pkg = await c.env.DB.prepare('SELECT id, exam_type, passing_grade_total FROM exam_packages WHERE id=?')
    .bind(id)
    .first<{ id: number; exam_type: string; passing_grade_total: number | null }>();
  if (!pkg) return fail(c, 'Paket tidak ditemukan', 404);

  const cats = await c.env.DB.prepare(
    `SELECT DISTINCT c.id, c.name,
       (SELECT COUNT(*) FROM questions q
        WHERE q.package_id = ? AND q.category_id = c.id AND q.deleted_at IS NULL) AS question_count
     FROM categories c
     WHERE c.exam_type = ?
        OR c.id IN (SELECT category_id FROM passing_grades WHERE package_id = ?)
        OR c.id IN (SELECT DISTINCT category_id FROM questions WHERE package_id = ? AND deleted_at IS NULL)
     ORDER BY c.name`,
  )
    .bind(id, pkg.exam_type, id, id)
    .all<{ id: number; name: string; question_count: number }>();
  const rules = await c.env.DB.prepare(
    'SELECT category_id, minimum_score FROM passing_grades WHERE package_id=?',
  )
    .bind(id)
    .all<{ category_id: number; minimum_score: number }>();
  const ruleMap = new Map((rules.results ?? []).map((r) => [r.category_id, r.minimum_score]));

  return ok(c, {
    exam_type: pkg.exam_type,
    passing_grade_total: pkg.passing_grade_total,
    rules: (cats.results ?? []).map((cat) => ({
      category_id: cat.id,
      name: cat.name,
      question_count: cat.question_count,
      minimum_score: ruleMap.has(cat.id) ? ruleMap.get(cat.id)! : null,
    })),
  });
});

adminPackages.put('/:id/passing-grades', async (c) => {
  const id = toInt(c.req.param('id'), 0);
  const pkg = await c.env.DB.prepare('SELECT id FROM exam_packages WHERE id=?')
    .bind(id)
    .first();
  if (!pkg) return fail(c, 'Paket tidak ditemukan', 404);

  const body = await readJson(c);
  const rules = Array.isArray(body?.rules) ? (body!.rules as Record<string, unknown>[]) : [];
  const inserts: D1PreparedStatement[] = [];
  for (const r of rules) {
    if (r.minimum_score === null || r.minimum_score === undefined || r.minimum_score === '') continue;
    const catId = toInt(r.category_id, 0);
    const n = Number(r.minimum_score);
    if (!Number.isFinite(n) || n < 0 || n > 1000) return fail(c, 'Nilai minimum harus 0-1000 poin', 422);
    const min = Math.round(n * 10) / 10;
    const cat = await c.env.DB.prepare('SELECT id FROM categories WHERE id=?').bind(catId).first();
    if (!cat) return fail(c, `Kategori ${catId} tidak ditemukan`, 422);
    inserts.push(
      c.env.DB.prepare(
        'INSERT INTO passing_grades (package_id, category_id, minimum_score) VALUES (?, ?, ?)',
      ).bind(id, catId, min),
    );
  }

  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM passing_grades WHERE package_id=?').bind(id),
    ...inserts,
  ]);
  return ok(c, { saved: true, count: inserts.length });
});

// ===================== KATEGORI =====================
const adminCategories = new Hono<AppEnv>();
adminCategories.use('*', requireAdmin);

adminCategories.get('/', async (c) => {
  const examType = trimStr(c.req.query('exam_type'), 50);
  const rows = await (examType
    ? c.env.DB.prepare(
        `SELECT c.*, (SELECT COUNT(*) FROM questions q WHERE q.category_id=c.id AND q.deleted_at IS NULL) AS question_count
         FROM categories c WHERE c.exam_type=? ORDER BY c.exam_type, c.name`,
      ).bind(examType)
    : c.env.DB.prepare(
        `SELECT c.*, (SELECT COUNT(*) FROM questions q WHERE q.category_id=c.id AND q.deleted_at IS NULL) AS question_count
         FROM categories c ORDER BY c.exam_type, c.name`,
      )
  ).all();
  return ok(c, { categories: rows.results ?? [] });
});

function categoryInput(body: Record<string, unknown>) {
  const name = trimStr(body.name, 100);
  const examType = trimStr(body.exam_type, 50) ?? 'UPKP';
  const active = body.active === undefined ? 1 : body.active ? 1 : 0;
  return { name, examType, active };
}

adminCategories.post('/', async (c) => {
  const body = await readJson(c);
  if (!body) return fail(c, 'Body tidak valid');
  const { name, examType, active } = categoryInput(body);
  if (!name) return fail(c, 'Nama kategori wajib diisi', 422);
  try {
    const res = await c.env.DB.prepare(
      'INSERT INTO categories (name, exam_type, active) VALUES (?, ?, ?)',
    )
      .bind(name, examType, active)
      .run();
    return ok(c, { id: Number(res.meta.last_row_id) }, 201);
  } catch (e) {
    if (String(e).includes('UNIQUE')) return fail(c, 'Kategori dengan nama tersebut sudah ada untuk jenis ujian ini', 409);
    throw e;
  }
});

adminCategories.put('/:id', async (c) => {
  const id = toInt(c.req.param('id'), 0);
  const body = await readJson(c);
  if (!body) return fail(c, 'Body tidak valid');
  const { name, examType, active } = categoryInput(body);
  if (!name) return fail(c, 'Nama kategori wajib diisi', 422);
  try {
    const res = await c.env.DB.prepare(
      'UPDATE categories SET name=?, exam_type=?, active=? WHERE id=?',
    )
      .bind(name, examType, active, id)
      .run();
    if (!res.meta.changes) return fail(c, 'Kategori tidak ditemukan', 404);
    return ok(c, { updated: true });
  } catch (e) {
    if (String(e).includes('UNIQUE')) return fail(c, 'Kategori dengan nama tersebut sudah ada untuk jenis ujian ini', 409);
    throw e;
  }
});

adminCategories.delete('/:id', async (c) => {
  const id = toInt(c.req.param('id'), 0);
  const usedQ = await c.env.DB.prepare(
    'SELECT id FROM questions WHERE category_id=? AND deleted_at IS NULL LIMIT 1',
  )
    .bind(id)
    .first();
  const usedR = await c.env.DB.prepare(
    'SELECT id FROM passing_grades WHERE category_id=? LIMIT 1',
  )
    .bind(id)
    .first();
  if (usedQ || usedR) return fail(c, 'Kategori masih dipakai soal atau passing grade. Nonaktifkan saja.', 409);
  const res = await c.env.DB.prepare('DELETE FROM categories WHERE id=?').bind(id).run();
  if (!res.meta.changes) return fail(c, 'Kategori tidak ditemukan', 404);
  return ok(c, { deleted: true });
});

export { adminProducts, adminPackages, adminCategories };
