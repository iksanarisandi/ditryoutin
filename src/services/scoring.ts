// Penilaian attempt: benar = 5 poin, salah/kosong = 0.
// Skor total & skor kategori dalam poin; maksimum = jumlah soal x 5.
// Seluruh perhitungan di server; hasil disimpan agar immutable.

// Poin per jawaban benar.
export const POINTS_PER_CORRECT = 5;

type AttemptMeta = {
  id: number;
  user_id: number;
  package_id: number;
  status: string;
  started_at: string;
  expires_at: string;
  duration_minutes: number;
  passing_grade_total: number | null;
};

async function getAttemptMeta(db: D1Database, attemptId: number): Promise<AttemptMeta | null> {
  return db
    .prepare(
      `SELECT a.id, a.user_id, a.package_id, a.status, a.started_at, a.expires_at,
              p.duration_minutes, p.passing_grade_total
       FROM attempts a JOIN exam_packages p ON p.id = a.package_id WHERE a.id = ?`,
    )
    .bind(attemptId)
    .first<AttemptMeta>();
}

export type CategoryScore = {
  category_id: number;
  name: string;
  correct: number;
  wrong: number;
  unanswered: number;
  total: number;
  score: number;
  max_score: number;
};

// Finalisasi attempt: hitung skor, simpan, ubah status menjadi submitted.
// Dipanggil saat user submit, atau otomatis (auto=true) ketika waktu habis.
export async function scoreAndFinalize(
  db: D1Database,
  attemptId: number,
  auto: boolean,
): Promise<void> {
  const attempt = await getAttemptMeta(db, attemptId);
  if (!attempt || attempt.status !== 'in_progress') return;

  const rows = await db
    .prepare(
      `SELECT aq.id AS aq_id, aq.user_answer, q.correct_answer, q.category_id, c.name AS category_name
       FROM attempt_questions aq
       JOIN questions q ON q.id = aq.question_id
       JOIN categories c ON c.id = q.category_id
       WHERE aq.attempt_id = ?`,
    )
    .bind(attemptId)
    .all<{ aq_id: number; user_answer: string | null; correct_answer: string; category_id: number; category_name: string }>();

  const list = rows.results ?? [];
  let correct = 0;
  let wrong = 0;
  let unanswered = 0;
  const byCat = new Map<number, CategoryScore>();
  const isCorrectById = new Map<number, number>();

  for (const r of list) {
    let ok = 0;
    if (r.user_answer == null) unanswered++;
    else if (r.user_answer === r.correct_answer) {
      correct++;
      ok = 1;
    } else wrong++;
    isCorrectById.set(r.aq_id, ok);

    let cat = byCat.get(r.category_id);
    if (!cat) {
      cat = { category_id: r.category_id, name: r.category_name, correct: 0, wrong: 0, unanswered: 0, total: 0, score: 0, max_score: 0 };
      byCat.set(r.category_id, cat);
    }
    if (r.user_answer == null) cat.unanswered++;
    else if (ok) cat.correct++;
    else cat.wrong++;
    cat.total++;
  }
  for (const cat of byCat.values()) {
    cat.score = cat.correct * POINTS_PER_CORRECT;
    cat.max_score = cat.total * POINTS_PER_CORRECT;
  }

  const total = list.length;
  const score = correct * POINTS_PER_CORRECT;

  // Passing grade paket. Prioritas: (1) aturan per kategori — hanya kategori yang
  // benar-benar muncul dalam attempt yang dievaluasi; (2) jika tidak ada aturan
  // kategori, pakai passing grade total paket; (3) keduanya absen -> null (tanpa status kelulusan).
  const rules = await db
    .prepare(
      `SELECT pg.category_id, pg.minimum_score FROM passing_grades pg WHERE pg.package_id = ?`,
    )
    .bind(attempt.package_id)
    .all<{ category_id: number; minimum_score: number }>();
  const applicable = (rules.results ?? []).filter((r) => byCat.has(r.category_id));
  let passed: boolean | null;
  if (applicable.length) {
    passed = applicable.every((r) => (byCat.get(r.category_id) as CategoryScore).score >= r.minimum_score);
  } else if (attempt.passing_grade_total != null) {
    passed = score >= attempt.passing_grade_total;
  } else {
    passed = null;
  }

  const nowIso = new Date().toISOString();
  const allowedSec = attempt.duration_minutes * 60;
  const elapsed = Math.min(
    allowedSec,
    Math.max(0, Math.round((Date.parse(nowIso) - Date.parse(attempt.started_at)) / 1000)),
  );

  await db.batch([
    db
      .prepare(
        `UPDATE attempts SET status='submitted', submitted_at=?, score=?, correct_count=?, wrong_count=?,
         unanswered_count=?, passed=?, auto_submitted=?, duration_seconds=?, category_scores=?
         WHERE id=? AND status='in_progress'`,
      )
      .bind(
        nowIso, score, correct, wrong, unanswered, passed, auto ? 1 : 0, elapsed,
        JSON.stringify([...byCat.values()]), attemptId,
      ),
    ...[...isCorrectById.entries()].map(([aqId, ok]) =>
      db.prepare('UPDATE attempt_questions SET is_correct=? WHERE id=?').bind(ok, aqId),
    ),
  ]);
}

// Finalisasi malas (lazy): attempt in_progress yang sudah lewat expires_at langsung di-auto-submit.
export async function finalizeUserExpiredAttempts(db: D1Database, userId: number): Promise<void> {
  const rows = await db
    .prepare(`SELECT id FROM attempts WHERE user_id=? AND status='in_progress' AND expires_at<=?`)
    .bind(userId, new Date().toISOString())
    .all<{ id: number }>();
  for (const r of rows.results ?? []) {
    await scoreAndFinalize(db, r.id, true);
  }
}

export async function finalizeIfExpired(db: D1Database, attemptId: number): Promise<boolean> {
  const a = await getAttemptMeta(db, attemptId);
  if (!a || a.status !== 'in_progress') return false;
  if (Date.parse(a.expires_at) > Date.now()) return false;
  await scoreAndFinalize(db, attemptId, true);
  return true;
}
