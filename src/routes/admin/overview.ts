import { Hono } from 'hono';
import { fail, ok } from '../../utils/response';
import { requireAdmin } from '../../middleware/auth';
import { toInt, trimStr } from '../../utils/validate';
import { settlePayment, type PaymentRow } from '../../services/payments';
import type { AppEnv } from '../../types';

const overview = new Hono<AppEnv>();
overview.use('*', requireAdmin);

overview.get('/stats', async (c) => {
  const nowIso = new Date().toISOString();
  const [totalUsers, usersOnline, usersWithAccess, payStats, totalPackages, totalQuestions, totalAttempts] =
    await Promise.all([
      c.env.DB.prepare(`SELECT COUNT(*) AS n FROM users WHERE role='user'`).first<{ n: number }>(),
      c.env.DB.prepare(
        `SELECT COUNT(DISTINCT s.user_id) AS n FROM sessions s JOIN users u ON u.id=s.user_id
         WHERE s.expires_at > ? AND u.role='user'`,
      )
        .bind(nowIso)
        .first<{ n: number }>(),
      c.env.DB.prepare(
        `SELECT COUNT(*) AS n FROM users WHERE role='user' AND access_expires_at > ?`,
      )
        .bind(nowIso)
        .first<{ n: number }>(),
      c.env.DB.prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total FROM payments WHERE status='paid'`,
      ).first<{ n: number; total: number }>(),
      c.env.DB.prepare('SELECT COUNT(*) AS n FROM exam_packages').first<{ n: number }>(),
      c.env.DB.prepare('SELECT COUNT(*) AS n FROM questions WHERE deleted_at IS NULL').first<{ n: number }>(),
      c.env.DB.prepare(`SELECT COUNT(*) AS n FROM attempts WHERE status='submitted'`).first<{ n: number }>(),
    ]);

  return ok(c, {
    stats: {
      total_users: totalUsers?.n ?? 0,
      users_online: usersOnline?.n ?? 0,
      users_with_active_access: usersWithAccess?.n ?? 0,
      transactions_paid: payStats?.n ?? 0,
      revenue: payStats?.total ?? 0,
      total_packages: totalPackages?.n ?? 0,
      total_questions: totalQuestions?.n ?? 0,
      total_attempts: totalAttempts?.n ?? 0,
    },
  });
});

overview.get('/payments', async (c) => {
  const status = trimStr(c.req.query('status'), 20);
  const page = Math.max(1, toInt(c.req.query('page'), 1));
  const per = 25;

  const where = status ? `WHERE pm.status=?` : '';
  const binds = status ? [status] : [];
  const totalRow = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM payments pm ${where}`)
    .bind(...binds)
    .first<{ n: number }>();
  const rows = await c.env.DB.prepare(
    `SELECT pm.id, pm.reference, pm.amount, pm.status, pm.method, pm.paid_at, pm.created_at,
            u.name AS user_name, u.email AS user_email, pr.name AS product_name
     FROM payments pm
     JOIN users u ON u.id=pm.user_id
     JOIN products pr ON pr.id=pm.product_id
     ${where} ORDER BY pm.id DESC LIMIT ? OFFSET ?`,
  )
    .bind(...binds, per, (page - 1) * per)
    .all();

  return ok(c, { payments: rows.results ?? [], total: totalRow?.n ?? 0, page, per_page: per });
});

// Tandai Lunas manual: admin memverifikasi uang QRIS benar-benar masuk, lalu
// menjalankan settle idempoten yang sama dengan webhook/polling Pakasir —
// akses user langsung diperpanjang dan transaksi ikut terhitung di pendapatan.
overview.post('/payments/:id/mark-paid', async (c) => {
  const id = toInt(c.req.param('id'), 0);
  const p = await c.env.DB.prepare('SELECT * FROM payments WHERE id=?')
    .bind(id)
    .first<PaymentRow>();
  if (!p) return fail(c, 'Transaksi tidak ditemukan', 404);
  if (p.status === 'paid') return fail(c, 'Transaksi ini sudah lunas', 409);

  await settlePayment(c.env.DB, p);
  return ok(c, { ok: true, payment_id: p.id, status: 'paid' });
});

overview.get('/results', async (c) => {
  const q = trimStr(c.req.query('q'), 100);
  const page = Math.max(1, toInt(c.req.query('page'), 1));
  const per = 25;

  const where = q ? `WHERE u.name LIKE ?1 OR u.email LIKE ?1` : '';
  const binds = q ? [`%${q}%`] : [];
  const totalRow = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM attempts a JOIN users u ON u.id=a.user_id ${where}`,
  )
    .bind(...binds)
    .first<{ n: number }>();
  const rows = await c.env.DB.prepare(
    `SELECT a.id, a.status, a.score, a.passed, a.started_at, a.submitted_at, a.duration_seconds,
            a.correct_count, a.wrong_count, a.unanswered_count,
            u.name AS user_name, u.email AS user_email, p.title AS package_title
     FROM attempts a
     JOIN users u ON u.id=a.user_id
     JOIN exam_packages p ON p.id=a.package_id
     ${where} ORDER BY a.id DESC LIMIT ? OFFSET ?`,
  )
    .bind(...binds, per, (page - 1) * per)
    .all<{
      id: number;
      status: string;
      score: number | null;
      passed: number | null;
      started_at: string;
      submitted_at: string | null;
      duration_seconds: number | null;
      correct_count: number | null;
      wrong_count: number | null;
      unanswered_count: number | null;
      user_name: string;
      user_email: string;
      package_title: string;
    }>();
  const results = (rows.results ?? []).map((r) => ({
    ...r,
    max_score:
      ((r.correct_count ?? 0) + (r.wrong_count ?? 0) + (r.unanswered_count ?? 0)) * 5,
  }));

  return ok(c, { results, total: totalRow?.n ?? 0, page, per_page: per });
});

export default overview;
