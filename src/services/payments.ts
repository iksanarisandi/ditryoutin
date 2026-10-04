// Settlement pembayaran + perpanjangan masa akses (idempotent).

import { getTransactionStatus, PakasirError } from './pakasir';
import { claimReferralReward, REFERRAL_REFERRER_REWARD_DAYS } from './referrals';
import type { Env } from '../types';

export type PaymentRow = {
  id: number;
  user_id: number;
  product_id: number;
  reference: string;
  txn_id: string | null;
  amount: number;
  method: string;
  status: 'pending' | 'paid' | 'failed' | 'expired';
  paid_at: string | null;
  created_at: string;
};

// Tandai payment berbayas + perpanjang akses user.
// Aman dipanggil berkali-kali: UPDATE bersyarat status!='paid' mencegah duplikasi perpanjangan.
export async function settlePayment(
  db: D1Database,
  payment: PaymentRow,
  completedAt?: string,
): Promise<{ alreadyPaid: boolean }> {
  const nowIso = new Date().toISOString();
  const res = await db
    .prepare(
      `UPDATE payments SET status='paid', paid_at=COALESCE(paid_at, ?), updated_at=? WHERE id=? AND status!='paid'`,
    )
    .bind(completedAt ?? nowIso, nowIso, payment.id)
    .run();
  if (!res.meta.changes) return { alreadyPaid: true };

  const product = await db
    .prepare('SELECT duration_days FROM products WHERE id=?')
    .bind(payment.product_id)
    .first<{ duration_days: number }>();
  if (!product) return { alreadyPaid: false };

  await extendUserAccess(db, payment.user_id, product.duration_days, nowIso);

  // Bonus referal: transaksi PERTAMA seorang invitee yang lunas memberi
  // pengundangnya +N hari. Semua jalur settlement (webhook, polling, cron,
  // admin) bermuara di sini; klaim UPDATE bersyarat menjaga idempotensi.
  // Kegagalan bonus TIDAK boleh menggagalkan settlement — uang sudah masuk.
  try {
    const referrerId = await claimReferralReward(db, payment.user_id, nowIso);
    if (referrerId) {
      await extendUserAccess(db, referrerId, REFERRAL_REFERRER_REWARD_DAYS, nowIso);
    }
  } catch (e) {
    console.error('[settle:referral]', payment.reference, e);
  }
  return { alreadyPaid: false };
}

// Perpanjang masa akses: base = MAX(expiry saat ini, sekarang), lalu + durasi.
// Dikerjakan dalam SATU statement atomik — baca-ubah-tulis terpisah bisa saling
// menimpa bila dua payment user yang sama settle hampir bersamaan (webhook +
// polling/cron/admin), sehingga durasi salah satu hilang. Semua timestamp DB
// berformat ISO-8601 UTC (toISOString, lebar tetap) sehingga perbandingan string
// = perbandingan waktu, dan strftime '%f' mengembalikan format yang identik.
// Return expiry baru (RETURNING), atau null bila user tidak ditemukan.
export async function extendUserAccess(
  db: D1Database,
  userId: number,
  days: number,
  nowIso?: string,
): Promise<string | null> {
  const now = nowIso ?? new Date().toISOString();
  const row = await db
    .prepare(
      `UPDATE users SET
         access_expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', julianday(MAX(COALESCE(access_expires_at, ?1), ?1)) + ?2),
         access_started_at = CASE WHEN COALESCE(access_expires_at, ?1) > ?1 THEN COALESCE(access_started_at, ?1) ELSE ?1 END,
         updated_at = ?1
       WHERE id = ?3
       RETURNING access_expires_at`,
    )
    .bind(now, days, userId)
    .first<{ access_expires_at: string }>();
  return row?.access_expires_at ?? null;
}

export function remainingSeconds(expiresAt: string): number {
  return Math.max(0, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000));
}

// Rate limit polling ke API status Pakasir (maks 1x/4 detik per payment, per isolate).
const lastStatusCheck = new Map<number, number>();
export function shouldCheckStatus(paymentId: number): boolean {
  const now = Date.now();
  const last = lastStatusCheck.get(paymentId) ?? 0;
  if (now - last < 4500) return false;
  lastStatusCheck.set(paymentId, now);
  return true;
}

export function genReference(): string {
  const rand = crypto.getRandomValues(new Uint8Array(4));
  const suffix = [...rand].map((b) => b.toString(36).padStart(2, '0')).join('').slice(0, 6).toUpperCase();
  return `TO-${Date.now().toString(36).toUpperCase()}-${suffix}`;
}

