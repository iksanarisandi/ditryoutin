import { Hono } from 'hono';
import { fail, ok } from './utils/response';
import { attachUser, requireAdmin } from './middleware/auth';
import { originGuard, securityHeaders } from './middleware/security';
import { clientIp, limitOr429, rateLimit } from './middleware/ratelimit';
import { PakasirError } from './services/pakasir';
import { POINTS_PER_CORRECT } from './services/scoring';

import authRoutes from './routes/auth';
import setupRoutes from './routes/setup';
import packagesRoutes from './routes/packages';
import attemptsRoutes from './routes/attempts';
import resultsRoutes from './routes/results';
import paymentsRoutes from './routes/payments';
import adminUsersRoutes from './routes/admin/users';
import overviewRoutes from './routes/admin/overview';
import adminQuestionsRoutes from './routes/admin/questions';
import { adminCategories, adminPackages, adminProducts } from './routes/admin/catalog';
import type { AppEnv, Env } from './types';

const app = new Hono<AppEnv>();

// Paksa HTTPS di domain produksi (zone default Cloudflare tidak mengalihkan HTTP).
// HANYA edge Cloudflare asli yang meng-set X-Forwarded--Proto (nilai klien asli,
// tidak bisa dipalsukan visitor). `wrangler dev` tidak pernah meng-set header ini
// (dan menulis-ulang host request menjadi domain custom), jingga dev lokal tak pernah redirect.
app.use('*', async (c, next) => {
  const proto = c.req.header('x-forwarded-proto') || '';
  if (proto === 'http') {
    const url = new URL(c.req.url);
    return c.redirect('https://' + url.host + url.pathname + url.search, 301);
  }
  await next();
});

// Batas umum semua /api/* per IP — menahan flood sebelum menyentuh D1.
// (Dipasang SEBELUM attachUser agar request terbatas tidak membayar query sesi.)
app.use('/api/*', rateLimit('RATE_LIMIT_API', (c) => `ip:${clientIp(c)}`));

app.use('*', attachUser);

// Batas khusus endpoint tulis (POST/PUT/DELETE di luar auth/setup) per USER —
// kunci per user, bukan IP, agar sekelas/laboratorium di belakang satu NAT
// tidak saling memblokir saat ujian. Anonim (mis. webhook) dihitung per IP.
app.use('/api/*', async (c, next) => {
  if (c.req.method === 'GET' || c.req.method === 'HEAD') return next();
  const path = new URL(c.req.url).pathname;
  if (path.startsWith('/api/auth/') || path.startsWith('/api/setup')) return next();
  const user = c.get('user');
  const blocked = await limitOr429(c, 'RATE_LIMIT_WRITE', user ? `u:${user.id}` : `ip:${clientIp(c)}`);
  if (blocked) return blocked;
  await next();
});

app.use('*', originGuard);
app.use('*', securityHeaders);

app.route('/api/auth', authRoutes);
app.route('/api/setup', setupRoutes);
app.route('/api/packages', packagesRoutes);
app.route('/api/attempts', attemptsRoutes);
app.route('/api/results', resultsRoutes);
app.route('/api/payments', paymentsRoutes);

// Produk akses aktif — publik untuk landing page. Data hampir statis:
// cache 60 detik di edge agar landing page yang ramai tidak menghantam D1.
// manual_available: apakah tombol Bayar Manual tampil (bukan rahasia — hanya flag UI).
app.get('/api/products', async (c) => {
  const cacheKey = new Request(c.req.url, { method: 'GET' });
  const hit = await caches.default.match(cacheKey);
  if (hit) return hit;

  const manualAvailable = c.env.PAYMENT_MODE === 'manual' || c.env.SHOW_MANUAL_PAYMENT === 'true';
  const rows = await c.env.DB.prepare(
    'SELECT id, name, price, duration_days FROM products WHERE active=1 ORDER BY price',
  ).all();
  const res = ok(c, { products: rows.results ?? [], manual_available: manualAvailable });
  res.headers.set('Cache-Control', 'public, max-age=0, s-maxage=60');
  c.executionCtx.waitUntil(caches.default.put(cacheKey, res.clone()));
  return res;
});

