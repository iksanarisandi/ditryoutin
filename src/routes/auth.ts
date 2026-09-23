import { Hono } from 'hono';
import type { Context } from 'hono';
import { fail, ok } from '../utils/response';
import { hashPassword, verifyPassword } from '../utils/hash';
import { clearSessionCookie, createSession, isSecureRequest, sessionSetCookie } from '../utils/session';
import { normalizeEmail, trimStr, validPassword } from '../utils/validate';
import { readJson } from '../utils/body';
import { accessActive, requireAuth } from '../middleware/auth';
import { ipRateLimit, clientIp } from '../middleware/ratelimit';
import { verifyTurnstile } from '../services/turnstile';
import { finalizeUserExpiredAttempts } from '../services/scoring';
import { reconcilePendingPayments } from '../services/payments';
import type { AppEnv } from '../types';

const auth = new Hono<AppEnv>();

const MAX_FAILED = 5;
const LOCK_MS = 15 * 60 * 1000;
// Hash argon2id dummy agar email tidak terdaftar pun menjalankan verifikasi (mengurangi timing oracle).
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

// Rate limit ketat per IP untuk endpoint yang mahal/disalahgunakan.
// Register = vektor utama penghabisan kuota TULIS D1; login = CPU argon2 + brute force.
auth.use('/register', ipRateLimit('RATE_LIMIT_REGISTER'));
auth.use('/login', ipRateLimit('RATE_LIMIT_AUTH'));
auth.use('/forgot-password', ipRateLimit('RATE_LIMIT_AUTH'));

// Konfigurasi captcha untuk frontend (site key memang publik).
auth.get('/captcha', (c) =>
  ok(c, {
    enabled: !!(c.env.TURNSTILE_SITE_KEY && c.env.TURNSTILE_SECRET_KEY),
    site_key: c.env.TURNSTILE_SITE_KEY ?? null,
  }),
);

// Verifikasi Turnstile jika dikonfigurasi. Token tunggal-pakai.
async function checkTurnstile(
  c: Context<AppEnv>,
  body: Record<string, unknown>,
): Promise<Response | null> {
  const { TURNSTILE_SITE_KEY, TURNSTILE_SECRET_KEY } = c.env;
  if (!TURNSTILE_SITE_KEY || !TURNSTILE_SECRET_KEY) return null;
  const token = typeof body.turnstile_token === 'string' ? body.turnstile_token : '';
  if (!token) {
    return fail(c, 'Verifikasi keamanan belum selesai — tunggu sebentar lalu coba lagi.', 422);
  }
  const okCaptcha = await verifyTurnstile(TURNSTILE_SECRET_KEY, token, clientIp(c));
  if (!okCaptcha) return fail(c, 'Verifikasi keamanan gagal. Muat ulang halaman lalu coba lagi.', 403);
  return null;
}

auth.post('/register', async (c) => {
  const body = await readJson(c);
  if (!body) return fail(c, 'Body tidak valid');

  const captchaFail = await checkTurnstile(c, body);
  if (captchaFail) return captchaFail;

  const name = trimStr(body.name, 100);
  const email = normalizeEmail(body.email);
  const password = body.password;

  if (!name) return fail(c, 'Nama wajib diisi', 422);
  if (!email) return fail(c, 'Email tidak valid', 422);
  if (!validPassword(password)) return fail(c, 'Password minimal 8 karakter', 422);

  const exists = await c.env.DB.prepare('SELECT id FROM users WHERE email=?').bind(email).first();
  if (exists) return fail(c, 'Email sudah terdaftar', 409);

  const passwordHash = hashPassword(password);
  const res = await c.env.DB.prepare(
    'INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)',
  )
    .bind(name, email, passwordHash)
    .run();
  const userId = Number(res.meta.last_row_id);

  const token = await createSession(c.env.DB, c.env.SESSION_SECRET, userId);
  c.header('Set-Cookie', sessionSetCookie(token, isSecureRequest(c)));
  return ok(c, { user: { id: userId, name, email, role: 'user' } }, 201);
});

