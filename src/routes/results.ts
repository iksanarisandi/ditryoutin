import { Hono } from 'hono';
import { fail, ok } from '../utils/response';
import { requireAuth } from '../middleware/auth';
import { toInt } from '../utils/validate';
import { finalizeIfExpired, POINTS_PER_CORRECT } from '../services/scoring';
import type { AppEnv } from '../types';

const results = new Hono<AppEnv>();
results.use('*', requireAuth);

// Riwayat tryout milik sendiri.
results.get('/', async (c) => {
  const user = c.get('user');
  const rows = await c.env.DB.prepare(
    `SELECT a.id, a.package_id, p.title, a.submitted_at, a.score, a.passed,
            a.correct_count, a.wrong_count, a.unanswered_count, a.duration_seconds, a.auto_submitted
     FROM attempts a JOIN exam_packages p ON p.id=a.package_id
     WHERE a.user_id=? AND a.status='submitted'
     ORDER BY a.submitted_at DESC LIMIT 200`,
  )
    .bind(user.id)
    .all<{
      id: number;
      package_id: number;
      title: string;
      submitted_at: string;
      score: number | null;
      passed: number | null;
      correct_count: number | null;
      wrong_count: number | null;
      unanswered_count: number | null;
      duration_seconds: number | null;
      auto_submitted: number;
    }>();
  const results = (rows.results ?? []).map((r) => ({
    ...r,
    max_score:
      ((r.correct_count ?? 0) + (r.wrong_count ?? 0) + (r.unanswered_count ?? 0)) * POINTS_PER_CORRECT,
  }));
  return ok(c, { results });
});

// Detail hasil + pembahasan. Hanya pemilik (atau admin) dan hanya setelah submit.
results.get('/:id', async (c) => {
  const user = c.get('user');
  const id = toInt(c.req.param('id'), 0);

  await finalizeIfExpired(c.env.DB, id);

  const a = await c.env.DB.prepare(
    `SELECT a.*, p.title, p.exam_type, p.passing_grade_total FROM attempts a
     JOIN exam_packages p ON p.id=a.package_id WHERE a.id=?`,
  )
    .bind(id)
    .first<{
      id: number;
      user_id: number;
      package_id: number;
      status: string;
      started_at: string;
      submitted_at: string | null;
      score: number | null;
      correct_count: number | null;
      wrong_count: number | null;
      unanswered_count: number | null;
      passed: number | null;
      auto_submitted: number;
      duration_seconds: number | null;
      category_scores: string | null;
      title: string;
      exam_type: string;
      passing_grade_total: number | null;
    }>();

  if (!a || (a.user_id !== user.id && user.role !== 'admin')) {
    return fail(c, 'Hasil tidak ditemukan', 404);
  }
  if (a.status !== 'submitted') {
    return fail(c, 'Hasil belum tersedia. Ujian masih berjalan.', 409);
  }

  const review = await c.env.DB.prepare(
    `SELECT aq.question_order, aq.user_answer, aq.is_correct,
            q.question, q.option_a, q.option_b, q.option_c, q.option_d, q.option_e,
            q.correct_answer, q.explanation, c.name AS category
     FROM attempt_questions aq
     JOIN questions q ON q.id=aq.question_id
     JOIN categories c ON c.id=q.category_id
     WHERE aq.attempt_id=? ORDER BY aq.question_order`,
  )
    .bind(id)
    .all<{
      question_order: number;
      user_answer: string | null;
      is_correct: number | null;
      question: string;
      option_a: string;
      option_b: string;
      option_c: string;
      option_d: string;
      option_e: string;
      correct_answer: string;
      explanation: string | null;
      category: string;
    }>();

  const rules = await c.env.DB.prepare(
    `SELECT c.name, pg.minimum_score FROM passing_grades pg
     JOIN categories c ON c.id=pg.category_id WHERE pg.package_id=? ORDER BY c.name`,
  )
    .bind(a.package_id)
    .all<{ name: string; minimum_score: number }>();

  let categoryScores: unknown[] = [];
  try {
    categoryScores = a.category_scores ? JSON.parse(a.category_scores) : [];
  } catch {
    categoryScores = [];
  }
  // Normalisasi baris lama (skala persen, tanpa max_score) ke skala poin correct x 5.
  categoryScores = (categoryScores as Record<string, number | string>[]).map((cs) =>
    cs.max_score == null
      ? {
          ...cs,
          score: Number(cs.correct) * POINTS_PER_CORRECT,
          max_score: Number(cs.total) * POINTS_PER_CORRECT,
        }
      : cs,
  );
  const catByName = new Map(
    (categoryScores as { name: string; score: number }[]).map((cs) => [cs.name, cs.score]),
  );

  // Mode kelulusan: 'category' (aturan per kategori, prioritas), 'total' (PG total
  // paket, hanya jika tidak ada aturan kategori), atau 'none'.
  const hasCategoryRules = (rules.results ?? []).length > 0;
  const passingMode = hasCategoryRules ? 'category' : a.passing_grade_total != null ? 'total' : 'none';
  const maxScore =
    ((a.correct_count ?? 0) + (a.wrong_count ?? 0) + (a.unanswered_count ?? 0)) * POINTS_PER_CORRECT;

  return ok(c, {
    result: {
      id: a.id,
      package: { id: a.package_id, title: a.title, exam_type: a.exam_type },
      score: a.score,
      max_score: maxScore,
      points_per_correct: POINTS_PER_CORRECT,
      correct_count: a.correct_count,
      wrong_count: a.wrong_count,
      unanswered_count: a.unanswered_count,
      passed: a.passed,
      passing_available: passingMode !== 'none',
      passing_mode: passingMode,
      passing_grade_total: passingMode === 'total' ? a.passing_grade_total : null,
      auto_submitted: !!a.auto_submitted,
      duration_seconds: a.duration_seconds,
      started_at: a.started_at,
      submitted_at: a.submitted_at,
    },
    category_scores: categoryScores,
    passing_grades: (rules.results ?? []).map((r) => {
      const score = catByName.has(r.name) ? catByName.get(r.name)! : null;
      return {
        name: r.name,
        minimum_score: r.minimum_score,
        score,
        passed: score === null ? null : score >= r.minimum_score,
      };
    }),
    review: review.results ?? [],
  });
});

export default results;
