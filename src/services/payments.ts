// Settlement pembayaran + perpanjangan masa akses (idempotent).

import { getTransactionStatus } from './pakasir';

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
  const user = await db
    .prepare('SELECT access_expires_at, access_started_at FROM users WHERE id=?')
    .bind(payment.user_id)
    .first<{ access_expires_at: string | null; access_started_at: string | null }>();
  if (!product || !user) return { alreadyPaid: false };

  // Masih aktif -> expired_lama + durasi. Sudah habis -> mulai dari sekarang.
  const now = Date.now();
  const current = user.access_expires_at ? Date.parse(user.access_expires_at) : null;
  const base = current && current > now ? current : now;
  const newExpiry = new Date(base + product.duration_days * 86400000).toISOString();
  const newStart =
    current && current > now ? (user.access_started_at ?? nowIso) : new Date(now).toISOString();

  await db
    .prepare('UPDATE users SET access_expires_at=?, access_started_at=?, updated_at=? WHERE id=?')
    .bind(newExpiry, newStart, nowIso, payment.user_id)
    .run();
  return { alreadyPaid: false };
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

// Fallback tanpa webhook: cek payment pending milik user ke API status Pakasir.
// Dipanggil saat login//me sehingga user yang menutup halaman pembayaran sebelum selesai
// tetap mendapat perpanjangan akses begitu membuka aplikasi lagi. Pakai rate limit
// shouldCheckStatus yang sama dengan polling halaman pembayaran.
export async function reconcilePendingPayments(env: { DB: D1Database } & {
  PAKASIR_API_KEY?: string;
  PAKASIR_PROJECT?: string;
}, userId: number): Promise<void> {
  if (!env.PAKASIR_API_KEY || !env.PAKASIR_PROJECT) return;
  const pendings = await env.DB.prepare(
    `SELECT id, user_id, product_id, reference, txn_id, amount, method, status, paid_at, created_at
     FROM payments WHERE user_id=? AND status='pending' AND txn_id IS NOT NULL`,
  )
    .bind(userId)
    .all<PaymentRow>();
  for (const p of pendings.results ?? []) {
    if (!shouldCheckStatus(p.id)) continue;
    try {
      const txn = await getTransactionStatus(env as Parameters<typeof getTransactionStatus>[0], p.txn_id as string);
      if (txn.status === 'completed') {
        await settlePayment(env.DB, p, txn.completed_at);
      } else if (txn.status === 'canceled' && Date.parse(p.created_at) < Date.now() - PAKASIR_TTL_MS) {
        await env.DB.prepare(`UPDATE payments SET status='expired', updated_at=? WHERE id=? AND status='pending'`)
          .bind(new Date().toISOString(), p.id)
          .run();
      }
    } catch {
      // rate-limit / jaringan: dicoba lagi pada kunjungan berikutnya
    }
  }
}

// Umur maksimal transaksi Pakasir (auto-cancel setelah 1x24 jam).
export const PAKASIR_TTL_MS = 24 * 3600 * 1000;
