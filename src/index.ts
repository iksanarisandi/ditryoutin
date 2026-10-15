import { Hono } from 'hono';
import { fail, ok } from './utils/response';
import { attachUser, requireAdmin } from './middleware/auth';
import { originGuard, securityHeaders } from './middleware/security';
import { clientIp, limitOr429, rateLimit } from './middleware/ratelimit';
import { PakasirError } from './services/pakasir';
import { DuitkuError } from './services/duitku';
import { POINTS_PER_CORRECT } from './services/scoring';
import { reconcileStalePayments, sendAbandonedPaymentReminders } from './services/payments';
import { getPaymentMode } from './services/settings';

import authRoutes from './routes/auth';
import googleAuthRoutes from './routes/google-auth';
import setupRoutes from './routes/setup';
import packagesRoutes from './routes/packages';
import attemptsRoutes from './routes/attempts';
import resultsRoutes from './routes/results';
import paymentsRoutes from './routes/payments';
import materialsRoutes from './routes/materials';
import referralRoutes from './routes/referral';
import adminUsersRoutes from './routes/admin/users';
import overviewRoutes from './routes/admin/overview';
import adminSettingsRoutes from './routes/admin/settings';
import adminQuestionsRoutes from './routes/admin/questions';
import { adminCategories, adminPackages, adminProducts } from './routes/admin/catalog';
import { adminMaterialCategories, adminMaterials } from './routes/admin/materials';
import type { AppEnv, Env } from './types';

const app = new Hono<AppEnv>();

// Toleransi path ber-double-slash: mis. webhook gateway dikonfigurasi
// "https://host//api/payments/webhook". Router Hono tidak mencocokkan "//..."
// dengan route mana pun sehingga request 404 mentah — normalisasi dulu ke
// path bersih lalu dispatch ulang lewat seluruh stack middleware (rate limit,
// origin guard, dst. tetap berjalan penuh untuk request hasil normalisasi).
app.use('*', async (c, next) => {
  const url = new URL(c.req.url);
  if (!url.pathname.includes('//')) return next();
  url.pathname = url.pathname.replace(/\/{2,}/g, '/');
  return app.fetch(new Request(url, c.req.raw), c.env, c.executionCtx);
});

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

app.route('/api/auth/google', googleAuthRoutes);
app.route('/api/auth', authRoutes);
app.route('/api/setup', setupRoutes);
app.route('/api/packages', packagesRoutes);
app.route('/api/attempts', attemptsRoutes);
app.route('/api/results', resultsRoutes);
app.route('/api/payments', paymentsRoutes);
app.route('/api/materials', materialsRoutes);
app.route('/api/referral', referralRoutes);

