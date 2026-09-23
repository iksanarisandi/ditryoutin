import { createMiddleware } from 'hono/factory';
import type { Context } from 'hono';
import { fail } from '../utils/response';
import type { AppEnv } from '../types';

// Rate limiting berbasis Durable Object (src/do/ratelimit.ts).
// Binding "ratelimit" bawaan Cloudflare ternyata tidak enforce pada akun ini
// (limit() selalu success=true), jadi counter dipindah ke DO yang pasti jalan
// di semua plan dan strongly-consistent per key.
//
// - RATE_LIMIT_API:      semua /api/* per IP (proteksi flood + hemat baca D1)
// - RATE_LIMIT_AUTH:     login / forgot-password / setup per IP
// - RATE_LIMIT_REGISTER: register per IP (vektor utama penghabisan kuota tulis D1)
// - RATE_LIMIT_WRITE:    endpoint tulis per user (autosave ujian) atau per IP (anonim)
//
// Jika DO error, request DIIZINKAN (fail-open) — rate limit tidak boleh
// membuat situs mati total, hanya membatasi.

export type LimiterName =
  | 'RATE_LIMIT_API'
  | 'RATE_LIMIT_AUTH'
  | 'RATE_LIMIT_REGISTER'
  | 'RATE_LIMIT_WRITE';

const LIMITS: Record<LimiterName, { limit: number; period: number }> = {
  RATE_LIMIT_API: { limit: 300, period: 60 },
  RATE_LIMIT_AUTH: { limit: 12, period: 60 },
  RATE_LIMIT_REGISTER: { limit: 6, period: 60 },
  RATE_LIMIT_WRITE: { limit: 90, period: 60 },
};

// IP asli klien di edge Cloudflare (tidak bisa dipalsukan visitor).
// Fallback 'unknown' untuk lingkungan tanpa edge (wrangler dev).
export function clientIp(c: Context): string {
  return c.req.header('cf-connecting-ip') || 'unknown';
}

/** Jalankan cek limit via Durable Object; kembalikan respons 429 jika terlampau, atau null jika boleh lanjut. */
export async function limitOr429(
  c: Context<AppEnv>,
  limiterName: LimiterName,
  key: string,
): Promise<Response | null> {
  const ns = c.env.RATE_LIMIT_DO;
  if (!ns) return null;
  try {
    // Satu instance DO per (limiter, key) — window terpisah antar namespace.
    const id = ns.idFromName(`${limiterName}:${key}`);
    const res = await ns.get(id).fetch('https://do/rate-limit', {
      method: 'POST',
      body: JSON.stringify(LIMITS[limiterName]),
    });
    const { success } = (await res.json()) as { success: boolean };
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
