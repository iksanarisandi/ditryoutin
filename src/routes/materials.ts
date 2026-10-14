import { Hono } from 'hono';
import { fail, ok } from '../utils/response';
import { requireAuth } from '../middleware/auth';
import { limitOr429 } from '../middleware/ratelimit';
import { toInt, trimStr } from '../utils/validate';
import type { AppEnv } from '../types';

// Materi bacaan PDF — bisa dibaca SEMUA user yang login (tidak perlu
// langganan aktif). Byte file di-serve dari R2 lewat route ini (aset statis
// mem-bypass Worker sehingga tidak bisa digerbang sesi).

const materials = new Hono<AppEnv>();
materials.use('*', requireAuth);

// Daftar materi + kategori aktif sekali jalan (untuk tab & kartu halaman /materi.html).
materials.get('/', async (c) => {
  const categoryId = toInt(c.req.query('category_id'), 0);
  const q = trimStr(c.req.query('q'), 100);

  const conds = ['m.active=1', 'c.active=1'];
  const binds: unknown[] = [];
  if (categoryId > 0) {
    conds.push('m.category_id=?');
    binds.push(categoryId);
  }
  if (q) {
    conds.push('(m.title LIKE ? OR m.description LIKE ?)');
    binds.push(`%${q}%`, `%${q}%`);
  }

  const rows = await c.env.DB.prepare(
    `SELECT m.id, m.title, m.description, m.category_id, c.name AS category_name,
            m.file_size, m.page_count, m.created_at
     FROM materials m JOIN material_categories c ON c.id=m.category_id
     WHERE ${conds.join(' AND ')}
     ORDER BY m.created_at DESC, m.id DESC LIMIT 500`,
  )
    .bind(...binds)
    .all();
  const cats = await c.env.DB.prepare(
    'SELECT id, name FROM material_categories WHERE active=1 ORDER BY name',
  ).all();
  return ok(c, { materials: rows.results ?? [], categories: cats.results ?? [] });
});

// Metadata satu materi (header halaman pembaca).
materials.get('/:id', async (c) => {
  const id = toInt(c.req.param('id'), 0);
  const row = await c.env.DB.prepare(
    `SELECT m.id, m.title, m.description, c.name AS category_name, m.file_size, m.page_count
     FROM materials m JOIN material_categories c ON c.id=m.category_id
     WHERE m.id=? AND m.active=1 AND c.active=1`,
  )
    .bind(id)
    .first();
  if (!row) return fail(c, 'Materi tidak ditemukan', 404);
  return ok(c, { material: row });
});

// Byte PDF. `?download=1` → Content-Disposition attachment (tombol Unduh).
// Cache HANYA browser (private) — cache edge mengabaikan cookie dan akan
// membocorkan PDF ke pengunjung anonim yang berbagi colo.
materials.get('/:id/file', async (c) => {
  // Limiter per-user khusus byte PDF: cache browser (private) membuat tiap hit
  // nyata men-stream dari R2 lewat Worker, jadi batasi abuse bandwidth per akun
  // (menembus batas /api umum yang per-IP). Longgar agar range-request pdf.js lolos.
  const blocked = await limitOr429(c, 'RATE_LIMIT_MATERIAL', `u:${c.get('user').id}`);
  if (blocked) return blocked;

  const id = toInt(c.req.param('id'), 0);
  const row = await c.env.DB.prepare(
    'SELECT file_key, original_filename, file_size FROM materials WHERE id=? AND active=1',
  )
    .bind(id)
    .first<{ file_key: string; original_filename: string; file_size: number }>();
  if (!row) return fail(c, 'Materi tidak ditemukan', 404);

  // Konten per key immutable → ETag stabil tanpa R2 head().
  const etag = `"m${id}-${row.file_size}"`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/pdf',
    ETag: etag,
    'Cache-Control': 'private, max-age=86400',
    'Accept-Ranges': 'bytes',
    'Content-Disposition': 'inline',
  };
  if (c.req.query('download') === '1') {
    // RFC 5987: nama file bisa non-ASCII (judul Indonesia) — sediakan fallback ASCII.
    const ascii = row.original_filename.replace(/[^\x20-\x7e]/g, '').replace(/["\\]/g, '').trim() || 'materi.pdf';
    headers['Content-Disposition'] =
      `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(row.original_filename)}`;
  }

  // 304 cepat tanpa menyentuh R2.
  const inm = c.req.header('if-none-match');
  if (inm && inm.split(',').some((v) => v.trim() === etag)) {
    return new Response(null, { status: 304, headers });
  }

  // Range single-range saja ("bytes=a-b" / "bytes=a-" / "bytes=-n").
  // Multi-range/tak terparse → abaikan, serve penuh 200.
  const rangeHeader = c.req.header('range');
  let range: { offset: number; length: number } | null = null;
  if (rangeHeader) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
    if (m && (m[1] !== '' || m[2] !== '')) {
      const size = row.file_size;
      let start: number;
      let end: number;
      if (m[1] === '') {
        const n = parseInt(m[2], 10);
        start = Math.max(0, size - n);
        end = size - 1;
      } else {
        start = parseInt(m[1], 10);
        end = m[2] === '' ? size - 1 : Math.min(parseInt(m[2], 10), size - 1);
      }
      if (start <= end && start < size) {
        range = { offset: start, length: end - start + 1 };
      } else {
        return new Response(null, {
          status: 416,
          headers: { ...headers, 'Content-Range': `bytes */${row.file_size}` },
        });
      }
    }
  }

  const obj = range
    ? await c.env.MATERI_BUCKET.get(row.file_key, { range })
    : await c.env.MATERI_BUCKET.get(row.file_key);
  if (!obj) {
    console.error(`[materi] objek R2 hilang untuk materi ${id}: ${row.file_key}`);
    return fail(c, 'File tidak ditemukan. Silakan hubungi admin.', 404);
  }

  // Catatan: obj.size pada ranged-get = ukuran PENUH objek, bukan panjang
  // range — hitung dari `range` kita agar Content-Length/Content-Range benar.
  headers['Content-Length'] = String(range ? range.length : obj.size);
  if (range) {
    headers['Content-Range'] = `bytes ${range.offset}-${range.offset + range.length - 1}/${row.file_size}`;
  }
  return c.body(obj.body, range ? 206 : 200, headers);
});

export default materials;
