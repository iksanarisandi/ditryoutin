// Import soal via JSON (format PRD) — validasi ketat, preview, commit atomik (D1 batch).

export type ImportQuestion = {
  question: string;
  options: { A: string; B: string; C: string; D: string; E: string };
  answer: string;
  category: string;
  explanation: string;
};

export type ImportPayload = {
  title: string;
  category: string;
  questions: ImportQuestion[];
};

export type ImportFieldError = { index: number | null; field: string; message: string };

const LIMITS = { question: 4000, option: 2000, explanation: 4000, title: 200, category: 100 };
const MAX_QUESTIONS = 500;

export function parseImportPayload(raw: unknown): { payload?: ImportPayload; error?: string } {
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return { error: 'JSON tidak valid' };
    }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { error: 'Struktur JSON harus objek' };
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.title !== 'string' || !obj.title.trim()) {
    return { error: 'Field "title" wajib berupa teks' };
  }
  if (!Array.isArray(obj.questions) || obj.questions.length === 0) {
    return { error: 'Field "questions" wajib berupa array berisi minimal 1 soal' };
  }
  if (obj.questions.length > MAX_QUESTIONS) {
    return { error: `Maksimal ${MAX_QUESTIONS} soal per import` };
  }
  return { payload: obj as unknown as ImportPayload };
}

function validateString(v: unknown, maxLen: number): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s ? s.slice(0, maxLen) : null;
}

// Normalisasi + validasi seluruh payload. Mengembalikan daftar error (kosong = valid).
export function validateImport(payload: ImportPayload): ImportFieldError[] {
  const errors: ImportFieldError[] = [];
  const title = validateString(payload.title, LIMITS.title);
  if (!title) errors.push({ index: null, field: 'title', message: 'Judul paket wajib diisi' });
  const examType = validateString(payload.category ?? 'UPKP', LIMITS.category) ?? 'UPKP';

  const seen = new Set<string>();
  (payload.questions ?? []).forEach((q, i) => {
    const p = `questions[${i}]`;
    if (typeof q !== 'object' || q === null) {
      errors.push({ index: i, field: p, message: 'Soal harus berupa objek' });
      return;
    }
    const obj = q as Record<string, unknown>;
    if (!validateString(obj.question, LIMITS.question)) {
      errors.push({ index: i, field: `${p}.question`, message: 'Pertanyaan wajib diisi' });
    }
    const opts = obj.options as Record<string, unknown> | undefined;
    if (typeof opts !== 'object' || opts === null) {
      errors.push({ index: i, field: `${p}.options`, message: 'Pilihan A-E wajib berupa objek' });
    } else {
      for (const letter of ['A', 'B', 'C', 'D', 'E']) {
        if (!validateString(opts[letter], LIMITS.option)) {
          errors.push({ index: i, field: `${p}.options.${letter}`, message: `Pilihan ${letter} wajib diisi` });
        }
      }
    }
    const ans = typeof obj.answer === 'string' ? obj.answer.trim().toUpperCase() : '';
    if (!['A', 'B', 'C', 'D', 'E'].includes(ans)) {
      errors.push({ index: i, field: `${p}.answer`, message: 'Jawaban benar harus salah satu dari A-E' });
    }
    const cat = validateString(obj.category, LIMITS.category);
    if (!cat) {
      errors.push({ index: i, field: `${p}.category`, message: 'Kategori wajib diisi' });
    } else if (seen.size < 50) {
      seen.add(cat);
    }
    if (obj.explanation !== undefined && obj.explanation !== null && typeof obj.explanation !== 'string') {
      errors.push({ index: i, field: `${p}.explanation`, message: 'Pembahasan harus berupa teks' });
    }
  });
  return errors;
}

export function importSummary(payload: ImportPayload) {
  const perCategory: Record<string, number> = {};
  for (const q of payload.questions ?? []) {
    const cat = String((q as Record<string, unknown>).category ?? '').trim() || '(tanpa kategori)';
    perCategory[cat] = (perCategory[cat] ?? 0) + 1;
  }
  return {
    title: String(payload.title ?? '').trim(),
    exam_type: String(payload.category ?? 'UPKP').trim() || 'UPKP',
    total: (payload.questions ?? []).length,
    per_category: perCategory,
  };
}

// Normalisasi satu soal menjadi bentuk siap insert.
export function normalizeQuestion(q: Record<string, unknown>): ImportQuestion {
  const opts = (q.options ?? {}) as Record<string, unknown>;
  return {
    question: String(q.question ?? '').trim().slice(0, LIMITS.question),
    options: {
      A: String(opts.A ?? '').trim().slice(0, LIMITS.option),
      B: String(opts.B ?? '').trim().slice(0, LIMITS.option),
      C: String(opts.C ?? '').trim().slice(0, LIMITS.option),
      D: String(opts.D ?? '').trim().slice(0, LIMITS.option),
      E: String(opts.E ?? '').trim().slice(0, LIMITS.option),
    },
    answer: String(q.answer ?? '').trim().toUpperCase(),
    category: String(q.category ?? '').trim().slice(0, LIMITS.category),
    explanation: String(q.explanation ?? '').trim().slice(0, LIMITS.explanation),
  };
}
