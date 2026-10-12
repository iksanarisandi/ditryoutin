import { Hono } from 'hono';
import { fail, ok } from '../../utils/response';
import { requireAdmin } from '../../middleware/auth';
import { toInt, trimStr } from '../../utils/validate';
import { settlePayment, type PaymentRow } from '../../services/payments';
import type { AppEnv } from '../../types';

const overview = new Hono<AppEnv>();
overview.use('*', requireAdmin);

// "Hari ini" versi Indonesia = mulai 00:00 WIB (UTC+7), bukan 00:00 UTC.
// Tanpa argumen: awal hari ini. Dengan "YYYY-MM-DD": awal hari itu.
// Kembalikan epoch-ms UTC; tanggal tak valid menghasilkan NaN (caller mengecek).
function wibDayStartMs(day?: string): number {
  const WIB = 7 * 3600 * 1000;
  if (day) return Date.parse(`${day}T00:00:00Z`) - WIB;
  return Math.floor((Date.now() + WIB) / 86_400_000) * 86_400_000 - WIB;
}

overview.get('/stats', async (c) => {
  const nowIso = new Date().toISOString();
  const todayWibIso = new Date(wibDayStartMs()).toISOString();
  // Satu batch, bukan Promise.all: batas Workers = 6 koneksi D1 simultan per
  // invokasi, sedangkan di sini ada 9 query — batch menjalankan semuanya lewat
  // satu koneksi dalam satu round-trip (urutan hasil = urutan statement).
  const rows = await c.env.DB.batch<{ n: number; total?: number }>([
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM users WHERE role='user'`),
    c.env.DB.prepare(
      `SELECT COUNT(DISTINCT s.user_id) AS n FROM sessions s JOIN users u ON u.id=s.user_id
       WHERE s.expires_at > ? AND u.role='user'`,
    ).bind(nowIso),
    c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM users WHERE role='user' AND access_expires_at > ?`,
    ).bind(nowIso),
    c.env.DB.prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total FROM payments WHERE status='paid'`,
    ),
    c.env.DB.prepare('SELECT COUNT(*) AS n FROM exam_packages'),
    c.env.DB.prepare('SELECT COUNT(*) AS n FROM questions WHERE deleted_at IS NULL'),
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM attempts WHERE status='submitted'`),
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM users WHERE role='user' AND created_at >= ?`).bind(
      todayWibIso,
    ),
    c.env.DB.prepare(`SELECT COUNT(DISTINCT user_id) AS n FROM payments WHERE status='paid'`),
  ]);
  const [totalUsers, usersOnline, usersWithAccess, payStats, totalPackages, totalQuestions, totalAttempts, newUsersToday, payingUsers] =
    rows.map((r) => r.results?.[0] ?? null);

  return ok(c, {
    stats: {
      total_users: totalUsers?.n ?? 0,
      users_online: usersOnline?.n ?? 0,
      users_with_active_access: usersWithAccess?.n ?? 0,
      new_users_today: newUsersToday?.n ?? 0,
      users_paid_ever: payingUsers?.n ?? 0,
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
  const from = trimStr(c.req.query('from'), 10);
  const to = trimStr(c.req.query('to'), 10);
  const page = Math.max(1, toInt(c.req.query('page'), 1));
  const per = 25;

  // Rentang tanggal WIB ("YYYY-MM-DD", from & to wajib bersama). Hybrid:
  // daftar difilter menurut created_at (transaksi pending tetap terlihat untuk
  // ditandai lunas), sedangkan pendapatan dihitung menurut paid_at (uang
  // benar-benar masuk di rentang itu) — masing-masing jujur untuk keperluannya.
  let range: [string, string] | null = null;
  if (from || to) {
    if (!from || !to) return fail(c, 'Rentang tanggal from & to wajib dipakai bersama', 422);
    const startMs = wibDayStartMs(from);
    const endMs = wibDayStartMs(to) + 86_400_000; // eksklusif: mencakup penuh hari "to"
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs > endMs) {
      return fail(c, 'Rentang tanggal tidak valid', 422);
    }
    range = [new Date(startMs).toISOString(), new Date(endMs).toISOString()];
  }

  const conds: string[] = [];
  const binds: (string | number)[] = [];
  if (status) {
    conds.push('pm.status=?');
    binds.push(status);
  }
  if (range) {
    conds.push('pm.created_at >= ?', 'pm.created_at < ?');
    binds.push(range[0], range[1]);
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

  const totalRow = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM payments pm ${where}`)
    .bind(...binds)
    .first<{ n: number }>();
  const rows = await c.env.DB.prepare(
    `SELECT pm.id, pm.reference, pm.amount, pm.status, pm.method, pm.gateway, pm.paid_at, pm.created_at,
            u.name AS user_name, u.email AS user_email, pr.name AS product_name
     FROM payments pm
     JOIN users u ON u.id=pm.user_id
     JOIN products pr ON pr.id=pm.product_id
     ${where} ORDER BY pm.id DESC LIMIT ? OFFSET ?`,
  )
    .bind(...binds, per, (page - 1) * per)
    .all();

  // Pendapatan: selalu transaksi lunas menurut paid_at dan hanya mengikuti
  // rentang tanggal (bukan filter status — kalau ikut, memfilter "pending"
  // akan menampilkan pendapatan nol).
  const rev = await (
    range
      ? c.env.DB.prepare(
          `SELECT COALESCE(SUM(amount),0) AS total FROM payments
           WHERE status='paid' AND paid_at >= ? AND paid_at < ?`,
        ).bind(...range)
      : c.env.DB.prepare(`SELECT COALESCE(SUM(amount),0) AS total FROM payments WHERE status='paid'`)
  ).first<{ total: number }>();

  return ok(c, {
    payments: rows.results ?? [],
    total: totalRow?.n ?? 0,
    page,
    per_page: per,
    revenue: rev?.total ?? 0,
  });
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
