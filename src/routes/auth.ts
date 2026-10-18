import { Hono } from 'hono';
import type { Context } from 'hono';
import { fail, ok } from '../utils/response';
import { hashPassword, verifyPassword, sha256Hex } from '../utils/hash';
import {
  clearSessionCookie,
  createSession,
  generateToken,
  isSecureRequest,
  sessionSetCookie,
} from '../utils/session';
import { sendPasswordResetEmail } from '../services/resend';
import { afterSignup } from '../services/signup';
import { normalizeEmail, trimStr, validPassword } from '../utils/validate';
import { readJson } from '../utils/body';
import { accessActive, requireAuth } from '../middleware/auth';
import { ipRateLimit, clientIp, isLimited } from '../middleware/ratelimit';
import { verifyTurnstile } from '../services/turnstile';
import { finalizeUserExpiredAttempts } from '../services/scoring';
import { reconcilePendingPayments } from '../services/payments';
import { googleEnabled } from '../services/google';
import { effectiveStreak } from '../services/streak';
import type { AppEnv } from '../types';

const auth = new Hono<AppEnv>();

const MAX_FAILED = 5;
const LOCK_MS = 15 * 60 * 1000;
const LOCKED_MSG =
  'Akun terkunci sementara karena terlalu banyak percobaan gagal. Coba lagi dalam beberapa menit.';
// Hash argon2id dummy agar email tidak terdaftar pun menjalankan verifikasi (mengurangi timing oracle).
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

// Rate limit ketat per IP untuk endpoint yang mahal/disalahgunakan.
// Register = vektor utama penghabisan kuota TULIS D1; login = CPU argon2 + brute force.
// Forgot/reset memakai BUCKET TERPISAH (bukan RATE_LIMIT_AUTH) supaya dibor-bor
// keduanya TIDAK ikut mengunci login pengguna lain di IP/NAT yang sama — dan
// sebaliknya, banjir login tidak memakan jatah reset password orang.
auth.use('/register', ipRateLimit('RATE_LIMIT_REGISTER'));
auth.use('/login', ipRateLimit('RATE_LIMIT_AUTH'));
// Kirim email Resend = paling sensitif: 5x/15 menit per IP (manusia butuh 1-2x).
auth.use('/forgot-password', ipRateLimit('RATE_LIMIT_FORGOT'));
// Argon2 + tulis D1, manusia kirim sekali: 6x/10 menit per IP.
auth.use('/reset-password', ipRateLimit('RATE_LIMIT_RESET'));

// Konfigurasi halaman login/daftar: captcha (site key memang publik) + apakah
// tombol Login dengan Google ditampilkan.
auth.get('/captcha', (c) =>
  ok(c, {
    enabled: !!(c.env.TURNSTILE_SITE_KEY && c.env.TURNSTILE_SECRET_KEY),
    site_key: c.env.TURNSTILE_SITE_KEY ?? null,
    google: googleEnabled(c.env),
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

  await afterSignup(c.env, c.executionCtx, { id: userId, email, name }, body.ref, 'register');

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

  // Verifikasi password SEBELUM menilai lockout: pemilik akun dengan password
  // BENAR tetap bisa masuk walau akun terkunci — kunci hanya berlaku untuk
  // percobaan password SALAH berikutnya. Tanpa ini, siapa pun bisa mengunci
  // akun orang lain selamanya cukup dengan 5 password ngawur dari IP mana pun
  // (Turnstile sudah diverifikasi sebelum argon2, jadi jalur ini tidak bisa
  // dipakai membakar CPU secara gratis).
  const valid = verifyPassword(password, user?.password_hash ?? DUMMY_HASH);

  if (!user) {
    // Email tidak terdaftar: kunci virtual per-email (counter DO, 5x/15 menit)
    // membuat pola responsnya identik dengan akun sungguhan yang terkunci —
    // menutup oracle "email ada/tidak ada".
    const vLocked = await isLimited(c, 'RATE_LIMIT_LOGINFAIL', `email:${email}`);
    if (vLocked) return fail(c, LOCKED_MSG, 429);
    return fail(c, 'Email atau password salah', 401);
  }

  const locked = !!user.locked_until && Date.parse(user.locked_until) > Date.now();
  if (!valid) {
    const failed = user.failed_attempts + 1;
    // Kunci dihitung termasuk percobaan INI — `locked` saja dibaca dari row
    // sebelum update, jadi tanpa `lockNow` pesan 429 baru muncul di percobaan ke-6.
    const lockNow = failed >= MAX_FAILED;
    const lockedUntil = lockNow ? new Date(Date.now() + LOCK_MS).toISOString() : null;
    await c.env.DB.prepare(
      'UPDATE users SET failed_attempts=?, locked_until=?, updated_at=? WHERE id=?',
    )
      .bind(failed, lockedUntil, new Date().toISOString(), user.id)
      .run();
    return locked || lockNow
      ? fail(c, LOCKED_MSG, 429)
      : fail(c, 'Email atau password salah', 401);
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
  await reconcilePendingPayments(c.env, user.id, c.executionCtx);
  const fresh = await c.env.DB.prepare(
    'SELECT access_expires_at, access_started_at, streak_current, streak_best, streak_last_day FROM users WHERE id=?',
  )
    .bind(user.id)
    .first<{
      access_expires_at: string | null;
      access_started_at: string | null;
      streak_current: number;
      streak_best: number;
      streak_last_day: string | null;
    }>();

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
    streak: effectiveStreak(fresh?.streak_current, fresh?.streak_best, fresh?.streak_last_day),
  });
});

