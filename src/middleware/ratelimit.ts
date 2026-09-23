import { createMiddleware } from 'hono/factory';
import type { Context } from 'hono';
import { fail } from '../utils/response';
import type { AppEnv, Env } from '../types';

// Rate limiting berbasis binding Cloudflare (wrangler.jsonc -> unsafe.bindings).
// - RATE_LIMIT_API:      semua /api/* per IP (proteksi flood + hemat baca D1)
// - RATE_LIMIT_AUTH:     login / forgot-password / setup per IP
// - RATE_LIMIT_REGISTER: register per IP (vektor utama penghabisan kuota tulis D1)
// - RATE_LIMIT_WRITE:    endpoint tulis per user (autosave ujian) atau per IP (anonim)
//
// Jika binding tidak ada / error, request DIIZINKAN (fail-open) — rate limit
// tidak boleh membuat situs mati total, hanya membatasi.

type LimiterName = keyof Pick<
  Env,
  'RATE_LIMIT_API' | 'RATE_LIMIT_AUTH' | 'RATE_LIMIT_REGISTER' | 'RATE_LIMIT_WRITE'
>;

// IP asli klien di edge Cloudflare (tidak bisa dipalsukan visitor).
// Fallback 'unknown' untuk lingkungan tanpa edge (wrangler dev).
export function clientIp(c: Context): string {
  return c.req.header('cf-connecting-ip') || 'unknown';
}

/** Jalankan cek limit; kembalikan respons 429 jika terlampau, atau null jika boleh lanjut. */
export async function limitOr429(
  c: Context<AppEnv>,
  limiterName: LimiterName,
  key: string,
): Promise<Response | null> {
  const limiter = c.env[limiterName] as RateLimit | undefined;
  if (!limiter) return null;
  try {
    const { success } = await limiter.limit({ key });
    if (!success) {
      c.header('Retry-After', '60');
      return fail(c, 'Terlalu banyak permintaan. Tunggu sebentar lalu coba lagi.', 429);
    }
  } catch (e) {
    console.error(`[ratelimit] ${limiterName} error`, e);
  }
  return null;
}

/** Middleware rate limit dengan key tetap per request (mis. per IP). */
export function rateLimit(limiterName: LimiterName, keyFn: (c: Context<AppEnv>) => string) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const blocked = await limitOr429(c, limiterName, keyFn(c));
    if (blocked) return blocked;
    await next();
  });
}

/** Rate limit per IP — untuk endpoint auth yang ketat. */
export function ipRateLimit(limiterName: LimiterName) {
  return rateLimit(limiterName, (c) => `ip:${clientIp(c)}`);
}
