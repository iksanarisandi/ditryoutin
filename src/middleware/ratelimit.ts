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
// - RATE_LIMIT_AUTH:     login / setup per IP
// - RATE_LIMIT_FORGOT:   forgot-password per IP — kirim email Resend (kuota & biaya)
// - RATE_LIMIT_FORGOT_EMAIL: forgot-password per ALAMAT EMAIL — anti mail-bomb
//                        lintas IP; dicek diam-diam di handler, respons tetap netral
// - RATE_LIMIT_REGISTER: register per IP (vektor utama penghabisan kuota tulis D1)
// - RATE_LIMIT_RESET:    reset-password per IP (argon2 mahal CPU + tulis D1)
// - RATE_LIMIT_WRITE:    endpoint tulis per user (autosave ujian) atau per IP (anonim)
//
// Jika DO error, request DIIZINKAN (fail-open) — rate limit tidak boleh
// membuat situs mati total, hanya membatasi.

export type LimiterName =
  | 'RATE_LIMIT_API'
  | 'RATE_LIMIT_AUTH'
  | 'RATE_LIMIT_FORGOT'
  | 'RATE_LIMIT_FORGOT_EMAIL'
  | 'RATE_LIMIT_REGISTER'
  | 'RATE_LIMIT_RESET'
  | 'RATE_LIMIT_WRITE'
  | 'RATE_LIMIT_LOGINFAIL'
  | 'RATE_LIMIT_RECONCILE'
  | 'RATE_LIMIT_MATERIAL';

const LIMITS: Record<LimiterName, { limit: number; period: number }> = {
  RATE_LIMIT_API: { limit: 300, period: 60 },
  RATE_LIMIT_AUTH: { limit: 12, period: 60 },
  // Bucket TERPISAH dari AUTH: menahan email reset tanpa bisa mengunci login
  // orang lain, dan sebaliknya. Manusia minta reset 1-2x — 5x/15 menit per IP
  // cukup longgar untuk retry typo, cukup ketat untuk melindungi kuota Resend.
  RATE_LIMIT_FORGOT: { limit: 5, period: 900 },
  // Penyerang yang rotasi IP tetap tidak bisa membanjiri inbox SATU korban:
  // maks 3 email per alamat per 15 menit. Window per (email) di DO, jadi
  // strongly-consistent lintas IP/colo.
  RATE_LIMIT_FORGOT_EMAIL: { limit: 3, period: 900 },
  RATE_LIMIT_REGISTER: { limit: 6, period: 60 },
  // Token kedaluwarsa ditolak murah (baca D1 dulu, argon2 hanya untuk token
  // valid); batas ini menahan flood tulis D1 + penggunaan argon2 berulang.
  // Manusia hanya mengirim 1-2x — validasi form ada di klien.
  RATE_LIMIT_RESET: { limit: 6, period: 600 },
  RATE_LIMIT_WRITE: { limit: 90, period: 60 },
  // Kunci virtual per-email untuk login dengan email yang tidak terdaftar:
  // setelah 5 percobaan gagal dalam 15 menit, responsnya 429 "akun terkunci" —
  // sama seperti akun sungguhan — agar pola respons tidak bisa membedakan
  // email ada/tidak ada (anti-enumeration).
  // limit = MAX_FAILED(5) - 1 di src/routes/auth.ts: DO memblokir saat
  // count > limit dan count terinkremen SEBELUM membalas, jadi limit 4 membuat
  // panggilan ke-5 (yang harus membalas 429, persis akun sungguhan) terblokir.
  // period = LOCK_MS (15 menit).
  RATE_LIMIT_LOGINFAIL: { limit: 4, period: 900 },
  // Rekonsiliasi pending payment di /me & /login: maks 1 pass per user per 15
  // detik. Gate persisten (DO) lintas-isolate — throttle in-memory per-isolate
  // tidak cukup karena /me yang dibanjiri bisa memicu polling status Duitku
  // berlebih dari banyak isolate (Duitku memblokir IP merchant ~1 jam).
  RATE_LIMIT_RECONCILE: { limit: 1, period: 15 },
  // Unduh byte PDF materi per user. Longgar agar pdf.js (banyak range-request
  // saat membuka 1 dokumen) tidak pernah tersendat, tapi menutup abuse bandwidth
  // skrip dari satu akun yang menembus batas /api umum (per IP).
  RATE_LIMIT_MATERIAL: { limit: 150, period: 60 },
};

// IP asli klien di edge Cloudflare (tidak bisa dipalsukan visitor).
// Fallback 'unknown' untuk lingkungan tanpa edge (wrangler dev).
export function clientIp(c: Context): string {
  return c.req.header('cf-connecting-ip') || 'unknown';
}

/**
 * Inti cek limit ke Durable Object — menerima namespace DO langsung sehingga
 * bisa dipakai di luar middleware (mis. services, yang tidak punya Context).
 * Kembalikan true bila request masih DIIZINKAN (success), false bila terlampaui.
 * Fail-open (true) bila binding tidak ada / DO error — konsisten dengan kebijakan
 * "rate limit tidak boleh membuat situs mati total".
 */
export async function checkLimit(
  ns: DurableObjectNamespace | undefined,
  limiterName: LimiterName,
  key: string,
): Promise<boolean> {
  if (!ns) return true;
  try {
    // Satu instance DO per (limiter, key) — window terpisah antar namespace.
    const id = ns.idFromName(`${limiterName}:${key}`);
    const res = await ns.get(id).fetch('https://do/rate-limit', {
      method: 'POST',
      body: JSON.stringify(LIMITS[limiterName]),
    });
    const { success } = (await res.json()) as { success: boolean };
    return success;
  } catch (e) {
    console.error(`[ratelimit] ${limiterName} error`, e);
    return true;
  }
}

/** Jalankan cek limit via Durable Object; kembalikan respons 429 jika terlampau, atau null jika boleh lanjut. */
export async function limitOr429(
  c: Context<AppEnv>,
  limiterName: LimiterName,
  key: string,
): Promise<Response | null> {
  const allowed = await checkLimit(c.env.RATE_LIMIT_DO, limiterName, key);
  if (!allowed) {
    c.header('Retry-After', '60');
    return fail(c, 'Terlalu banyak permintaan. Tunggu sebentar lalu coba lagi.', 429);
  }
  return null;
}

/** Cukup-satu-fakta: apakah key ini sudah melewati limit? (tanpa membalas 429) */
export async function isLimited(
  c: Context<AppEnv>,
  limiterName: LimiterName,
  key: string,
): Promise<boolean> {
  return !(await checkLimit(c.env.RATE_LIMIT_DO, limiterName, key));
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