// Produk akses aktif — publik untuk landing page. Data hampir statis:
// cache 60 detik di edge agar landing page yang ramai tidak menghantam D1.
// manual_available: apakah tombol Bayar Manual tampil (bukan rahasia — hanya flag UI).
// manual_forced: mode manual dipaksa — semua transaksi ke alur manual; frontend
// memakainya untuk banner gangguan gateway + menyembunyikan tombol gateway.
// Mode efektif = toggle admin (tabel settings), fallback env — services/settings.
app.get('/api/products', async (c) => {
  const cacheKey = new Request(c.req.url, { method: 'GET' });
  const hit = await caches.default.match(cacheKey);
  if (hit) return hit;

  const mode = await getPaymentMode(c.env);
  const manualForced = mode === 'manual';
  const manualAvailable = mode !== 'gateway';
  const rows = await c.env.DB.prepare(
    'SELECT id, name, price, duration_days, description FROM products WHERE active=1 ORDER BY price',
  ).all();
  const res = ok(c, {
    products: rows.results ?? [],
    manual_available: manualAvailable,
    manual_forced: manualForced,
  });
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

// Bukti sosial untuk popup landing page: campuran tiga jenis aktivitas —
// hasil tryout terbaru yang lulus, peserta yang sedang mengerjakan tryout,
// dan langganan paket terbaru. Privasi: hanya nama depan, tanpa nominal,
// maks. 30 hari terakhir, satu entri per peserta per jenis. Cache 60 detik di edge.
type ProofItem =
  | { type: 'passed'; first_name: string; title: string; score: number; max_score: number; time: string }
  | { type: 'active' | 'purchase'; first_name: string; title: string; time: string };
app.get('/api/recent-results', async (c) => {
  const cacheKey = new Request(c.req.url, { method: 'GET' });
  const hit = await caches.default.match(cacheKey);
  if (hit) return hit;

  const since = new Date(Date.now() - 30 * 86400000).toISOString();
  const now = new Date().toISOString();

  type ProofRow = {
    user_id: number;
    name: string;
    title: string;
    score?: number | null;
    correct_count?: number | null;
    wrong_count?: number | null;
    unanswered_count?: number | null;
    time: string;
  };
  // Ambil maks. `cap` entri, satu per peserta (baris pertama = terbaru).
  const perUser = (rows: ProofRow[], cap: number, to_item: (r: ProofRow) => ProofItem) => {
    const seen = new Set<number>();
    const items: ProofItem[] = [];
    for (const r of rows) {
      if (seen.has(r.user_id)) continue;
      seen.add(r.user_id);
      items.push(to_item(r));
      if (items.length >= cap) break;
    }
    return items;
  };
  // Beberapa peserta mengisi nama dengan email — jangan bocorkan alamatnya.
  const firstName = (n: string) => {
    const first = n.trim().split(/\s+/)[0];
    return !first || first.includes('@') ? 'Peserta' : first;
  };

  const [passedRows, activeRows, paidRows] = await Promise.all([
    c.env.DB.prepare(
      `SELECT a.user_id, u.name, p.title, a.score, a.submitted_at AS time,
              a.correct_count, a.wrong_count, a.unanswered_count
       FROM attempts a
       JOIN users u ON u.id = a.user_id
       JOIN exam_packages p ON p.id = a.package_id
       WHERE a.status='submitted' AND a.passed=1 AND a.submitted_at >= ?
       ORDER BY a.submitted_at DESC LIMIT 60`,
    )
      .bind(since)
      .all<ProofRow>(),
    // "Sedang mengerjakan": hanya attempt yang benar-benar berjalan (belum expired).
    c.env.DB.prepare(
      `SELECT a.user_id, u.name, p.title, a.started_at AS time
       FROM attempts a
       JOIN users u ON u.id = a.user_id
       JOIN exam_packages p ON p.id = a.package_id
       WHERE a.status='in_progress' AND a.expires_at > ?
       ORDER BY a.started_at DESC LIMIT 20`,
    )
      .bind(now)
      .all<ProofRow>(),
    c.env.DB.prepare(
      `SELECT pm.user_id, u.name, pr.name AS title, pm.paid_at AS time
       FROM payments pm
       JOIN users u ON u.id = pm.user_id
       JOIN products pr ON pr.id = pm.product_id
       WHERE pm.status='paid' AND pm.paid_at >= ? AND pr.active=1
       ORDER BY pm.paid_at DESC LIMIT 60`,
    )
      .bind(since)
      .all<ProofRow>(),
  ]);

  const feed: ProofItem[] = [
    ...perUser(passedRows.results ?? [], 15, (r) => ({
      type: 'passed',
      first_name: firstName(r.name),
      title: r.title,
      score: Math.round(r.score ?? 0),
      max_score:
        ((r.correct_count ?? 0) + (r.wrong_count ?? 0) + (r.unanswered_count ?? 0)) *
        POINTS_PER_CORRECT,
      time: r.time,
    })),
    ...perUser(activeRows.results ?? [], 8, (r) => ({
      type: 'active',
      first_name: firstName(r.name),
      title: r.title,
      time: r.time,
    })),
    ...perUser(paidRows.results ?? [], 12, (r) => ({
      type: 'purchase',
      first_name: firstName(r.name),
      title: r.title,
      time: r.time,
    })),
  ];

  const res = ok(c, { feed });
  res.headers.set('Cache-Control', 'public, max-age=0, s-maxage=60');
  c.executionCtx.waitUntil(caches.default.put(cacheKey, res.clone()));
  return res;
});

// Tautan bantuan WhatsApp lewat domain sendiri: email memakai ditryout.in/wa,
// bukan wa.me langsung (URL beda domain pengirim memicu filter spam).
// Tujuan selalu nomor MANUAL_WA — bukan open redirect; `ref` hanya disisipkan
// ke teks pesan bila berformat referensi transaksi.
app.get('/wa', (c) => {
  const wa = (c.env.MANUAL_WA || '').replace(/\D/g, '');
  if (!wa) return c.redirect('/', 302);
  const ref = (c.req.query('ref') || '').toUpperCase();
  const lines = ['Halo admin Tryout UPKP, saya mengalami kendala saat membayar.'];
  if (/^TO-[A-Z0-9-]{1,40}$/.test(ref)) lines.push('Ref: ' + ref);
  lines.push('Mohon bantuannya. Terima kasih.');
  return c.redirect(`https://wa.me/${wa}?text=${encodeURIComponent(lines.join('\n'))}`, 302);
});

// ================= ADMIN =================
const admin = new Hono<AppEnv>();
admin.use('*', requireAdmin);
admin.route('/users', adminUsersRoutes);
admin.route('/questions', adminQuestionsRoutes);
admin.route('/products', adminProducts);
admin.route('/packages', adminPackages);
admin.route('/categories', adminCategories);
admin.route('/materials', adminMaterials);
admin.route('/material-categories', adminMaterialCategories);
admin.route('/settings', adminSettingsRoutes);
admin.route('/', overviewRoutes); // /stats, /payments, /results
app.route('/api/admin', admin);

app.notFound((c) => {
  const path = new URL(c.req.url).pathname;
  if (path.startsWith('/api/')) return fail(c, 'Endpoint tidak ditemukan', 404);
  return c.text('Halaman tidak ditemukan', 404);
});

app.onError((err, c) => {
  console.error(`[${c.req.method}] ${new URL(c.req.url).pathname}`, err);
  if (err instanceof PakasirError || err instanceof DuitkuError) return fail(c, err.message, 502);
  return fail(c, 'Terjadi kesalahan internal', 500);
});

// Cron harian: hapus session kedaluwarsa agar tabel tidak membengkak
// (setiap login/daftar menambah baris; tanpa ini baris menumpuk selamanya),
// sapu juga token reset password kedaluwarsa (sisa yang tidak terpakai),
// lalu rekonsiliasi payment pending (jaring pengaman bila webhook gagal).
async function cleanupExpiredSessions(env: Env): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now).run();
  await env.DB.prepare('DELETE FROM password_reset_tokens WHERE expires_at < ?')
    .bind(now)
    .run();
  // Log email cukup 90 hari (kuota & anti-dobel hanya butuh ≤ 24 jam terakhir).
  // Tabel belum ada (migrasi 0017 belum diterapkan) tidak boleh menggagalkan cron.
  try {
    await env.DB.prepare('DELETE FROM email_log WHERE created_at < ?')
      .bind(new Date(Date.now() - 90 * 86400000).toISOString())
      .run();
  } catch (e) {
    console.error('[cron] email_log cleanup', e);
  }
}

