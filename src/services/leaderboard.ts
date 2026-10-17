// Papan peringkat (leaderboard) sepanjang waktu.
//
// Poin = Σ skor PERCOBAAN PERTAMA di tiap paket aktif + PASS_BONUS per paket
// yang lulus di percobaan pertama itu. Alasan:
// - Percobaan pertama: mengulang paket yang pembahasannya sudah dilihat hanya
//   menguji hafalan — ulangan tetap boleh untuk latihan, tapi tidak mengubah poin.
// - Tanpa penalti gagal: peserta yang belum siap tidak menghindari tryout demi
//   menjaga peringkat; selisih bonus lulus sudah cukup membedakan.
// - Hanya paket active=1: plafon poin sama untuk semua peserta, jadi pengguna
//   baru tetap bisa mengejar pengguna lama.
// Papan dipisah per jenis ujian (UPKP / Ujian Dinas / lainnya) karena jumlah
// soal & passing grade-nya berbeda. Admin tidak ikut.
//
// Query membaca tabel attempts saja (1 baris per tryout; attempt_questions tidak
// disentuh) lewat covering index idx_attempts_user_status_package.

import { effectiveStreak } from './streak';

export const PASS_BONUS = 100;
export const LEADERBOARD_TOP = 50;

export type BoardKey = 'upkp' | 'udin' | 'lainnya';
export const BOARD_LABELS: Record<BoardKey, string> = {
  upkp: 'UPKP',
  udin: 'Ujian Dinas',
  lainnya: 'Lainnya',
};
const BOARD_ORDER: BoardKey[] = ['upkp', 'udin', 'lainnya'];

// Klasifikasi sama dengan defaultRulesKey() (passing-grades.ts) & tabOf() di
// dashboard. LIKE di SQLite case-insensitive untuk ASCII; '_' = wildcard satu
// karakter, jadi '%UJIAN_DINAS%' mencakup "Ujian Dinas" dan "UJIAN_DINAS".
const BOARD_SQL = `CASE WHEN p.exam_type LIKE '%UJIAN_DINAS%' THEN 'udin'
                        WHEN p.exam_type LIKE '%UPKP%' THEN 'upkp'
                        ELSE 'lainnya' END`;

// CTE peringkat penuh. Seri dipecah: lebih banyak lulus, lalu yang lebih dulu
// mencapai poinnya (submit terakhir yang menyumbang poin lebih awal).
const RANKED_CTE = `
  WITH firsts AS (
    SELECT user_id, package_id, MIN(id) AS id
    FROM attempts WHERE status='submitted'
    GROUP BY user_id, package_id
  ),
  agg AS (
    SELECT f.user_id, ${BOARD_SQL} AS board,
           SUM(COALESCE(a.score, 0) + CASE WHEN a.passed=1 THEN ?1 ELSE 0 END) AS points,
           SUM(CASE WHEN a.passed=1 THEN 1 ELSE 0 END) AS passed_count,
           COUNT(*) AS package_count,
           MAX(a.submitted_at) AS reached_at
    FROM firsts f
    JOIN attempts a ON a.id = f.id
    JOIN exam_packages p ON p.id = f.package_id AND p.active = 1
    JOIN users u ON u.id = f.user_id AND u.role = 'user'
    GROUP BY f.user_id, board
  ),
  ranked AS (
    SELECT agg.*,
           ROW_NUMBER() OVER (PARTITION BY board
             ORDER BY points DESC, passed_count DESC, reached_at ASC, user_id ASC) AS rank,
           COUNT(*) OVER (PARTITION BY board) AS total
    FROM agg
  )`;

type RankedRow = {
  user_id: number;
  board: BoardKey;
  points: number;
  passed_count: number;
  package_count: number;
  rank: number;
  total: number;
};

// "Rina Susanti" → "Rina S."; disembunyikan / nama berisi email → "Peserta".
export function displayName(name: string, hidden: boolean): string {
  if (hidden) return 'Peserta';
  const words = String(name || '').trim().split(/\s+/).filter((w) => w && !w.includes('@'));
  if (!words.length) return 'Peserta';
  const first = words[0].charAt(0).toUpperCase() + words[0].slice(1).toLowerCase();
  const initial = words[1] ? ` ${words[1].charAt(0).toUpperCase()}.` : '';
  return (first + initial).slice(0, 40);
}

