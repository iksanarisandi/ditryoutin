import { Hono } from 'hono';
import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';
import {
  GoogleAuthError,
  exchangeGoogleCode,
  googleAuthUrl,
  googleEnabled,
  googleRedirectUri,
  pkceChallenge,
} from '../services/google';
import { afterSignup } from '../services/signup';
import { normalizeRefCode } from '../services/referrals';
import { createSession, generateToken, isSecureRequest, sessionSetCookie } from '../utils/session';
import { normalizeEmail, trimStr } from '../utils/validate';
import { clientIp, isLimited } from '../middleware/ratelimit';
import { timingSafeEqual } from '../middleware/security';
import type { AppEnv } from '../types';

// Login dengan Google: GET /api/auth/google → Google → GET /api/auth/google/callback.
// Keduanya navigasi top-level (bukan fetch), jadi semua hasil berupa redirect;
// kegagalan kembali ke halaman asal dengan ?google_error=<kode> (pesan di app.js).

const google = new Hono<AppEnv>();

const FLOW_COOKIE = 'g_oauth';
const FLOW_TTL_S = 600;

// Password yang mustahil cocok (bukan string PHC → verifyPassword selalu false).
// Akun Google-only tetap bisa membuat password lewat "Lupa password".
const NO_PASSWORD = '!google-only';

type From = 'login' | 'register';
type Flow = { s: string; v: string; n: string | null; r: string; f: From };

// Hanya path relatif di situs sendiri — "//host" dan "/\host" ditafsirkan
// browser sebagai URL absolut (open redirect).
function safeNext(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 512) return null;
  if (!v.startsWith('/') || v.startsWith('//') || v.startsWith('/\\')) return null;
  if (/[\u0000-\u001f]/.test(v)) return null;
  return v;
}

function flowCookie(value: string, maxAge: number, secure: boolean): string {
  // SameSite=Lax: cookie ikut terkirim saat Google me-redirect balik (navigasi
  // top-level GET lintas situs). Path sempit = tidak ikut ke request lain.
  return `${FLOW_COOKIE}=${value}; Path=/api/auth/google; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

function encodeFlow(f: Flow): string {
  let bin = '';
  for (const b of new TextEncoder().encode(JSON.stringify(f))) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeFlow(raw: string | undefined): Flow | null {
  if (!raw || raw.length > 2048) return null;
  try {
    const b64 = raw.replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
    const o = JSON.parse(new TextDecoder().decode(bytes)) as Partial<Flow>;
    if (typeof o.s !== 'string' || typeof o.v !== 'string') return null;
    return {
      s: o.s,
      v: o.v,
      n: safeNext(o.n),
      r: normalizeRefCode(o.r),
      f: o.f === 'register' ? 'register' : 'login',
    };
  } catch {
    return null;
  }
}

function backWithError(
  c: Context<AppEnv>,
  from: From,
  code: string,
  next: string | null = null,
  ref = '',
): Response {
  const p = new URLSearchParams({ google_error: code });
  if (next) p.set('next', next);
  if (ref && from === 'register') p.set('ref', ref);
  return c.redirect(`/${from}.html?${p.toString()}`, 302);
}

google.get('/', async (c) => {
  const from: From = c.req.query('from') === 'register' ? 'register' : 'login';
  const next = safeNext(c.req.query('next'));
  const ref = normalizeRefCode(c.req.query('ref'));
  if (!googleEnabled(c.env)) return backWithError(c, from, 'unavailable', next, ref);

  // Cookie alur tidak berlaku lintas subdomain dan callback terdaftar di
  // apex — mulai ulang di ditryout.in agar cookie & callback satu origin.
  const fwd = c.req.header('x-forwarded-proto');
  const url = new URL(c.req.url);
  if (fwd && !c.env.GOOGLE_REDIRECT_URI && url.hostname === 'www.ditryout.in') {
    return c.redirect(`https://ditryout.in${url.pathname}${url.search}`, 302);
  }

  const flow: Flow = { s: generateToken(), v: generateToken(), n: next, r: ref, f: from };
  const redirectUri = googleRedirectUri(c.env, fwd);
  c.header('Set-Cookie', flowCookie(encodeFlow(flow), FLOW_TTL_S, isSecureRequest(c)));
  c.header('Cache-Control', 'no-store');
  return c.redirect(googleAuthUrl(c.env, redirectUri, flow.s, await pkceChallenge(flow.v)), 302);
});

type UserRow = {
  id: number;
  name: string;
  email: string;
  role: 'user' | 'admin';
  google_sub: string | null;
  email_verified_at: string | null;
};
const USER_COLS = 'id, name, email, role, google_sub, email_verified_at';

