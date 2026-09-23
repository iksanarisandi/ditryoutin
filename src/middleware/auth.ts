import { createMiddleware } from 'hono/factory';
import { getCookie } from 'hono/cookie';
import { fail } from '../utils/response';
import { SESSION_COOKIE, hashToken } from '../utils/session';
import type { AppEnv, SessionUser } from '../types';

// Token sesi = base64url 32 byte = selalu 43 karakter A-Za-z0-9_-.
// Cek format SEBELUM query D1 agar flood cookie acak tidak membebani database.
const SESSION_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

// Melengkapi konteks dengan user dari cookie sesi (jika valid).
export const attachUser = createMiddleware<AppEnv>(async (c, next) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token && SESSION_TOKEN_RE.test(token)) {
    const row = await c.env.DB.prepare(
      `SELECT s.id AS session_id, u.id, u.name, u.email, u.role, u.access_expires_at, u.access_started_at
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ?`,
    )
      .bind(await hashToken(c.env.SESSION_SECRET, token), new Date().toISOString())
      .first<{
        session_id: number;
        id: number;
        name: string;
        email: string;
        role: 'user' | 'admin';
        access_expires_at: string | null;
        access_started_at: string | null;
      }>();
    if (row) {
      const user: SessionUser = {
        id: row.id,
        name: row.name,
        email: row.email,
        role: row.role,
        access_expires_at: row.access_expires_at,
        access_started_at: row.access_started_at,
      };
      c.set('user', user);
      c.set('sessionId', row.session_id);
    }
  }
  await next();
});

export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  if (!c.get('user')) return fail(c, 'Silakan login terlebih dahulu', 401);
  await next();
});

export const requireAdmin = createMiddleware<AppEnv>(async (c, next) => {
  const user = c.get('user');
  if (!user) return fail(c, 'Silakan login terlebih dahulu', 401);
  if (user.role !== 'admin') return fail(c, 'Akses ditolak', 403);
  await next();
});

export function accessActive(user: SessionUser): boolean {
  return !!user.access_expires_at && Date.parse(user.access_expires_at) > Date.now();
}

// User biasa wajib punya akses aktif; admin bebas.
export const requireActiveAccess = createMiddleware<AppEnv>(async (c, next) => {
  const user = c.get('user');
  if (!user) return fail(c, 'Silakan login terlebih dahulu', 401);
  if (user.role !== 'admin' && !accessActive(user)) {
    return fail(c, 'Akses tryout Anda belum aktif. Silakan beli atau perpanjang akses.', 403);
  }
  await next();
});