export type BoardEntry = {
  rank: number;
  name: string;
  hidden: boolean;
  points: number;
  passed_count: number;
  package_count: number;
  streak: number;
};
export type Board = { key: BoardKey; label: string; total: number; entries: BoardEntry[] };

// Top-N tiap papan. Identik untuk semua orang → aman di-cache edge
// (tidak memuat user_id maupun data per-viewer).
export async function topBoards(db: D1Database): Promise<Board[]> {
  const now = Date.now();
  const rows = await db
    .prepare(
      `${RANKED_CTE}
       SELECT r.board, r.points, r.passed_count, r.package_count, r.rank, r.total,
              u.name, u.leaderboard_hidden, u.streak_current, u.streak_best, u.streak_last_day
       FROM ranked r JOIN users u ON u.id = r.user_id
       WHERE r.rank <= ?2
       ORDER BY r.board, r.rank`,
    )
    .bind(PASS_BONUS, LEADERBOARD_TOP)
    .all<
      RankedRow & {
        name: string;
        leaderboard_hidden: number;
        streak_current: number;
        streak_best: number;
        streak_last_day: string | null;
      }
    >();

  const boards = new Map<BoardKey, Board>();
  for (const r of rows.results ?? []) {
    let b = boards.get(r.board);
    if (!b) {
      b = { key: r.board, label: BOARD_LABELS[r.board] ?? r.board, total: r.total, entries: [] };
      boards.set(r.board, b);
    }
    const hidden = !!r.leaderboard_hidden;
    b.entries.push({
      rank: r.rank,
      name: displayName(r.name, hidden),
      hidden,
      points: r.points,
      passed_count: r.passed_count,
      package_count: r.package_count,
      streak: effectiveStreak(r.streak_current, r.streak_best, r.streak_last_day, now).current,
    });
  }
  return BOARD_ORDER.filter((k) => boards.has(k)).map((k) => boards.get(k) as Board);
}

export type Standing = {
  rank: number;
  total: number;
  points: number;
  passed_count: number;
  package_count: number;
};

// Posisi satu peserta di tiap papan (per-user — jangan di-cache edge).
export async function userStandings(db: D1Database, userId: number): Promise<Partial<Record<BoardKey, Standing>>> {
  const rows = await db
    .prepare(
      `${RANKED_CTE}
       SELECT board, rank, total, points, passed_count, package_count
       FROM ranked WHERE user_id = ?2`,
    )
    .bind(PASS_BONUS, userId)
    .all<RankedRow>();
  const out: Partial<Record<BoardKey, Standing>> = {};
  for (const r of rows.results ?? []) {
    out[r.board] = {
      rank: r.rank,
      total: r.total,
      points: r.points,
      passed_count: r.passed_count,
      package_count: r.package_count,
    };
  }
  return out;
}

export type PackageRank = {
  rank: number;
  total: number;
  first_attempt_id: number;
  first_score: number;
};

// Peringkat peserta di SATU paket berdasarkan percobaan pertamanya (skor lebih
// tinggi menang; seri → yang submit lebih dulu). null = belum ada percobaan
// tersubmit / bukan peserta biasa. Memakai idx_attempts_package_status_user.
export async function packageRank(db: D1Database, userId: number, packageId: number): Promise<PackageRank | null> {
  const mine = await db
    .prepare(
      `SELECT id, score, submitted_at FROM attempts
       WHERE user_id=? AND package_id=? AND status='submitted' ORDER BY id LIMIT 1`,
    )
    .bind(userId, packageId)
    .first<{ id: number; score: number | null; submitted_at: string }>();
  if (!mine) return null;
  const score = mine.score ?? 0;

  const row = await db
    .prepare(
      `WITH firsts AS (
         SELECT MIN(id) AS id FROM attempts
         WHERE package_id=?1 AND status='submitted' GROUP BY user_id
       )
       SELECT COUNT(*) AS total,
              SUM(CASE WHEN COALESCE(a.score, 0) > ?2
                        OR (COALESCE(a.score, 0) = ?2 AND a.submitted_at < ?3) THEN 1 ELSE 0 END) AS ahead
       FROM firsts f
       JOIN attempts a ON a.id = f.id
       JOIN users u ON u.id = a.user_id AND u.role = 'user'`,
    )
    .bind(packageId, score, mine.submitted_at)
    .first<{ total: number; ahead: number | null }>();
  if (!row || !row.total) return null;
  return {
    rank: (row.ahead ?? 0) + 1,
    total: row.total,
    first_attempt_id: mine.id,
    first_score: score,
  };
}