google.get('/callback', async (c) => {
  const secure = isSecureRequest(c);
  const flow = decodeFlow(getCookie(c, FLOW_COOKIE));
  // Cookie alur sekali pakai — hapus apa pun hasilnya.
  c.header('Set-Cookie', flowCookie('', 0, secure), { append: true });
  c.header('Cache-Control', 'no-store');
  const from = flow?.f ?? 'login';
  const next = flow?.n ?? null;
  const ref = flow?.r ?? '';

  const gErr = c.req.query('error');
  if (gErr) return backWithError(c, from, gErr === 'access_denied' ? 'cancelled' : 'failed', next, ref);

  // state di URL harus sama dengan state di cookie: mencegah penyerang
  // menyuntikkan kode otorisasi miliknya ke browser korban (login CSRF).
  const state = c.req.query('state') ?? '';
  const code = c.req.query('code') ?? '';
  if (!flow || !state || !code || !timingSafeEqual(state, flow.s)) {
    return backWithError(c, from, 'expired', next, ref);
  }
  if (!googleEnabled(c.env)) return backWithError(c, from, 'unavailable', next, ref);
  if (await isLimited(c, 'RATE_LIMIT_OAUTH', `ip:${clientIp(c)}`)) {
    return backWithError(c, from, 'limited', next, ref);
  }

  let identity;
  try {
    identity = await exchangeGoogleCode(
      c.env,
      code,
      flow.v,
      googleRedirectUri(c.env, c.req.header('x-forwarded-proto')),
    );
  } catch (e) {
    console.error('[google] tukar kode gagal', e instanceof GoogleAuthError ? e.message : e);
    return backWithError(c, from, 'failed', next, ref);
  }
  // Inti fitur ini = email terbukti valid; email Google yang belum
  // diverifikasi (jarang, akun non-Gmail) diperlakukan sama seperti tidak ada.
  const email = normalizeEmail(identity.email);
  if (!identity.emailVerified || !email) return backWithError(c, from, 'unverified', next, ref);

  const DB = c.env.DB;
  const now = new Date().toISOString();
  let user = await DB.prepare(`SELECT ${USER_COLS} FROM users WHERE google_sub=?`)
    .bind(identity.sub)
    .first<UserRow>();
  let isNew = false;

  if (user) {
    await DB.prepare(
      'UPDATE users SET failed_attempts=0, locked_until=NULL, email_verified_at=COALESCE(email_verified_at, ?), updated_at=? WHERE id=?',
    )
      .bind(now, now, user.id)
      .run();
  } else {
    const byEmail = await DB.prepare(`SELECT ${USER_COLS} FROM users WHERE email=?`)
      .bind(email)
      .first<UserRow>();
    if (byEmail) {
      // Email sama tapi sudah terhubung ke akun Google LAIN (mis. alamat Gmail
      // didaur ulang) — jangan diam-diam ambil alih; minta bantuan admin.
      if (byEmail.google_sub && byEmail.google_sub !== identity.sub) {
        return backWithError(c, from, 'conflict', next, ref);
      }
      // Penautan otomatis hanya bila Google otoritatif atas email tersebut
      // (panduan Google untuk account linking); selain itu pemilik akun
      // diminta masuk dengan password seperti biasa.
      if (!identity.emailAuthoritative) {
        return backWithError(c, from, 'exists', next, ref);
      }
      // Akun lama yang emailnya BELUM pernah terbukti bisa saja didaftarkan
      // orang lain memakai email ini; password-nya dimatikan saat pemilik asli
      // pertama kali masuk via Google (bisa dibuat ulang lewat Lupa password).
      // Admin dikecualikan: akunnya dibuat sendiri lewat /setup.
      const killPassword = !byEmail.email_verified_at && byEmail.role !== 'admin';
      const stmts = [
        DB.prepare(
          `UPDATE users SET google_sub=?, email_verified_at=COALESCE(email_verified_at, ?),
             failed_attempts=0, locked_until=NULL${killPassword ? ', password_hash=?' : ''}, updated_at=?
           WHERE id=? AND google_sub IS NULL`,
        ).bind(
          ...(killPassword
            ? [identity.sub, now, NO_PASSWORD, now, byEmail.id]
            : [identity.sub, now, now, byEmail.id]),
        ),
      ];
      if (killPassword) {
        stmts.push(DB.prepare('DELETE FROM password_reset_tokens WHERE user_id=?').bind(byEmail.id));
      }
      await DB.batch(stmts);
      user = byEmail;
    } else {
      const name = trimStr(identity.name, 100) ?? email.split('@')[0];
      try {
        const res = await DB.prepare(
          'INSERT INTO users (name, email, password_hash, google_sub, email_verified_at) VALUES (?, ?, ?, ?, ?)',
        )
          .bind(name, email, NO_PASSWORD, identity.sub, now)
          .run();
        user = {
          id: Number(res.meta.last_row_id),
          name,
          email,
          role: 'user',
          google_sub: identity.sub,
          email_verified_at: now,
        };
        isNew = true;
      } catch (e) {
        // Klik ganda / dua tab: request lain menang membuat akun yang sama.
        if (!String(e).includes('UNIQUE')) throw e;
        user = await DB.prepare(`SELECT ${USER_COLS} FROM users WHERE google_sub=?`)
          .bind(identity.sub)
          .first<UserRow>();
        if (!user) return backWithError(c, from, 'failed', next, ref);
      }
    }
  }

  if (isNew) {
    await afterSignup(c.env, c.executionCtx, user, ref, 'google');
  }

  const token = await createSession(DB, c.env.SESSION_SECRET, user.id);
  c.header('Set-Cookie', sessionSetCookie(token, secure), { append: true });
  const dest = next ?? (user.role === 'admin' ? '/admin/' : '/dashboard.html');
  return c.redirect(dest, 302);
});

export default google;
