// Settlement pembayaran + perpanjangan masa akses (idempotent).

import { getTransactionStatus, PakasirError } from './pakasir';
import { getTransactionStatus as getDuitkuTransactionStatus, DuitkuError, isDuitkuConfigured } from './duitku';
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
  gateway: string | null;
  payment_url: string | null;
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

// Rate limit polling ke API status gateway. Pakasir: maks 1x/4,5 detik per
// payment (limit gateway 1x/4 detik). Duitku: maks 1x/15 detik — polling
// terlalu rapat memicu blokir ~1 jam dari sisi Duitku.
const lastStatusCheck = new Map<number, number>();
export function shouldCheckStatus(paymentId: number, minIntervalMs: number = 4500): boolean {
  const now = Date.now();
  const last = lastStatusCheck.get(paymentId) ?? 0;
  if (now - last < minIntervalMs) return false;
  lastStatusCheck.set(paymentId, now);
  return true;
}

export function genReference(): string {
  const rand = crypto.getRandomValues(new Uint8Array(4));
  const suffix = [...rand].map((b) => b.toString(36).padStart(2, '0')).join('').slice(0, 6).toUpperCase();
  return `TO-${Date.now().toString(36).toUpperCase()}-${suffix}`;
}

// Tandai payment pending sebagai expired.
async function expirePending(db: D1Database, id: number): Promise<void> {
  await db
    .prepare(`UPDATE payments SET status='expired', updated_at=? WHERE id=? AND status='pending'`)
    .bind(new Date().toISOString(), id)
    .run();
}

// Cek satu payment pending ke API status gateway yang menanganinya:
// settle bila completed, expire bila kedaluwarsa (gateway melapor, atau umur
// transaksi lewat batas aplikasi). Aman dipanggil berkali-kali — settlePayment idempoten.
async function reconcilePayment(env: Env, p: PaymentRow): Promise<void> {
  if (!p.txn_id) return;
  const pastTtl = Date.parse(p.created_at) < Date.now() - PAYMENT_TTL_MS;

  try {
    if (p.gateway === 'duitku') {
      const st = await getDuitkuTransactionStatus(env, p.reference);
      if (st.state === 'completed') {
        await settlePayment(env.DB, p);
      } else if (st.state === 'expired') {
        await expirePending(env.DB, p.id);
      } else if (pastTtl) {
        await expirePending(env.DB, p.id);
      }
      return;
    }

    const txn = await getTransactionStatus(env, p.txn_id);
    if (txn.status === 'completed') {
      await settlePayment(env.DB, p, txn.completed_at);
    } else if (pastTtl) {
      // Lewat batas bayar 24 jam dan gateway tidak melapor completed:
      // apa pun statusnya sekarang (canceled/expired/bahkan masih pending di
      // gateway), transaksi tidak bisa menghasilkan pembayaran yang sah lagi
      // menurut batas aplikasi — identik dengan expiry di GET /api/payments/:id.
      // Webhook tetap bisa men-settle belakangan bila completed datang terlambat.
      await expirePending(env.DB, p.id);
    }
  } catch (e) {
    // Transaksi tidak lagi dikenal gateway (404) + lewat TTL: mustahil lunas.
    // Error lain (jaringan/rate limit gateway): coba lagi pada kesempatan berikutnya.
    if (
      pastTtl &&
      ((p.gateway === 'duitku' && e instanceof DuitkuError && e.status === 404) ||
        (p.gateway !== 'duitku' && e instanceof PakasirError && e.status === 404))
    ) {
      await expirePending(env.DB, p.id);
    }
  }
}

// Adakah gateway yang aktif terkonfigurasi? Rekonsiliasi hanya relevan bila ya.
function anyGatewayConfigured(env: Env): boolean {
  return !!(env.PAKASIR_API_KEY && env.PAKASIR_PROJECT) || isDuitkuConfigured(env);
}

