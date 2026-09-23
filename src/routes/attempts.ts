import { Hono } from 'hono';
import { fail, ok } from '../utils/response';
import { requireActiveAccess, requireAuth } from '../middleware/auth';
import { ANSWER_LETTERS, normalizeAnswer, toInt } from '../utils/validate';
import { readJson } from '../utils/body';
import { finalizeIfExpired, finalizeUserExpiredAttempts, scoreAndFinalize } from '../services/scoring';
import { remainingSeconds } from '../services/payments';
import type { AppEnv } from '../types';

const attempts = new Hono<AppEnv>();
attempts.use('*', requireAuth);

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

type AttemptRow = {
  id: number;
  user_id: number;
  status: string;
  expires_at: string;
  started_at: string;
  package_id: number;
  title: string;
  duration_minutes: number;
};

async function getAttempt(db: D1Database, id: number): Promise<AttemptRow | null> {
  return db
    .prepare(
      `SELECT a.id, a.user_id, a.status, a.expires_at, a.started_at,
              p.id AS package_id, p.title, p.duration_minutes
       FROM attempts a JOIN exam_packages p ON p.id=a.package_id WHERE a.id=?`,
    )
    .bind(id)
    .first<AttemptRow>();
}

// Mulai attempt baru: snapshot urutan soal diacak sekali dan disimpan.
attempts.post('/', requireActiveAccess, async (c) => {
  const user = c.get('user');
  const body = await readJson(c);
  const packageId = toInt(body?.package_id, 0);

  const pkg = await c.env.DB.prepare(
    'SELECT id, duration_minutes, active FROM exam_packages WHERE id=?',
  )
    .bind(packageId)
    .first<{ id: number; duration_minutes: number; active: number }>();
  if (!pkg || !pkg.active) return fail(c, 'Paket tidak ditemukan', 404);

  const qids = await c.env.DB.prepare(
    'SELECT id FROM questions WHERE package_id=? AND deleted_at IS NULL',
  )
    .bind(packageId)
    .all<{ id: number }>();
  if (!(qids.results ?? []).length) return fail(c, 'Paket ini belum memiliki soal', 422);

  await finalizeUserExpiredAttempts(c.env.DB, user.id);

  const activeAttempt = await c.env.DB.prepare(
    `SELECT id FROM attempts WHERE user_id=? AND status='in_progress' LIMIT 1`,
  )
    .bind(user.id)
    .first<{ id: number }>();
  if (activeAttempt) {
    return c.json(
      { success: false, error: 'Anda masih memiliki ujian yang sedang berjalan.', attempt_id: activeAttempt.id },
      409,
    );
  }

  const expiresAt = new Date(Date.now() + pkg.duration_minutes * 60000).toISOString();
  const res = await c.env.DB.prepare(
    'INSERT INTO attempts (user_id, package_id, expires_at) VALUES (?, ?, ?)',
  )
    .bind(user.id, packageId, expiresAt)
    .run();
  const attemptId = Number(res.meta.last_row_id);

  const shuffled = shuffle((qids.results ?? []).map((r) => r.id));
  await c.env.DB.batch(
    shuffled.map((qid, i) =>
      c.env.DB.prepare(
        'INSERT INTO attempt_questions (attempt_id, question_id, question_order) VALUES (?, ?, ?)',
      ).bind(attemptId, qid, i + 1),
    ),
  );

  return ok(c, { attempt_id: attemptId }, 201);
});

// Attempt yang sedang berjalan (untuk tombol "Lanjutkan").
attempts.get('/active', async (c) => {
  const user = c.get('user');
  await finalizeUserExpiredAttempts(c.env.DB, user.id);
  const a = await c.env.DB.prepare(
    `SELECT a.id, a.expires_at, p.title FROM attempts a
     JOIN exam_packages p ON p.id=a.package_id
     WHERE a.user_id=? AND a.status='in_progress' ORDER BY a.id DESC LIMIT 1`,
  )
    .bind(user.id)
    .first<{ id: number; expires_at: string; title: string }>();
  if (!a) return ok(c, { attempt: null });
  return ok(c, {
    attempt: { id: a.id, title: a.title, remaining_seconds: remainingSeconds(a.expires_at) },
  });
});

