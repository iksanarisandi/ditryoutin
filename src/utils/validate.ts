const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const ANSWER_LETTERS = ['A', 'B', 'C', 'D', 'E'] as const;
export type AnswerLetter = (typeof ANSWER_LETTERS)[number];

export function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export function trimStr(v: unknown, maxLen = 1000): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s) return null;
  return s.slice(0, maxLen);
}

export function normalizeEmail(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  return EMAIL_RE.test(s) && s.length <= 254 ? s : null;
}

export function validPassword(v: unknown): v is string {
  return typeof v === 'string' && v.length >= 8 && v.length <= 100;
}

export function validAnswer(v: unknown): v is AnswerLetter | null {
  if (v === null) return true;
  return typeof v === 'string' && (ANSWER_LETTERS as readonly string[]).includes(v.trim().toUpperCase());
}

export function normalizeAnswer(v: unknown): AnswerLetter | null {
  if (v === null || v === undefined || v === '') return null;
  return (String(v).trim().toUpperCase() as AnswerLetter);
}

export function toInt(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10);
  return Number.isInteger(n) ? n : fallback;
}

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}