// Sapu objek R2 materi yang yatim: sisa unggah yang gagal masuk DB, atau
// delete yang gagal membersihkan R2. Objek yang baru diunggah (< 1 jam)
// dilewati agar tidak bertabrakan dengan unggahan yang sedang berjalan
// (put selesai sesaat sebelum INSERT masuk).
async function cleanupOrphanMaterials(env: Env): Promise<void> {
  const rows = await env.DB.prepare('SELECT file_key FROM materials').all<{ file_key: string }>();
  const used = new Set((rows.results ?? []).map((r) => r.file_key));
  const cutoff = Date.now() - 3600_000;
  let listing = await env.MATERI_BUCKET.list({ prefix: 'materi/' });
  for (;;) {
    for (const obj of listing.objects) {
      if (!used.has(obj.key) && obj.uploaded.getTime() < cutoff) {
        await env.MATERI_BUCKET.delete(obj.key);
      }
    }
    if (!listing.truncated) break;
    listing = await env.MATERI_BUCKET.list({ prefix: 'materi/', cursor: listing.cursor });
  }
}

// Harus sama persis dengan entri di wrangler.jsonc → triggers.crons.
const REMINDER_CRON = '*/15 * * * *';

export default {
  fetch: app.fetch,
  scheduled: async (event: ScheduledController, env: Env) => {
    if (event.cron === REMINDER_CRON) {
      try {
        await sendAbandonedPaymentReminders(env);
      } catch (e) {
        console.error('[cron:reminder]', e);
      }
      return;
    }
    await cleanupExpiredSessions(env);
    await reconcileStalePayments(env);
    await cleanupOrphanMaterials(env);
  },
} satisfies ExportedHandler<Env>;

// Durable Object rate limiter — wajib di-export dari modul utama.
export { RateLimiter } from './do/ratelimit';