// Muat data ujian — TANPA correct_answer/explanation (keamanan PRD #31).
attempts.get('/:id', async (c) => {
  const user = c.get('user');
  const id = toInt(c.req.param('id'), 0);

  let a = await getAttempt(c.env.DB, id);
  if (!a || (a.user_id !== user.id && user.role !== 'admin')) {
    return fail(c, 'Ujian tidak ditemukan', 404);
  }
  if (await finalizeIfExpired(c.env.DB, id)) {
    a = (await getAttempt(c.env.DB, id)) as AttemptRow;
  }
  if (a.status !== 'in_progress') {
    return ok(c, { status: 'submitted', result_id: id });
  }

  const qs = await c.env.DB.prepare(
    `SELECT aq.question_id, aq.question_order, aq.user_answer, aq.marked_review,
            q.question, q.option_a, q.option_b, q.option_c, q.option_d, q.option_e, c.name AS category
     FROM attempt_questions aq
     JOIN questions q ON q.id=aq.question_id
     JOIN categories c ON c.id=q.category_id
     WHERE aq.attempt_id=? ORDER BY aq.question_order`,
  )
    .bind(id)
    .all<{
      question_id: number;
      question_order: number;
      user_answer: string | null;
      marked_review: number;
      question: string;
      option_a: string;
      option_b: string;
      option_c: string;
      option_d: string;
      option_e: string;
      category: string;
    }>();

  const rows = qs.results ?? [];
  const answers: Record<string, string> = {};
  const marked: number[] = [];
  for (const r of rows) {
    if (r.user_answer) answers[String(r.question_id)] = r.user_answer;
    if (r.marked_review) marked.push(r.question_id);
  }

  return ok(c, {
    status: 'in_progress',
    attempt: {
      id: a.id,
      started_at: a.started_at,
      expires_at: a.expires_at,
      remaining_seconds: remainingSeconds(a.expires_at),
    },
    package: { id: a.package_id, title: a.title, duration_minutes: a.duration_minutes },
    questions: rows.map((r) => ({
      id: r.question_id,
      order: r.question_order,
      question: r.question,
      options: { A: r.option_a, B: r.option_b, C: r.option_c, D: r.option_d, E: r.option_e },
      category: r.category,
    })),
    answers,
    marked,
  });
});

// Simpan satu jawaban (autosave). Refresh tidak menghilangkan jawaban.
attempts.post('/:id/answer', async (c) => {
  const user = c.get('user');
  const id = toInt(c.req.param('id'), 0);
  const body = await readJson(c);

  const a = await getAttempt(c.env.DB, id);
  if (!a || (a.user_id !== user.id && user.role !== 'admin')) {
    return fail(c, 'Ujian tidak ditemukan', 404);
  }
  if (a.status !== 'in_progress') return fail(c, 'Ujian ini sudah selesai', 409);

  if (Date.now() >= Date.parse(a.expires_at)) {
    await scoreAndFinalize(c.env.DB, id, true);
    return c.json(
      { success: false, error: 'Waktu ujian telah habis. Ujian otomatis disubmit.', result_id: id },
      410,
    );
  }

  const questionId = toInt(body?.question_id, 0);
  let answer: string | null = null;
  if (body?.answer !== null && body?.answer !== undefined && body?.answer !== '') {
    answer = normalizeAnswer(body?.answer);
    if (!answer || !(ANSWER_LETTERS as readonly string[]).includes(answer)) {
      return fail(c, 'Jawaban harus salah satu A-E atau null', 422);
    }
  }
  const marked =
    typeof body?.marked_review === 'boolean' ? (body.marked_review ? 1 : 0) : null;

  const res = await c.env.DB.prepare(
    `UPDATE attempt_questions SET user_answer=?, marked_review=COALESCE(?, marked_review)
     WHERE attempt_id=? AND question_id=?`,
  )
    .bind(answer, marked, id, questionId)
    .run();
  if (!res.meta.changes) return fail(c, 'Soal tidak ditemukan dalam ujian ini', 404);

  return ok(c, { saved: true, remaining_seconds: remainingSeconds(a.expires_at) });
});

// Selesai ujian — server menghitung sendiri, nilai frontend tidak dipercaya.
attempts.post('/:id/submit', async (c) => {
  const user = c.get('user');
  const id = toInt(c.req.param('id'), 0);

  const a = await getAttempt(c.env.DB, id);
  if (!a || (a.user_id !== user.id && user.role !== 'admin')) {
    return fail(c, 'Ujian tidak ditemukan', 404);
  }
  if (a.status === 'submitted') {
    return ok(c, { already_submitted: true, result_id: id });
  }
  if (a.status !== 'in_progress') return fail(c, 'Status ujian tidak valid', 409);

  await scoreAndFinalize(c.env.DB, id, false);
  return ok(c, { result_id: id });
});

export default attempts;
