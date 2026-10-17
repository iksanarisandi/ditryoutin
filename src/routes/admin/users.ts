import { Hono } from 'hono';
import { fail, ok } from '../../utils/response';
import { requireAdmin } from '../../middleware/auth';
import { hashPassword } from '../../utils/hash';
import { clamp, toInt, trimStr } from '../../utils/validate';
import { readJson } from '../../utils/body';
import { extendUserAccess } from '../../services/payments';
import { CONTACT_SEGMENTS, contactsCsv, exportContacts, isContactSegment } from '../../services/contact-export';
import type { AppEnv } from '../../types';

const adminUsers = new Hono<AppEnv>();
adminUsers.use('*', requireAdmin);

const TEMP_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';

function genTempPassword(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return [...bytes].map((b) => TEMP_CHARS[b % TEMP_CHARS.length]).join('');
}

async function extendAccess(db: D1Database, userId: number, days: number): Promise<string> {
  // Statement atomik bersama settlePayment (services/payments.ts) — baca-ubah-tulis
  // terpisah bisa saling menimpa bila admin memperpanjang bersamaan dengan webhook
  // pembayaran yang settle.
  const newExpiry = await extendUserAccess(db, userId, days);
  return newExpiry ?? new Date().toISOString();
}

adminUsers.get('/', async (c) => {
  const q = trimStr(c.req.query('q'), 100);
  const page = Math.max(1, toInt(c.req.query('page'), 1));
  const per = 20;
  const like = q ? `%${q}%` : null;

  const totalRow = await (q
    ? c.env.DB.prepare('SELECT COUNT(*) AS n FROM users WHERE name LIKE ?1 OR email LIKE ?1').bind(like)
    : c.env.DB.prepare('SELECT COUNT(*) AS n FROM users')
  ).first<{ n: number }>();

  const rows = await (q
    ? c.env.DB.prepare(
        `SELECT id, name, email, role, access_expires_at, access_started_at, created_at, locked_until
         FROM users WHERE name LIKE ?1 OR email LIKE ?1 ORDER BY id DESC LIMIT ?2 OFFSET ?3`,
      ).bind(like, per, (page - 1) * per)
    : c.env.DB.prepare(
        `SELECT id, name, email, role, access_expires_at, access_started_at, created_at, locked_until
         FROM users ORDER BY id DESC LIMIT ?1 OFFSET ?2`,
      ).bind(per, (page - 1) * per)
  ).all();

  return ok(c, { users: rows.results ?? [], total: totalRow?.n ?? 0, page, per_page: per });
});

// Daftarkan sebelum /:id agar "export" tidak dianggap ID pengguna.
adminUsers.get('/export', async (c) => {
  c.header('Cache-Control', 'private, no-store');
  const segment = c.req.query('segment') ?? '';
  const format = c.req.query('format') ?? 'csv';
  const googleOnly = c.req.query('google_only') ?? '0';
  if (!isContactSegment(segment)) return fail(c, 'Kategori ekspor tidak valid.', 400);
  if (format !== 'csv' && format !== 'preview') return fail(c, 'Format ekspor tidak valid.', 400);
  if (googleOnly !== '0' && googleOnly !== '1') return fail(c, 'Filter login Google tidak valid.', 400);

  const now = new Date().toISOString();
  const contacts = await exportContacts(c.env.DB, segment, now, googleOnly === '1');
  if (format === 'preview') return ok(c, { total: contacts.length });

  c.header('Content-Type', 'text/csv; charset=utf-8');
  c.header('Content-Disposition', `attachment; filename="brevo-gmail-${CONTACT_SEGMENTS[segment]}${googleOnly === '1' ? '-login-google' : ''}-${now.slice(0, 10)}.csv"`);
  return c.body(contactsCsv(contacts));
});

adminUsers.get('/:id', async (c) => {
  const id = toInt(c.req.param('id'), 0);
  // invited/rewarded dihitung sebagai subquery skalar di query yang sama —
  // menghemat round-trip D1 per buka detail.
  const u = await c.env.DB.prepare(
    `SELECT id, name, email, role, access_expires_at, access_started_at, referral_code, created_at,
            (SELECT COUNT(*) FROM referrals WHERE referrer_id=users.id) AS invited_count,
            (SELECT COUNT(*) FROM referrals WHERE referrer_id=users.id AND rewarded_at IS NOT NULL) AS rewarded_count
     FROM users WHERE id=?`,
  )
    .bind(id)
    .first<{ invited_count: number; rewarded_count: number }>();
  if (!u) return fail(c, 'User tidak ditemukan', 404);

  const paymentRows = await c.env.DB.prepare(
    `SELECT pm.id, pm.reference, pm.amount, pm.status, pm.paid_at, pm.created_at, pr.name AS product_name
     FROM payments pm JOIN products pr ON pr.id=pm.product_id
     WHERE pm.user_id=? ORDER BY pm.id DESC LIMIT 20`,
  )
    .bind(id)
    .all();
  const attemptRows = await c.env.DB.prepare(
    `SELECT a.id, a.status, a.score, a.passed, a.started_at, a.submitted_at,
            a.correct_count, a.wrong_count, a.unanswered_count, p.title
     FROM attempts a JOIN exam_packages p ON p.id=a.package_id
     WHERE a.user_id=? ORDER BY a.id DESC LIMIT 20`,
  )
    .bind(id)
    .all<{
      id: number;
      status: string;
      score: number | null;
      passed: number | null;
      started_at: string;
      submitted_at: string | null;
      correct_count: number | null;
      wrong_count: number | null;
      unanswered_count: number | null;
      title: string;
    }>();
  const attempts = (attemptRows.results ?? []).map((r) => ({
    ...r,
    max_score:
      ((r.correct_count ?? 0) + (r.wrong_count ?? 0) + (r.unanswered_count ?? 0)) * 5,
  }));

  return ok(c, {
    user: u,
    referral: { invited_count: u.invited_count ?? 0, rewarded_count: u.rewarded_count ?? 0 },
    payments: paymentRows.results ?? [],
    attempts,
  });
});

// Reset password user: password sementara ditampilkan sekali ke admin.
adminUsers.post('/:id/reset-password', async (c) => {
  const id = toInt(c.req.param('id'), 0);
  const u = await c.env.DB.prepare('SELECT id FROM users WHERE id=?').bind(id).first();
  if (!u) return fail(c, 'User tidak ditemukan', 404);

  const temp = genTempPassword();
  const hash = hashPassword(temp);
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE users SET password_hash=?, failed_attempts=0, locked_until=NULL, updated_at=? WHERE id=?`,
    ).bind(hash, new Date().toISOString(), id),
    c.env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(id),
  ]);
  return ok(c, { temp_password: temp });
});

// Tambah masa akses manual (untuk support, misal pembayaran bermasalah).
adminUsers.post('/:id/extend-access', async (c) => {
  const id = toInt(c.req.param('id'), 0);
  const body = await readJson(c);
  const days = clamp(toInt(body?.days, 0), 1, 3650);

  const u = await c.env.DB.prepare('SELECT id FROM users WHERE id=?').bind(id).first();
  if (!u) return fail(c, 'User tidak ditemukan', 404);

  const expiresAt = await extendAccess(c.env.DB, id, days);
  return ok(c, { access_expires_at: expiresAt, days_added: days });
});

export default adminUsers;
export { extendAccess };
