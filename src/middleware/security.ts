import { createMiddleware } from 'hono/factory';
import { fail } from '../utils/response';
import type { AppEnv } from '../types';

// Proteksi CSRF sederhana: cookie sesi memakai SameSite=Lax, dan setiap request
// state-changing harus memiliki header Origin yang cocok dengan Host (jika Origin ada).
// Webhook Pakasir (server-ke-server) dikecualikan — divalidasi lewat X-Secret.
export const originGuard = createMiddleware<AppEnv>(async (c, next) => {
  const method = c.req.method;
  if (method === 'GET' || method === 'HEAD') return next();

  const path = new URL(c.req.url).pathname;
  if (path === '/api/payments/webhook') return next();

  const origin = c.req.header('origin');
  if (origin) {
    const host = c.req.header('host');
    try {
      if (new URL(origin).host !== host) {
        return fail(c, 'Origin tidak valid', 403);
      }
    } catch {
      return fail(c, 'Origin tidak valid', 403);
    }
  }
  await next();
});

// Header keamanan untuk semua respons Worker (API & halaman non-aset).
// Aset statis di-serve langsung oleh edge (mem-bypass Worker) — untuk itu
// pakai file public/_headers.
export const securityHeaders = createMiddleware<AppEnv>(async (c, next) => {
  await next();
  let res = c.res;
  try {
    res.headers.set('X-Content-Type-Options', 'nosniff');
  } catch {
    // Respons dari Cache API (HIT) bersifat immutable — salin agar bisa diberi header.
    res = new Response(res.body, res);
    c.res = res;
  }
  res.headers.set('X-Frame-Options', 'DENY');
  res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (new URL(c.req.url).protocol === 'https:') {
    res.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
});

// Perbandingan string konstan-waktu untuk secret webhook.
export function timingSafeEqual(a: string, b: string): boolean {
  const maxLen = Math.max(a.length, b.length);
  let diff = a.length === b.length ? 0 : 1;
  for (let i = 0; i < maxLen; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}