// Heartbeat ringan untuk halaman ujian: memastikan sesi masih valid
// (401 = sesi dicabut, mis. akun login di perangkat lain). POST agar respons
// tidak pernah di-cache edge; sengaja bukan /me yang menjalankan finalisasi
// attempt + rekonsiliasi pembayaran setiap kali dipanggil.
auth.post('/heartbeat', requireAuth, async (c) => ok(c, { ok: true }));

// Reset password via email (Resend): minta tautan -> email berisi token
// sekali-pakai (1 jam) -> pakai token untuk set password baru di /reset.html.
// Respons NETRAL apa pun yang terjadi — tidak membocorkan email terdaftar/tidak.
const RESET_TTL_MS = 60 * 60 * 1000; // 1 jam
const FORGOT_NEUTRAL_MSG =
  'Jika email terdaftar, tautan reset password sudah dikirim. Periksa kotak masuk dan folder spam.';

auth.post('/forgot-password', async (c) => {
  const body = await readJson(c);
  // Turnstile dulu: tanpa ini bot bisa memompa email (menghabiskan kuota Resend)
  // dan meng enumerasi email lewat perbedaan waktu respons (ada vs tidak ada email terkirim).
  const captchaFail = await checkTurnstile(c, body ?? {});
  if (captchaFail) return captchaFail;

  const email = normalizeEmail(body?.email);
  if (email) {
    // Anti mail-bomb lintas IP: maks 3 email ke SATU alamat per 24 jam
    // (penyerang bisa rotasi IP, alamat korban tidak bisa). Dihitung juga
    // untuk email yang tidak terdaftar dan dicek DIAM-DIAM — respons tetap
    // netral 200 supaya batas ini tidak jadi oracle keberadaan email.
    const emailLimited = await isLimited(c, 'RATE_LIMIT_FORGOT_EMAIL', `email:${email}`);
    const user = await c.env.DB.prepare('SELECT id FROM users WHERE email=?')
      .bind(email)
      .first<{ id: number }>();
    if (user && !emailLimited) {
      // Satu tautan aktif per user: hapus token lama, buat yang baru.
      const token = generateToken();
      await c.env.DB.batch([
        c.env.DB.prepare('DELETE FROM password_reset_tokens WHERE user_id=?').bind(user.id),
        c.env.DB.prepare(
          'INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)',
        )
          .bind(user.id, await sha256Hex(token), new Date(Date.now() + RESET_TTL_MS).toISOString()),
      ]);
      if (c.env.RESEND_API_KEY) {
        const origin = new URL(c.req.url).origin;
        await sendPasswordResetEmail(
          c.env,
          user.id,
          email,
          `${origin}/reset.html?token=${token}`,
        );
      } else {
        // Salah konfigurasi (bukan salah user) — log keras agar cepat terlihat di tail.
        console.error('[forgot-password] RESEND_API_KEY belum diset — email tidak terkirim');
      }
    }
  }
  return ok(c, { message: FORGOT_NEUTRAL_MSG });
});

// Tukar token dari email dengan password baru. Token sekali pakai; sukses reset
// juga menghapus SEMUA token user lain + SEMUA sesinya (logout semua perangkat —
// standar keamanan setelah reset) dan membuka kunci lockout login.
auth.post('/reset-password', async (c) => {
  const body = await readJson(c);
  if (!body) return fail(c, 'Body tidak valid', 422);
  const token = trimStr(body.token, 128);
  const password = body.password;
  if (!token) return fail(c, 'Tautan reset tidak valid', 422);
  if (!validPassword(password)) return fail(c, 'Password minimal 8 karakter', 422);

  const row = await c.env.DB.prepare(
    'SELECT id, user_id, expires_at, used_at FROM password_reset_tokens WHERE token_hash=?',
  )
    .bind(await sha256Hex(token))
    .first<{ id: number; user_id: number; expires_at: string; used_at: string | null }>();

  if (!row || row.used_at || Date.parse(row.expires_at) <= Date.now()) {
    return fail(
      c,
      'Tautan reset tidak valid atau sudah kedaluwarsa. Minta tautan baru di halaman lupa password.',
      400,
    );
  }

  const now = new Date().toISOString();
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE password_reset_tokens SET used_at=? WHERE id=?').bind(now, row.id),
    c.env.DB.prepare('DELETE FROM password_reset_tokens WHERE user_id=? AND id<>?')
      .bind(row.user_id, row.id),
    // Token dari email terpakai = kepemilikan email terbukti.
    c.env.DB.prepare(
      'UPDATE users SET password_hash=?, failed_attempts=0, locked_until=NULL, email_verified_at=COALESCE(email_verified_at, ?), updated_at=? WHERE id=?',
    ).bind(hashPassword(password), now, now, row.user_id),
    c.env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(row.user_id),
  ]);
  return ok(c, { message: 'Password berhasil diganti. Silakan masuk dengan password baru.' });
});

export default auth;
