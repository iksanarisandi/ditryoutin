// Program referral: kode undangan per user + hadiah akses untuk pengundang dan
// yang diundang. Dipakai rute register (klaim saat invitee mendaftar) dan rute
// /api/referral (kartu undangan di dashboard).

import { extendUserAccess } from './payments';

// Hadiah referal: +1 hari akses untuk KEDUA pihak (pengundang & yang diundang).
export const REFERRAL_REWARD_DAYS = 1;

// Alfabet tanpa karakter ambigu (tanpa I, O, 0, 1) agar kode aman dibaca
// dan diketik manual — sama prinsip dengan TEMP_CHARS di admin/users.ts.
const REFERRAL_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const REFERRAL_LEN = 8; // 32^8 ≈ 1,1 triliun kombinasi

function genReferralCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(REFERRAL_LEN));
  return [...bytes].map((b) => REFERRAL_CHARS[b % REFERRAL_CHARS.length]).join('');
}

// Normalisasi input kode: buang spasi/tanda baca, paksa uppercase, maks 16 char.
// Input case berbeda tetap cocok karena kode disimpan selalu uppercase.
export function normalizeRefCode(v: unknown): string {
  if (typeof v !== 'string') return '';
  return v.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16);
}

// Kode undangan user — dibuat malas: user lama tetap NULL sampai pertama kali
// memintanya. WHERE referral_code IS NULL menjaga race dua permintaan paralel:
// pihak yang kalah (changes=0) cukup membaca ulang; kolisi kode dengan user
// lain (UNIQUE) ditangani dengan regenerasi.
export async function getOrCreateReferralCode(db: D1Database, userId: number): Promise<string> {
  const existing = await db
    .prepare('SELECT referral_code FROM users WHERE id=?')
    .bind(userId)
    .first<{ referral_code: string | null }>();
  if (existing?.referral_code) return existing.referral_code;

  for (let i = 0; i < 5; i++) {
    const code = genReferralCode();
    try {
      const res = await db
        .prepare(
          'UPDATE users SET referral_code=?, updated_at=? WHERE id=? AND referral_code IS NULL',
        )
        .bind(code, new Date().toISOString(), userId)
        .run();
      if (res.meta.changes === 1) return code;
      const reread = await db
        .prepare('SELECT referral_code FROM users WHERE id=?')
        .bind(userId)
        .first<{ referral_code: string | null }>();
      if (reread?.referral_code) return reread.referral_code;
    } catch (e) {
      if (String(e).includes('UNIQUE')) continue; // tabrakan dengan kode user lain
      throw e;
    }
  }
  throw new Error('Gagal membuat kode undangan setelah 5 percobaan');
}

// Klaim referal untuk user yang BARU saja dibuat. Return true bila hadiah
// diberikan. Caller (register) membungkus try/catch — kegagalan referal tidak
// boleh membatalkan pendaftaran.
// Urutan klaim-dulu-grant-belakangan: INSERT ke referrals adalah kunci
// idempotensi; kegagalan setelah klaim bisa kehilangan 1 hari (di-log caller),
// tapi tidak pernah dobel-grant.
export async function applyReferral(
  db: D1Database,
  rawCode: unknown,
  newUserId: number,
): Promise<boolean> {
  const code = normalizeRefCode(rawCode);
  if (!code) return false;

  const referrer = await db
    .prepare('SELECT id FROM users WHERE referral_code=?')
    .bind(code)
    .first<{ id: number }>();
  if (!referrer || referrer.id === newUserId) return false;

  // Referrer boleh admin — perpanjangan expiry pada admin bersifat inert
  // (admin bypass requireActiveAccess), jadi tidak perlu dikhususkan.
  try {
    await db
      .prepare('INSERT INTO referrals (referrer_id, invitee_id) VALUES (?, ?)')
      .bind(referrer.id, newUserId)
      .run();
  } catch (e) {
    if (String(e).includes('UNIQUE')) return false; // invitee sudah pernah diklaim
    throw e;
  }

  // extendUserAccess atomik & menumpuk dari MAX(expiry, now) — jalur yang sama
  // dengan settlePayment dan perpanjangan manual admin.
  await extendUserAccess(db, referrer.id, REFERRAL_REWARD_DAYS);
  await extendUserAccess(db, newUserId, REFERRAL_REWARD_DAYS);
  return true;
}