// Fallback tanpa callback: cek payment pending milik user ke API status gateway.
// Dipanggil saat login//me sehingga user yang menutup halaman pembayaran sebelum selesai
// tetap mendapat perpanjangan akses begitu membuka aplikasi lagi. Pakai rate limit
// shouldCheckStatus yang sama dengan polling halaman pembayaran.
export async function reconcilePendingPayments(env: Env, userId: number): Promise<void> {
  if (!anyGatewayConfigured(env)) return;
  const pendings = await env.DB.prepare(
    `SELECT id, user_id, product_id, reference, txn_id, amount, method, gateway, status, paid_at, created_at
     FROM payments WHERE user_id=? AND status='pending' AND txn_id IS NOT NULL`,
  )
    .bind(userId)
    .all<PaymentRow>();
  for (const p of pendings.results ?? []) {
    if (!shouldCheckStatus(p.id, p.gateway === 'duitku' ? 15_000 : 4500)) continue;
    await reconcilePayment(env, p);
  }
}

// Jaring pengaman bila callback gagal (salah konfigurasi, gateway down): user yang
// sudah membayar lalu menutup aplikasi dan tidak kembali-kembali tetap mendapat
// aksesnya — cron harian memeriksa pending payment ber-transaksi ke API gateway.
// Dipecah per gateway dengan kuota terpisah (Pakasir 50, Duitku 25) agar tidak
// menghantam rate limit masing-masing (blokir Duitku berlaku ~1 jam).
export async function reconcileStalePayments(env: Env): Promise<void> {
  if (!anyGatewayConfigured(env)) return;
  const olderThan = new Date(Date.now() - 10 * 60 * 1000).toISOString();

  const pakasirRows = await env.DB.prepare(
    `SELECT id, user_id, product_id, reference, txn_id, amount, method, gateway, status, paid_at, created_at
     FROM payments WHERE status='pending' AND txn_id IS NOT NULL AND (gateway IS NULL OR gateway='pakasir')
       AND created_at < ? ORDER BY id LIMIT 50`,
  )
    .bind(olderThan)
    .all<PaymentRow>();
  for (const p of pakasirRows.results ?? []) {
    await reconcilePayment(env, p);
  }

  if (!isDuitkuConfigured(env)) return;
  const duitkuRows = await env.DB.prepare(
    `SELECT id, user_id, product_id, reference, txn_id, amount, method, gateway, status, paid_at, created_at
     FROM payments WHERE status='pending' AND txn_id IS NOT NULL AND gateway='duitku'
       AND created_at < ? ORDER BY id LIMIT 25`,
  )
    .bind(olderThan)
    .all<PaymentRow>();
  for (const p of duitkuRows.results ?? []) {
    await reconcilePayment(env, p);
  }
}

// Umur maksimal transaksi gateway (Pakasir: auto-cancel 1x24 jam; Duitku kita
// set 30 menit via expiryPeriod — batas 24 jam di sini hanya jaring pengaman
// umum untuk transaksi yang tidak kunjung berstatus final).
export const PAYMENT_TTL_MS = 24 * 3600 * 1000;

// Alias lama — modul lain masih memakai nama ini (semantik sama persis).
export const PAKASIR_TTL_MS = PAYMENT_TTL_MS;

// Batas bayar efektif sebuah transaksi: lebih awal antara expiry gateway
// (bila ada) dan umur maksimal aplikasi (dibuat + 24 jam). Pakasir tidak
// menyertakan expired_at; Duitku menyertakan expires_at buatan kita (+30 menit).
export function effectiveExpiryIso(
  gatewayExpiry: string | null | undefined,
  createdAt: string,
): string {
  const appMs = Date.parse(createdAt) + PAYMENT_TTL_MS;
  const gatewayMs = gatewayExpiry ? Date.parse(gatewayExpiry) : Infinity;
  return new Date(Math.min(appMs, gatewayMs)).toISOString();
}
