import { Hono } from 'hono';
import { fail, ok } from '../../utils/response';
import { requireAdmin } from '../../middleware/auth';
import { ANSWER_LETTERS, clamp, toInt, trimStr } from '../../utils/validate';
import { readJson, BODY_LIMIT_IMPORT } from '../../utils/body';
import {
  importSummary,
  normalizeQuestion,
  parseImportPayload,
  validateImport,
} from '../../services/importer';
import { defaultMinimumScore } from '../../services/passing-grades';
import type { AppEnv } from '../../types';

const adminQuestions = new Hono<AppEnv>();
adminQuestions.use('*', requireAdmin);

type QuestionInput = {
  package_id: number;
  category_id: number;
  question: string | null;
  option_a: string | null;
  option_b: string | null;
  option_c: string | null;
  option_d: string | null;
  option_e: string | null;
  correct_answer: string | null;
  explanation: string | null;
};

function questionInput(body: Record<string, unknown>): QuestionInput {
  const answer = typeof body.correct_answer === 'string' ? body.correct_answer.trim().toUpperCase() : '';
  return {
    package_id: toInt(body.package_id, 0),
    category_id: toInt(body.category_id, 0),
    question: trimStr(body.question, 4000),
    option_a: trimStr(body.option_a, 2000),
    option_b: trimStr(body.option_b, 2000),
    option_c: trimStr(body.option_c, 2000),
    option_d: trimStr(body.option_d, 2000),
    option_e: trimStr(body.option_e, 2000),
    correct_answer: (ANSWER_LETTERS as readonly string[]).includes(answer) ? answer : null,
    explanation: trimStr(body.explanation, 4000),
  };
}

function validateQuestionInput(q: QuestionInput): string | null {
  if (!q.package_id) return 'Paket wajib dipilih';
  if (!q.category_id) return 'Kategori wajib dipilih';
  if (!q.question) return 'Pertanyaan wajib diisi';
  for (const l of ANSWER_LETTERS) {
    if (!q[`option_${l.toLowerCase()}` as `option_${'a' | 'b' | 'c' | 'd' | 'e'}`]) {
      return `Pilihan ${l} wajib diisi`;
    }
  }
  if (!q.correct_answer) return 'Jawaban benar harus salah satu A-E';
  return null;
}

// Validasi referensi paket & kategori; mengembalikan exam_type/nama kategori
// agar pemanggil bisa menerapkan passing grade default tanpa query ulang.
async function validateRefs(
  db: D1Database,
  q: QuestionInput,
): Promise<{ error: string | null; examType: string | null; categoryName: string | null }> {
  const pkg = await db.prepare('SELECT id, exam_type FROM exam_packages WHERE id=?')
    .bind(q.package_id).first<{ id: number; exam_type: string }>();
  if (!pkg) return { error: 'Paket tidak ditemukan', examType: null, categoryName: null };
  const cat = await db.prepare('SELECT id, name FROM categories WHERE id=?')
    .bind(q.category_id).first<{ id: number; name: string }>();
  if (!cat) return { error: 'Kategori tidak ditemukan', examType: null, categoryName: null };
  return { error: null, examType: pkg.exam_type, categoryName: cat.name };
}

