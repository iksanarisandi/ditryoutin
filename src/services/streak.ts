// Day streak: jumlah hari berturut-turut peserta aktif belajar.
// Hari aktif = submit tryout (minimal STREAK_MIN_ANSWERED soal terjawab) atau
// membuka materi PDF. Batas hari = 00:00 WITA (zona yang tampil di UI).
//
// Biaya: maks 1 tulis per user per hari — UPDATE hanya mengenai baris bila
// streak_last_day < hari aktivitas, aktivitas berikutnya di hari yang sama no-op.
// Putus/tidaknya streak dihitung saat dibaca (effectiveStreak), tanpa cron.

const WITA_OFFSET_MS = 8 * 3600 * 1000; // Asia/Makassar, tanpa DST
const DAY_MS = 86400000;

// Mulai-lalu-submit-kosong tidak boleh menjaga streak.
export const STREAK_MIN_ANSWERED = 10;

// Tanggal WITA (YYYY-MM-DD) dari epoch ms.
export function witaDay(ms: number): string {
  return new Date(ms + WITA_OFFSET_MS).toISOString().slice(0, 10);
}

export function prevDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10);
}

// Satu statement atomik (bukan baca-ubah-tulis): kolom di ruas kanan SET =
// nilai lama baris, jadi dua request bersamaan di hari yang sama tetap
// menghasilkan +1 sekali (yang kedua tidak lolos WHERE).
// `atMs` boleh di masa lalu (attempt yang difinalisasi malas berhari-hari
// kemudian dihitung pada hari waktunya habis); hari yang lebih lama dari
// streak_last_day diabaikan.
export async function recordStreakActivity(db: D1Database, userId: number, atMs = Date.now()): Promise<void> {
  const day = witaDay(Math.min(atMs, Date.now()));
  const yesterday = prevDay(day);
  await db
    .prepare(
      `UPDATE users SET
         streak_current = CASE WHEN streak_last_day = ?2 THEN streak_current + 1 ELSE 1 END,
         streak_best = MAX(streak_best, CASE WHEN streak_last_day = ?2 THEN streak_current + 1 ELSE 1 END),
         streak_last_day = ?1
       WHERE id = ?3 AND (streak_last_day IS NULL OR streak_last_day < ?1)`,
    )
    .bind(day, yesterday, userId)
    .run();
}

// Versi aman untuk jalur penting (submit, buka materi): streak gagal tidak
// boleh menggagalkan alur utamanya.
export async function recordStreakSafe(db: D1Database, userId: number, atMs?: number): Promise<void> {
  try {
    await recordStreakActivity(db, userId, atMs);
  } catch (e) {
    console.error('[streak]', e);
  }
}

export type StreakInfo = {
  current: number;
  best: number;
  last_day: string | null;
  active_today: boolean;
  today: string;
};

// Streak yang tampil: tetap hidup bila aktivitas terakhir hari ini atau kemarin
// (peserta masih punya sisa hari ini untuk melanjutkan), selain itu putus = 0.
export function effectiveStreak(
  current: number | null | undefined,
  best: number | null | undefined,
  lastDay: string | null | undefined,
  nowMs = Date.now(),
): StreakInfo {
  const today = witaDay(nowMs);
  const last = lastDay ?? null;
  const alive = !!last && (last === today || last === prevDay(today));
  return {
    current: alive ? Number(current ?? 0) : 0,
    best: Number(best ?? 0),
    last_day: last,
    active_today: last === today,
    today,
  };
}
