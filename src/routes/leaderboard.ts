import { Hono } from 'hono';
import type { Context } from 'hono';
import { fail, ok } from '../utils/response';
import { requireAuth } from '../middleware/auth';
import { readJson } from '../utils/body';
import {
  LEADERBOARD_TOP,
  PASS_BONUS,
  topBoards,
  userStandings,
  type Board,
} from '../services/leaderboard';
import { effectiveStreak } from '../services/streak';
import type { AppEnv } from '../types';

// Papan peringkat — hanya untuk user login (nama peserta tidak dipajang ke
// publik). Top-N identik untuk semua orang sehingga di-cache di edge dengan
// key internal; respons ke browser tetap no-store karena request ber-cookie.

const leaderboard = new Hono<AppEnv>();
leaderboard.use('*', requireAuth);

const LEADERBOARD_TTL = 10 * 60; // detik — D1 disentuh maks ~6x/jam per colo

type CachedBoards = { boards: Board[]; generated_at: string };

function cacheKey(c: Context<AppEnv>): Request {
  return new Request(new URL('/__cache/leaderboard-v1', c.req.url).toString(), { method: 'GET' });
}

leaderboard.get('/', async (c) => {
  const key = cacheKey(c);
  let data: CachedBoards | null = null;
  const hit = await caches.default.match(key);
  if (hit) {
    try {
      data = (await hit.json()) as CachedBoards;
    } catch {
      data = null;
    }
  }
  if (!data) {
    data = { boards: await topBoards(c.env.DB), generated_at: new Date().toISOString() };
    const res = new Response(JSON.stringify(data), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': `public, max-age=0, s-maxage=${LEADERBOARD_TTL}`,
      },
    });
    c.executionCtx.waitUntil(caches.default.put(key, res));
  }
  const res = ok(c, {
    ...data,
    top: LEADERBOARD_TOP,
    pass_bonus: PASS_BONUS,
    refresh_minutes: LEADERBOARD_TTL / 60,
  });
  res.headers.set('Cache-Control', 'private, no-store');
  return res;
});

// Posisi saya + pengaturan nama + streak. Per-user → tidak di-cache.
leaderboard.get('/me', async (c) => {
  const user = c.get('user');
  const [standings, row] = await Promise.all([
    userStandings(c.env.DB, user.id),
    c.env.DB.prepare(
      'SELECT leaderboard_hidden, streak_current, streak_best, streak_last_day FROM users WHERE id=?',
    )
      .bind(user.id)
      .first<{ leaderboard_hidden: number; streak_current: number; streak_best: number; streak_last_day: string | null }>(),
  ]);
  return ok(c, {
    is_admin: user.role === 'admin',
    hidden: !!row?.leaderboard_hidden,
    standings,
    streak: effectiveStreak(row?.streak_current, row?.streak_best, row?.streak_last_day),
  });
});

// Sembunyikan / tampilkan nama di papan peringkat.
leaderboard.put('/me', async (c) => {
  const user = c.get('user');
  const body = await readJson(c);
  if (typeof body?.hidden !== 'boolean') return fail(c, 'Pilihan tampilan nama tidak valid', 422);
  await c.env.DB.prepare('UPDATE users SET leaderboard_hidden=? WHERE id=?')
    .bind(body.hidden ? 1 : 0, user.id)
    .run();
  // Hapus cache top-N di colo ini supaya pemiliknya langsung melihat
  // perubahannya; colo lain menyusul saat TTL habis.
  c.executionCtx.waitUntil(caches.default.delete(cacheKey(c)));
  return ok(c, { hidden: body.hidden });
});

export default leaderboard;
