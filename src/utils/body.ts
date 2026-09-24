import type { Context } from 'hono';

// Batas ukuran body JSON sebelum di-parse.
// Tanpa ini, body puluhan MB bisa OOM isolate 128MB dan mereset request lain
// yang kebetulan berbagi isolate.
export const BODY_LIMIT = 64 * 1024; // 64 KB — endpoint biasa (login, jawaban, dsb.)
export const BODY_LIMIT_IMPORT = 8 * 1024 * 1024; // 8 MB — import soal admin (maks 500 soal)

/**
 * Baca body sebagai teks secara STREAMING dengan batas ukuran.
 * `request.text()` mem-buffer SELURUH body ke memori sebelum bisa dicek —
 * attacker cukup mengirim body ratusan MB tanpa Content-Length (chunked)
 * untuk me-OOM isolate 128 MB dan mereset request lain yang berbagi isolate.
 * Di sini data dibaca bertahap per chunk dan stream dibatalkan begitu jumlah
 * byte melewati batas, sehingga memori yang dipakai tidak pernah melebihi limit.
 */
async function readBodyText(req: Request, maxBytes: number): Promise<string | null> {
  if (!req.body) return '';
  const reader = req.body.getReader();
  const dec = new TextDecoder();
  let out = '';
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel(); // berhenti menarik sisa data dari klien
        return null;
      }
      out += dec.decode(value, { stream: true });
    }
    out += dec.decode(); // flush sisa byte UTF-8 di decoder
  } catch {
    return null;
  }
  return out;
}

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

  const text = await readBodyText(c.req.raw, maxBytes);
  if (text === null) return null;

  try {
    const v: unknown = JSON.parse(text);
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