auth.post('/login', async (c) => {
  const body = await readJson(c);
  if (!body) return fail(c, 'Email dan password wajib diisi', 422);
  const email = normalizeEmail(body.email);
  const password = typeof body.password === 'string' ? body.password : '';
  if (!email || !password) return fail(c, 'Email dan password wajib diisi', 422);

  // Turnstile dicek SEBELUM verifikasi argon2 agar request tanpa captcha
  // tidak bisa dipakai membakar CPU (hash dummy pun sama mahalnya).
  const captchaFail = await checkTurnstile(c, body);
  if (captchaFail) return captchaFail;

  const user = await c.env.DB.prepare(
    'SELECT id, name, email, password_hash, role, failed_attempts, locked_until FROM users WHERE email=?',
  )
    .bind(email)
    .first<{
      id: number;
      name: string;
      email: string;
      password_hash: string;
      role: 'user' | 'admin';
      failed_attempts: number;
      locked_until: string | null;
    }>();

  if (user?.locked_until && Date.parse(user.locked_until) > Date.now()) {
    return fail(c, 'Akun terkunci sementara karena terlalu banyak percobaan gagal. Coba lagi dalam beberapa menit.', 429);
  }

  const valid = verifyPassword(password, user?.password_hash ?? DUMMY_HASH);
  if (!user || !valid) {
    if (user) {
      const failed = user.failed_attempts + 1;
      const lockedUntil = failed >= MAX_FAILED ? new Date(Date.now() + LOCK_MS).toISOString() : null;
      await c.env.DB.prepare(
        'UPDATE users SET failed_attempts=?, locked_until=?, updated_at=? WHERE id=?',
      )
        .bind(failed, lockedUntil, new Date().toISOString(), user.id)
        .run();
    }
    return fail(c, 'Email atau password salah', 401);
  }

  await c.env.DB.prepare(
    'UPDATE users SET failed_attempts=0, locked_until=NULL, updated_at=? WHERE id=?',
  )
    .bind(new Date().toISOString(), user.id)
    .run();

  const token = await createSession(c.env.DB, c.env.SESSION_SECRET, user.id);
  c.header('Set-Cookie', sessionSetCookie(token, isSecureRequest(c)));
  return ok(c, { user: { id: user.id, name: user.name, email: user.email, role: user.role } });
});

auth.post('/logout', requireAuth, async (c) => {
  await c.env.DB.prepare('DELETE FROM sessions WHERE id=?').bind(c.get('sessionId')).run();
  c.header('Set-Cookie', clearSessionCookie(isSecureRequest(c)));
  return ok(c, { logged_out: true });
});

auth.get('/me', requireAuth, async (c) => {
  const user = c.get('user');
  // Auto-submit attempt yang kehabisan waktu saat user membuka aplikasi.
  await finalizeUserExpiredAttempts(c.env.DB, user.id);
  // Rekonsiliasi pembayaran pending (fallback saat webhook belum dikonfigurasi).
  await reconcilePendingPayments(c.env, user.id);
  const fresh = await c.env.DB.prepare(
    'SELECT access_expires_at, access_started_at FROM users WHERE id=?',
  )
    .bind(user.id)
    .first<{ access_expires_at: string | null; access_started_at: string | null }>();

  const exp = fresh?.access_expires_at ?? null;
  const active = !!exp && Date.parse(exp) > Date.now();
  return ok(c, {
    user,
    access: {
      active,
      expires_at: exp,
      started_at: fresh?.access_started_at ?? null,
      days_left: active ? Math.ceil((Date.parse(exp as string) - Date.now()) / 86400000) : 0,
    },
    is_admin: user.role === 'admin',
    has_access: user.role === 'admin' || accessActive(user),
  });
});

// Tanpa SMTP: respons netral, arahkan ke admin (tidak membocorkan keberadaan email).
auth.post('/forgot-password', async (c) => {
  return ok(c, { message: 'Jika akun terdaftar, hubungi admin melalui halaman kontak untuk reset password.' });
});

export default auth;