// Cek satu payment pending ke API status Pakasir: settle bila completed,
// expire bila umur transaksi sudah lewat batas bayar dan gateway TIDAK
// melaporkan completed. Aman dipanggil berkali-kali — settlePayment idempoten.
async function expirePending(db: D1Database, id: number): Promise<void> {
  await db
    .prepare(`UPDATE payments SET status='expired', updated_at=? WHERE id=? AND status='pending'`)
    .bind(new Date().toISOString(), id)
    .run();
}

async function reconcilePayment(
  env: { DB: D1Database } & {
    PAKASIR_API_KEY?: string;
    PAKASIR_PROJECT?: string;
  },
  p: PaymentRow,
): Promise<void> {
  if (!env.PAKASIR_API_KEY || !env.PAKASIR_PROJECT || !p.txn_id) return;
  const pastTtl = Date.parse(p.created_at) < Date.now() - PAKASIR_TTL_MS;
  try {
    const txn = await getTransactionStatus(env as Parameters<typeof getTransactionStatus>[0], p.txn_id);
    if (txn.status === 'completed') {
      await settlePayment(env.DB, p, txn.completed_at);
    } else if (pastTtl) {
      // Lewat batas bayar 24 jam dan gateway tidak melaporkan completed:
      // apa pun statusnya sekarang (canceled/expired/bahkan masih pending di
      // gateway), transaksi tidak bisa menghasilkan pembayaran yang sah lagi
      // menurut batas aplikasi — identik dengan expiry di GET /api/payments/:id.
      // Webhook tetap bisa men-settle belakangan bila completed datang terlambat.
      await expirePending(env.DB, p.id);
    }
  } catch (e) {
    // Transaksi tidak lagi dikenal gateway (404) + lewat TTL: mustahil lunas.
    // Error lain (jaringan/rate limit gateway): coba lagi pada kesempatan berikutnya.
    if (pastTtl && e instanceof PakasirError && e.status === 404) {
      await expirePending(env.DB, p.id);
    }
  }
}

// Fallback tanpa webhook: cek payment pending milik user ke API status Pakasir.
// Dipanggil saat login//me sehingga user yang menutup halaman pembayaran sebelum selesai
// tetap mendapat perpanjangan akses begitu membuka aplikasi lagi. Pakai rate limit
// shouldCheckStatus yang sama dengan polling halaman pembayaran.
export async function reconcilePendingPayments(
  env: { DB: D1Database } & {
    PAKASIR_API_KEY?: string;
    PAKASIR_PROJECT?: string;
  },
  userId: number,
): Promise<void> {
  if (!env.PAKASIR_API_KEY || !env.PAKASIR_PROJECT) return;
  const pendings = await env.DB.prepare(
    `SELECT id, user_id, product_id, reference, txn_id, amount, method, status, paid_at, created_at
     FROM payments WHERE user_id=? AND status='pending' AND txn_id IS NOT NULL`,
  )
    .bind(userId)
    .all<PaymentRow>();
  for (const p of pendings.results ?? []) {
    if (!shouldCheckStatus(p.id)) continue;
    await reconcilePayment(env, p);
  }
}

// Jaring pengaman bila webhook gagal (salah konfigurasi, gateway down): user yang
// sudah membayar lalu menutup aplikasi dan tidak kembali-kembali tetap mendapat
// aksesnya — cron harian memeriksa pending payment ber-transaksi ke API Pakasir.
// Dibatasi 50 tertua per run agar tidak menghantam rate limit 1x/4 detik Pakasir.
export async function reconcileStalePayments(env: Env, limit: number = 50): Promise<void> {
  if (!env.PAKASIR_API_KEY || !env.PAKASIR_PROJECT) return;
  const rows = await env.DB.prepare(
    `SELECT id, user_id, product_id, reference, txn_id, amount, method, status, paid_at, created_at
     FROM payments WHERE status='pending' AND txn_id IS NOT NULL AND created_at < ?
     ORDER BY id LIMIT ?`,
  )
    .bind(new Date(Date.now() - 10 * 60 * 1000).toISOString(), limit)
    .all<PaymentRow>();
  for (const p of rows.results ?? []) {
    await reconcilePayment(env, p);
  }
}

// Umur maksimal transaksi Pakasir (auto-cancel setelah 1x24 jam).
export const PAKASIR_TTL_MS = 24 * 3600 * 1000;

// Batas bayar efektif sebuah transaksi: lebih awal antara expiry gateway
// (bila dikirim) dan umur maksimal aplikasi (dibuat + 24 jam). Gateway tidak
// selalu menyertakan expired_at, jadi 24 jam adalah batas yang dijamin.
export function effectiveExpiryIso(
  gatewayExpiry: string | null | undefined,
  createdAt: string,
): string {
  const appMs = Date.parse(createdAt) + PAKASIR_TTL_MS;
  const gatewayMs = gatewayExpiry ? Date.parse(gatewayExpiry) : Infinity;
  return new Date(Math.min(appMs, gatewayMs)).toISOString();
}