// Statistik publik untuk landing page (jumlah paket/soal/pengguna).
// Angka berubah lambat — cache 3 jam di edge (per colo) supaya D1 hanya
// disentuh ~8x/hari per colo berapa pun ramainya landing page.
// Paket hanya yang active=1 dan soal yang belum di-soft-delete — persis
// seperti yang dilihat peserta di /api/packages.
const SITE_STATS_TTL = 3 * 60 * 60; // detik — ubah interval refresh di sini
app.get('/api/site-stats', async (c) => {
  const cacheKey = new Request(c.req.url, { method: 'GET' });
  const hit = await caches.default.match(cacheKey);
  if (hit) return hit;

  const row = await c.env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM exam_packages WHERE active=1) AS packages,
       (SELECT COUNT(*) FROM questions WHERE deleted_at IS NULL) AS questions,
       (SELECT COUNT(*) FROM users WHERE role='user') AS users`,
  ).first<{ packages: number; questions: number; users: number }>();

  const res = ok(c, {
    packages: row?.packages ?? 0,
    questions: row?.questions ?? 0,
    users: row?.users ?? 0,
  });
  res.headers.set('Cache-Control', `public, max-age=0, s-maxage=${SITE_STATS_TTL}`);
  c.executionCtx.waitUntil(caches.default.put(cacheKey, res.clone()));
  return res;
});

// Bukti sosial untuk popup landing page: hasil tryout terbaru yang LULUS.
// Privasi: hanya nama depan peserta, hanya yang lulus, maks. 30 hari terakhir,
// satu entri per peserta (attempt terbarunya). Cache 60 detik di edge.
app.get('/api/recent-results', async (c) => {
  const cacheKey = new Request(c.req.url, { method: 'GET' });
  const hit = await caches.default.match(cacheKey);
  if (hit) return hit;

  const since = new Date(Date.now() - 30 * 86400000).toISOString();
  const rows = await c.env.DB.prepare(
    `SELECT a.user_id, u.name, p.title, a.score, a.submitted_at,
            a.correct_count, a.wrong_count, a.unanswered_count
     FROM attempts a
     JOIN users u ON u.id = a.user_id
     JOIN exam_packages p ON p.id = a.package_id
     WHERE a.status='submitted' AND a.passed=1 AND a.submitted_at >= ?
     ORDER BY a.submitted_at DESC LIMIT 60`,
  )
    .bind(since)
    .all<{
      user_id: number;
      name: string;
      title: string;
      score: number | null;
      submitted_at: string;
      correct_count: number | null;
      wrong_count: number | null;
      unanswered_count: number | null;
    }>();

  const seen = new Set<number>();
  const results: {
    first_name: string;
    title: string;
    score: number;
    max_score: number;
    submitted_at: string;
  }[] = [];
  for (const r of rows.results ?? []) {
    if (seen.has(r.user_id)) continue;
    seen.add(r.user_id);
    results.push({
      first_name: r.name.trim().split(/\s+/)[0] || 'Peserta',
      title: r.title,
      score: Math.round(r.score ?? 0),
      max_score:
        ((r.correct_count ?? 0) + (r.wrong_count ?? 0) + (r.unanswered_count ?? 0)) *
        POINTS_PER_CORRECT,
      submitted_at: r.submitted_at,
    });
    if (results.length >= 15) break;
  }

  const res = ok(c, { results });
  res.headers.set('Cache-Control', 'public, max-age=0, s-maxage=60');
  c.executionCtx.waitUntil(caches.default.put(cacheKey, res.clone()));
  return res;
});

// ================= ADMIN =================
const admin = new Hono<AppEnv>();
admin.use('*', requireAdmin);
admin.route('/users', adminUsersRoutes);
admin.route('/questions', adminQuestionsRoutes);
admin.route('/products', adminProducts);
admin.route('/packages', adminPackages);
admin.route('/categories', adminCategories);
admin.route('/', overviewRoutes); // /stats, /payments, /results
app.route('/api/admin', admin);

app.notFound((c) => {
  const path = new URL(c.req.url).pathname;
  if (path.startsWith('/api/')) return fail(c, 'Endpoint tidak ditemukan', 404);
  return c.text('Halaman tidak ditemukan', 404);
});

app.onError((err, c) => {
  console.error(`[${c.req.method}] ${new URL(c.req.url).pathname}`, err);
  if (err instanceof PakasirError) return fail(c, err.message, 502);
  return fail(c, 'Terjadi kesalahan internal', 500);
});

// Cron harian: hapus session kedaluwarsa agar tabel tidak membengkak
// (setiap login/daftar menambah baris; tanpa ini baris menumpuk selamanya).
async function cleanupExpiredSessions(env: Env): Promise<void> {
  await env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?')
    .bind(new Date().toISOString())
    .run();
}

export default {
  fetch: app.fetch,
  scheduled: async (_event: ScheduledController, env: Env) => {
    await cleanupExpiredSessions(env);
  },
} satisfies ExportedHandler<Env>;

// Durable Object rate limiter — wajib di-export dari modul utama.
export { RateLimiter } from './do/ratelimit';
