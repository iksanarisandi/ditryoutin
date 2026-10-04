// Program referral: kode undangan per user + diskon pembelian pertama untuk
// yang diundang + bonus hari akses untuk pengundang saat transaksi pertama
// invitee LUNAS (bukan saat daftar — setiap hadiah selalu didahului uang
// masuk, sehingga akun palsu tidak menghasilkan apa pun).

// Diskon pembelian pertama untuk invitee (10% dari harga produk).
export const REFERRAL_INVITEE_DISCOUNT = 0.1;
// Bonus untuk pengundang setiap kali transaksi pertama seorang invitee lunas.
export const REFERRAL_REFERRER_REWARD_DAYS = 3;

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

// Catat relasi undangan untuk user yang BARU saja dibuat — TANPA hadiah apa
// pun (diskon & bonus keluar di jalur pembayaran). Return true bila tercatat.
// Caller (register) membungkus try/catch — kegagalan referal tidak boleh
// membatalkan pendaftaran.
export async function recordReferral(
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

  // Referrer boleh admin — bonus hari pada admin bersifat inert (admin bypass
  // requireActiveAccess), jadi tidak perlu dikhususkan.
  try {
    await db
      .prepare('INSERT INTO referrals (referrer_id, invitee_id) VALUES (?, ?)')
      .bind(referrer.id, newUserId)
      .run();
  } catch (e) {
    if (String(e).includes('UNIQUE')) return false; // invitee sudah pernah dicatat
    throw e;
  }
  return true;
}

// Apakah user berhak diskon undangan pada pembelian berikutnya: tercatat sebagai
// invitee DAN belum punya transaksi berstatus paid (diskon melekat pada
// transaksi pertama yang LUNAS — pending yang ditinggal tidak menghabiskannya).
export async function inviteeDiscountEligible(db: D1Database, userId: number): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT EXISTS(SELECT 1 FROM referrals WHERE invitee_id=?1) AS referred,
              EXISTS(SELECT 1 FROM payments WHERE user_id=?1 AND status='paid') AS paid_before`,
    )
    .bind(userId)
    .first<{ referred: number; paid_before: number }>();
  return !!row && row.referred === 1 && row.paid_before === 0;
}

// Klaim bonus pengundang untuk invitee yang transaksi pertamanya baru saja
// LUNAS. UPDATE bersyarat rewarded_at IS NULL = kunci idempotensi atomik:
// hanya satu jalur settlement (webhook/polling/cron/admin) yang menang,
// transaksi kedua invitee tidak memberi bonus lagi. Return id pengundang
// yang berhak (null bila tidak ada / sudah diklaim) — pemberian harinya
// tetap di payments.ts lewat extendUserAccess agar tidak ada import melingkar.
export async function claimReferralReward(
  db: D1Database,
  inviteeId: number,
  nowIso?: string,
): Promise<number | null> {
  const row = await db
    .prepare(
      `UPDATE referrals SET rewarded_at=? WHERE invitee_id=? AND rewarded_at IS NULL RETURNING referrer_id`,
    )
    .bind(nowIso ?? new Date().toISOString(), inviteeId)
    .first<{ referrer_id: number }>();
  return row?.referrer_id ?? null;
}