adminQuestions.get('/', async (c) => {
  const packageId = toInt(c.req.query('package_id'), 0);
  const categoryId = toInt(c.req.query('category_id'), 0);
  const q = trimStr(c.req.query('q'), 100);
  const page = Math.max(1, toInt(c.req.query('page'), 1));
  const per = 25;

  const conds: string[] = ['q.deleted_at IS NULL'];
  const binds: unknown[] = [];
  if (packageId) {
    conds.push('q.package_id=?');
    binds.push(packageId);
  }
  if (categoryId) {
    conds.push('q.category_id=?');
    binds.push(categoryId);
  }
  if (q) {
    conds.push('q.question LIKE ?');
    binds.push(`%${q}%`);
  }
  const where = `WHERE ${conds.join(' AND ')}`;

  const totalRow = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM questions q ${where}`)
    .bind(...binds)
    .first<{ n: number }>();
  const rows = await c.env.DB.prepare(
    `SELECT q.id, q.package_id, q.category_id, q.question, q.option_a, q.option_b, q.option_c, q.option_d, q.option_e,
            q.correct_answer, q.explanation, c.name AS category, p.title AS package_title,
            EXISTS(SELECT 1 FROM attempt_questions aq WHERE aq.question_id=q.id) AS used
     FROM questions q
     JOIN categories c ON c.id=q.category_id
     JOIN exam_packages p ON p.id=q.package_id
     ${where} ORDER BY q.id DESC LIMIT ? OFFSET ?`,
  )
    .bind(...binds, per, (page - 1) * per)
    .all();

  // Daftar untuk dropdown filter/form.
  const pkgList = await c.env.DB.prepare(
    'SELECT id, title, exam_type FROM exam_packages ORDER BY title',
  ).all();
  const catList = await c.env.DB.prepare(
    'SELECT id, name, exam_type, active FROM categories ORDER BY exam_type, name',
  ).all();

  return ok(c, {
    questions: rows.results ?? [],
    total: totalRow?.n ?? 0,
    page,
    per_page: per,
    packages: pkgList.results ?? [],
    categories: catList.results ?? [],
  });
});

adminQuestions.post('/', async (c) => {
  const body = await readJson(c);
  if (!body) return fail(c, 'Body tidak valid');
  const input = questionInput(body);
  const err = validateQuestionInput(input);
  if (err) return fail(c, err, 422);
  const refs = await validateRefs(c.env.DB, input);
  if (refs.error) return fail(c, refs.error, 422);

  const res = await c.env.DB.prepare(
    `INSERT INTO questions (package_id, category_id, question, option_a, option_b, option_c, option_d, option_e, correct_answer, explanation)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      input.package_id, input.category_id, input.question,
      input.option_a, input.option_b, input.option_c, input.option_d, input.option_e,
      input.correct_answer, input.explanation,
    )
    .run();

  // Terapkan passing grade default untuk kategori ini jika paket belum punya aturannya.
  const def = defaultMinimumScore(refs.examType!, refs.categoryName!);
  if (def != null) {
    await c.env.DB.prepare(
      'INSERT OR IGNORE INTO passing_grades (package_id, category_id, minimum_score) VALUES (?, ?, ?)',
    )
      .bind(input.package_id, input.category_id, def)
      .run();
  }
  return ok(c, { id: Number(res.meta.last_row_id) }, 201);
});

adminQuestions.put('/:id', async (c) => {
  const id = toInt(c.req.param('id'), 0);
  const body = await readJson(c);
  if (!body) return fail(c, 'Body tidak valid');
  const input = questionInput(body);
  const err = validateQuestionInput(input);
  if (err) return fail(c, err, 422);
  const refs = await validateRefs(c.env.DB, input);
  if (refs.error) return fail(c, refs.error, 422);

  const res = await c.env.DB.prepare(
    `UPDATE questions SET package_id=?, category_id=?, question=?, option_a=?, option_b=?, option_c=?, option_d=?, option_e=?,
     correct_answer=?, explanation=?, updated_at=? WHERE id=? AND deleted_at IS NULL`,
  )
    .bind(
      input.package_id, input.category_id, input.question,
      input.option_a, input.option_b, input.option_c, input.option_d, input.option_e,
      input.correct_answer, input.explanation, new Date().toISOString(), id,
    )
    .run();
  if (!res.meta.changes) return fail(c, 'Soal tidak ditemukan', 404);
  return ok(c, { updated: true });
});

// Soft delete: attempt lama tetap bisa menampilkan soalnya.
adminQuestions.delete('/:id', async (c) => {
  const id = toInt(c.req.param('id'), 0);
  const res = await c.env.DB.prepare('UPDATE questions SET deleted_at=?, updated_at=? WHERE id=? AND deleted_at IS NULL')
    .bind(new Date().toISOString(), new Date().toISOString(), id)
    .run();
  if (!res.meta.changes) return fail(c, 'Soal tidak ditemukan', 404);
  return ok(c, { deleted: true });
});

