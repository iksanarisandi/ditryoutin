import type { Context } from 'hono';

// Batas ukuran body JSON sebelum di-parse.
// Tanpa ini, body puluhan MB bisa OOM isolate 128MB dan mereset request lain
// yang kebetulan berbagi isolate.
export const BODY_LIMIT = 64 * 1024; // 64 KB — endpoint biasa (login, jawaban, dsb.)
export const BODY_LIMIT_IMPORT = 8 * 1024 * 1024; // 8 MB — import soal admin (maks 500 soal)

/**
 * Baca + parse body JSON dengan batas ukuran.
 * Mengembalikan null jika body terlalu besar / bukan objek JSON valid.
 */
export async function readJson(
  c: Context,
  maxBytes: number = BODY_LIMIT,
): Promise<Record<string, unknown> | null> {
  const cl = parseInt(c.req.header('content-length') ?? '', 10);
  if (Number.isFinite(cl) && cl > maxBytes) return null;

  let text: string;
  try {
    text = await c.req.text();
  } catch {
    return null;
  }
  if (text.length > maxBytes) return null;

  try {
    const v: unknown = JSON.parse(text);
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
