import { Hono } from 'hono';
import { fail, ok } from '../utils/response';
import { requireAuth } from '../middleware/auth';
import { toInt } from '../utils/validate';
import type { AppEnv } from '../types';

const packages = new Hono<AppEnv>();
packages.use('*', requireAuth);

// Daftar paket tryout aktif + ringkasan pengerjaan user.
packages.get('/', async (c) => {
  const user = c.get('user');
  const rows = await c.env.DB.prepare(
    `SELECT p.id, p.title, p.exam_type, p.description, p.duration_minutes,
       (SELECT COUNT(*) FROM questions q WHERE q.package_id=p.id AND q.deleted_at IS NULL) AS question_count,
       (SELECT COUNT(*) FROM attempts a WHERE a.package_id=p.id AND a.user_id=?1 AND a.status='submitted') AS attempt_count,
       (SELECT a.score FROM attempts a WHERE a.package_id=p.id AND a.user_id=?1 AND a.status='submitted'
        ORDER BY a.submitted_at DESC, a.id DESC LIMIT 1) AS last_score,
       (SELECT a.passed FROM attempts a WHERE a.package_id=p.id AND a.user_id=?1 AND a.status='submitted'
        ORDER BY a.submitted_at DESC, a.id DESC LIMIT 1) AS last_passed,
       (SELECT MAX(a.score) FROM attempts a WHERE a.package_id=p.id AND a.user_id=?1 AND a.status='submitted') AS best_score,
       (SELECT EXISTS(SELECT 1 FROM attempts a WHERE a.package_id=p.id AND a.user_id=?1 AND a.status='submitted' AND a.passed=1)) AS ever_passed
     FROM exam_packages p
     WHERE p.active=1
     ORDER BY p.id`,
  )
    .bind(user.id)
    .all<{
      id: number;
      title: string;
      exam_type: string;
      description: string | null;
      duration_minutes: number;
      question_count: number;
      attempt_count: number;
      last_score: number | null;
      last_passed: number | null;
      best_score: number | null;
      ever_passed: number;
    }>();

  const cats = await c.env.DB.prepare(
    `SELECT q.package_id, GROUP_CONCAT(DISTINCT c.name) AS categories
     FROM questions q JOIN categories c ON c.id=q.category_id
     WHERE q.deleted_at IS NULL GROUP BY q.package_id`,
  ).all<{ package_id: number; categories: string }>();
  const catMap = new Map((cats.results ?? []).map((r) => [r.package_id, r.categories]));

  return ok(c, {
    packages: (rows.results ?? []).map((p) => ({
      ...p,
      categories: catMap.get(p.id) ?? '-',
    })),
  });
});

packages.get('/:id', async (c) => {
  const id = toInt(c.req.param('id'), 0);
  const p = await c.env.DB.prepare(
    `SELECT id, title, exam_type, description, duration_minutes, active
     FROM exam_packages WHERE id=? AND active=1`,
  )
    .bind(id)
    .first<{ id: number; title: string; exam_type: string; description: string | null; duration_minutes: number }>();
  if (!p) return fail(c, 'Paket tidak ditemukan', 404);

  const count = await c.env.DB.prepare(
    'SELECT COUNT(*) AS n FROM questions WHERE package_id=? AND deleted_at IS NULL',
  )
    .bind(id)
    .first<{ n: number }>();
  const cats = await c.env.DB.prepare(
    `SELECT GROUP_CONCAT(DISTINCT c.name) AS categories FROM questions q
     JOIN categories c ON c.id=q.category_id WHERE q.package_id=? AND q.deleted_at IS NULL`,
  )
    .bind(id)
    .first<{ categories: string | null }>();
  const rules = await c.env.DB.prepare(
    `SELECT c.name, pg.minimum_score FROM passing_grades pg
     JOIN categories c ON c.id=pg.category_id WHERE pg.package_id=? ORDER BY c.name`,
  )
    .bind(id)
    .all<{ name: string; minimum_score: number }>();

  return ok(c, {
    package: { ...p, question_count: count?.n ?? 0, categories: cats?.categories ?? '-' },
    passing_grades: rules.results ?? [],
  });
});

export default packages;