// ===================== IMPORT JSON =====================
// Body: { data, mode: 'preview'|'commit', package_id?, import_mode?: 'append'|'replace',
//         create_categories?: bool, duration_minutes? }
adminQuestions.post('/import', async (c) => {
  // Import bisa besar (maks 500 soal x ~18KB) — limit khusus, bukan 64KB.
  const body = await readJson(c, BODY_LIMIT_IMPORT);
  if (!body) return fail(c, 'Body tidak valid atau terlalu besar (maks 8 MB)');
  const commit = body.mode === 'commit';

  const parsed = parseImportPayload(body.data);
  if (!parsed.payload) return fail(c, parsed.error ?? 'JSON tidak valid', 400);
  const payload = parsed.payload;

  const errors = validateImport(payload);
  const summary = importSummary(payload);
  const valid = errors.length === 0;

  let target: { id: number; title: string; exam_type: string; duration_minutes: number } | null = null;
  const packageId = toInt(body.package_id, 0);
  if (packageId) {
    target =
      (await c.env.DB.prepare(
        'SELECT id, title, exam_type, duration_minutes FROM exam_packages WHERE id=?',
      )
        .bind(packageId)
        .first()) ?? null;
    if (!target) return fail(c, 'Paket tujuan tidak ditemukan', 404);
  } else {
    target =
      (await c.env.DB.prepare('SELECT id, title, exam_type, duration_minutes FROM exam_packages WHERE title=? ORDER BY id LIMIT 1')
        .bind(summary.title)
        .first()) ?? null;
  }

  if (!commit) {
    return ok(c, {
      valid,
      errors,
      summary,
      target: target
        ? { package_id: target.id, title: target.title, will_create: false }
        : { package_id: null, title: summary.title, will_create: true },
    });
  }

  if (!valid) {
    return c.json(
      { success: false, error: `JSON mengandung ${errors.length} error — tidak ada data yang disimpan.`, errors },
      422,
    );
  }

  const importMode = body.import_mode === 'replace' ? 'replace' : 'append';
  const createCategories = body.create_categories !== false; // default: buat otomatis
  const examType = target ? target.exam_type : summary.exam_type;
  const nowIso = new Date().toISOString();

  const normalized = payload.questions.map((q) => normalizeQuestion(q as Record<string, unknown>));
  const needed = [...new Set(normalized.map((q) => q.category))];
  const existingCats = await c.env.DB.prepare(
    'SELECT id, name FROM categories WHERE exam_type=?',
  )
    .bind(examType)
    .all<{ id: number; name: string }>();
  const catMap = new Map((existingCats.results ?? []).map((r) => [r.name.toLowerCase(), r.id]));
  const missing = needed.filter((n) => !catMap.has(n.toLowerCase()));
  if (missing.length && !createCategories) {
    return fail(c, `Kategori belum tersedia: ${missing.join(', ')}. Buat dulu di menu Kategori atau aktifkan buat otomatis.`, 422);
  }

  // Siapkan statement dalam SATU batch D1 (atomik).
  const stmts: D1PreparedStatement[] = [];
  const maxCat = await c.env.DB.prepare('SELECT COALESCE(MAX(id),0) AS m FROM categories').first<{ m: number }>();
  const maxPkg = await c.env.DB.prepare('SELECT COALESCE(MAX(id),0) AS m FROM exam_packages').first<{ m: number }>();
  let nextCatId = (maxCat?.m ?? 0) + 1;
  let packageIdFinal: number;

  if (target) {
    packageIdFinal = target.id;
    if (importMode === 'replace') {
      stmts.push(
        c.env.DB.prepare('UPDATE questions SET deleted_at=?, updated_at=? WHERE package_id=? AND deleted_at IS NULL')
          .bind(nowIso, nowIso, packageIdFinal),
      );
    }
  } else {
    packageIdFinal = (maxPkg?.m ?? 0) + 1;
    const duration = clamp(toInt(body.duration_minutes, 90), 1, 600);
    stmts.push(
      c.env.DB.prepare(
        'INSERT INTO exam_packages (id, title, exam_type, description, duration_minutes, active) VALUES (?, ?, ?, NULL, ?, 1)',
      ).bind(packageIdFinal, summary.title, examType, duration),
    );
  }

  for (const m of missing) {
    stmts.push(
      c.env.DB.prepare('INSERT INTO categories (id, name, exam_type, active) VALUES (?, ?, ?, 1)').bind(nextCatId, m, examType),
    );
    catMap.set(m.toLowerCase(), nextCatId);
    nextCatId++;
  }

  for (const q of normalized) {
    const catId = catMap.get(q.category.toLowerCase());
    if (!catId) continue; // sudah divalidasi di atas — tidak terjadi
    stmts.push(
      c.env.DB.prepare(
        `INSERT INTO questions (package_id, category_id, question, option_a, option_b, option_c, option_d, option_e, correct_answer, explanation)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(packageIdFinal, catId, q.question, q.options.A, q.options.B, q.options.C, q.options.D, q.options.E, q.answer, q.explanation || null),
    );
  }

  // Passing grade default per jenis ujian untuk kategori yang di-import.
  // INSERT OR IGNORE: aturan yang sudah diatur manual admin tidak ditimpa.
  for (const catName of needed) {
    const catId = catMap.get(catName.toLowerCase());
    const def = defaultMinimumScore(examType, catName);
    if (catId && def != null) {
      stmts.push(
        c.env.DB.prepare(
          'INSERT OR IGNORE INTO passing_grades (package_id, category_id, minimum_score) VALUES (?, ?, ?)',
        ).bind(packageIdFinal, catId, def),
      );
    }
  }

  await c.env.DB.batch(stmts);
  return ok(c, {
    package_id: packageIdFinal,
    inserted: normalized.length,
    categories_created: missing.length,
    import_mode: importMode,
    created_new_package: !target,
  });
});

export default adminQuestions;
