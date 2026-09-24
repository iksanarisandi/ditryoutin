// Passing grade default per jenis ujian (tingkat 1), dalam poin (5 poin per jawaban benar).
// Dipakai untuk menerapkan aturan otomatis saat import soal / penambahan soal baru;
// admin tetap bisa meng-override nilai per paket lewat menu Passing Grade.
// TKT hanya ada di UPKP; TPU hanya ada di Ujian Dinas (keduanya komponen berbeda).

export const DEFAULT_PASSING_GRADES: Record<string, Record<string, number>> = {
  UPKP: { TWK: 100, TKT: 60, TSI: 30, TKP: 20 },
  'UJIAN DINAS': { TWK: 100, TPU: 75, TSI: 35 },
};

// Normalisasi nama jenis ujian bebas -> kunci default ('UPKP' | 'UJIAN DINAS' | null).
export function defaultRulesKey(examType: string): string | null {
  const t = examType.toUpperCase();
  if (t.includes('UJIAN DINAS') || t.includes('UJIAN_DINAS')) return 'UJIAN DINAS';
  if (t.includes('UPKP')) return 'UPKP';
  return null;
}

// Nilai default (poin) untuk sebuah kategori pada jenis ujian tertentu, atau null.
// Nama kategori berawalan 'TKP' (mis. 'TKP Bahasa Inggris') dianggap varian TKP di UPKP.
export function defaultMinimumScore(examType: string, categoryName: string): number | null {
  const key = defaultRulesKey(examType);
  if (!key) return null;
  const rules = DEFAULT_PASSING_GRADES[key];
  const name = categoryName.trim().toUpperCase();
  if (rules[name] != null) return rules[name];
  if (key === 'UPKP' && name.startsWith('TKP')) return rules.TKP;
  return null;
}
