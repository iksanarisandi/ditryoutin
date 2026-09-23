import { Hono } from 'hono';
import { fail, ok } from '../utils/response';
import { hashPassword } from '../utils/hash';
import { createSession, isSecureRequest, sessionSetCookie } from '../utils/session';
import { normalizeEmail, trimStr, validPassword } from '../utils/validate';
import { readJson } from '../utils/body';
import { timingSafeEqual } from '../middleware/security';
import { ipRateLimit } from '../middleware/ratelimit';
import type { AppEnv } from '../types';

// Setup admin pertama: hanya aktif selama belum ada admin sama sekali.
// Kredensial admin tidak pernah ditulis di source code — dimasukkan lewat form ini.
// Jika env SETUP_SECRET diisi (production), form juga menuntut secret tersebut.

const setup = new Hono<AppEnv>();

// Rate limit per IP — endpoint ini tanpa autentikasi selama belum ada admin.
setup.use('/', ipRateLimit('RATE_LIMIT_AUTH'));

async function adminExists(db: D1Database): Promise<boolean> {
  const row = await db.prepare(`SELECT id FROM users WHERE role='admin' LIMIT 1`).first();
  return !!row;
}

// CATATAN: jangan bocorkan apakah SETUP_SECRET dikonfigurasi — cukup "needed".
setup.get('/', async (c) => {
  return ok(c, { needed: !(await adminExists(c.env.DB)) });
});

setup.post('/', async (c) => {
  if (await adminExists(c.env.DB)) {
    return fail(c, 'Admin sudah dibuat. Setup tidak tersedia lagi.', 403);
  }

  const body = await readJson(c);
  if (!body) return fail(c, 'Body tidak valid');

  if (c.env.SETUP_SECRET) {
    const secret = typeof body.secret === 'string' ? body.secret : '';
    if (!timingSafeEqual(secret, c.env.SETUP_SECRET)) {
      return fail(c, 'Secret setup salah', 403);
    }
  }

  const name = trimStr(body.name, 100) ?? 'Admin';
  const email = normalizeEmail(body.email);
  const password = body.password;

  if (!email) return fail(c, 'Email tidak valid', 422);
  if (!validPassword(password)) return fail(c, 'Password minimal 8 karakter', 422);

  const taken = await c.env.DB.prepare('SELECT id FROM users WHERE email=?').bind(email).first();
  if (taken) return fail(c, 'Email sudah terdaftar', 409);

  const passwordHash = hashPassword(password);
  let userId: number;
  try {
    const res = await c.env.DB.prepare(
      `INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'admin')`,
    )
      .bind(name, email, passwordHash)
      .run();
    userId = Number(res.meta.last_row_id);
  } catch (e) {
    // UNIQUE: email terpakai, ATAU race dua setup bersamaan yang sama-sama lolos
    // cek adminExists lalu terhalang partial index idx_users_single_admin.
    if (String(e).includes('UNIQUE')) {
      return fail(c, 'Admin sudah dibuat atau email sudah terdaftar.', 409);
    }
    throw e;
  }

  const token = await createSession(c.env.DB, c.env.SESSION_SECRET, userId);
  c.header('Set-Cookie', sessionSetCookie(token, isSecureRequest(c)));
  return ok(c, { user: { id: userId, name, email, role: 'admin' } }, 201);
});

export default setup;
