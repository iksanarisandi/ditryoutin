// Email notifikasi user (sambutan, bukti bayar, pengingat belum bayar).
// Semua fungsi di sini tidak pernah throw: email = efek samping, gagal kirim
// cukup ter-log dan tidak boleh mengganggu pendaftaran / settlement.
import type { Env } from '../types';
import { inviteeDiscountEligible, REFERRAL_INVITEE_DISCOUNT } from './referrals';
import {
  SITE_URL,
  receiptEmailHtml,
  reminderEmailHtml,
  sendEmail,
  welcomeEmailHtml,
  type WelcomeProduct,
} from './resend';

export async function sendWelcomeEmail(
  env: Env,
  userId: number,
  email: string,
  name: string,
): Promise<void> {
  try {
    const [products, discount] = await Promise.all([
      env.DB.prepare(
        'SELECT id, name, price, duration_days FROM products WHERE active=1 ORDER BY price',
      ).all<WelcomeProduct>(),
      inviteeDiscountEligible(env.DB, userId),
    ]);
    await sendEmail(env, {
      kind: 'welcome',
      to: email,
      userId,
      subject: 'Selamat datang di Tryout UPKP, akunmu sudah aktif',
      html: welcomeEmailHtml({
        name,
        products: products.results ?? [],
        discountPct: discount ? Math.round(REFERRAL_INVITEE_DISCOUNT * 100) : 0,
      }),
    });
  } catch (e) {
    console.error('[email:welcome]', userId, e);
  }
}

// Dipanggil settlePayment tepat sekali per transaksi (hanya pemenang UPDATE
// status!='paid'); unique (kind, payment_id) di email_log jadi lapis kedua.
export async function sendPaymentReceipt(env: Env, paymentId: number): Promise<void> {
  try {
    const row = await env.DB.prepare(
      `SELECT pm.id, pm.user_id, pm.reference, pm.amount, pm.total_payment, pm.paid_at,
              u.email, u.name, u.access_expires_at, pr.name AS product_name
       FROM payments pm
       JOIN users u ON u.id = pm.user_id
       LEFT JOIN products pr ON pr.id = pm.product_id
       WHERE pm.id = ?`,
    )
      .bind(paymentId)
      .first<{
        id: number;
        user_id: number;
        reference: string;
        amount: number;
        total_payment: number | null;
        paid_at: string | null;
        email: string;
        name: string;
        access_expires_at: string | null;
        product_name: string | null;
      }>();
    if (!row) return;
    await sendEmail(env, {
      kind: 'receipt',
      to: row.email,
      userId: row.user_id,
      paymentId: row.id,
      subject: 'Pembayaran berhasil, akses Tryout UPKP sudah aktif',
      html: receiptEmailHtml({
        name: row.name,
        productName: row.product_name ?? 'Akses Tryout UPKP',
        reference: row.reference,
        // Yang DIBAYAR pembeli (termasuk fee pass-through), bukan harga dasar.
        paid: row.total_payment ?? row.amount,
        paidAt: row.paid_at,
        accessUntil: row.access_expires_at,
      }),
    });
  } catch (e) {
    console.error('[email:receipt]', paymentId, e);
  }
}

export type ReminderTarget = {
  id: number;
  user_id: number;
  product_id: number;
  status: string;
  amount: number;
  total_payment: number | null;
  expires_at: string | null;
  created_at: string;
  email: string;
  name: string;
  product_name: string | null;
  duration_days: number | null;
};

export async function sendPaymentReminder(
  env: Env,
  t: ReminderTarget,
  payUntil: string | null,
): Promise<boolean> {
  try {
    return await sendEmail(env, {
      kind: 'reminder',
      to: t.email,
      userId: t.user_id,
      paymentId: t.id,
      subject: `Pembayaran ${t.product_name ?? 'akses Tryout UPKP'} kamu belum selesai`,
      html: reminderEmailHtml({
        name: t.name,
        productName: t.product_name ?? 'Akses Tryout UPKP',
        durationDays: t.duration_days,
        payUntil,
        amountDue: t.total_payment ?? t.amount,
        payUrl: payUntil
          ? `${SITE_URL}/payment.html?payment=${t.id}`
          : `${SITE_URL}/payment.html?product=${t.product_id}`,
        supportWa: env.MANUAL_WA || '',
      }),
    });
  } catch (e) {
    console.error('[email:reminder]', t.id, e);
    return false;
  }
}
