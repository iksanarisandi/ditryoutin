import { Hono } from 'hono';
import { ok } from '../utils/response';
import { requireAuth } from '../middleware/auth';
import {
  getOrCreateReferralCode,
  inviteeDiscountEligible,
  REFERRAL_INVITEE_DISCOUNT,
  REFERRAL_REFERRER_REWARD_DAYS,
} from '../services/referrals';
import type { AppEnv } from '../types';

// Kartu undangan di dashboard + info diskon untuk halaman pembayaran. Kode
// dibuat malas saat panggilan pertama. Link dibangun dari origin permintaan
// sehingga selalu cocok dengan domain yang dipakai user (ditryout.in, atau
// localhost saat dev).

const referral = new Hono<AppEnv>();
referral.use('*', requireAuth);

referral.get('/', async (c) => {
  const user = c.get('user');
  const code = await getOrCreateReferralCode(c.env.DB, user.id);
  const row = await c.env.DB.prepare(
    `SELECT COUNT(*) AS invited,
            SUM(CASE WHEN rewarded_at IS NOT NULL THEN 1 ELSE 0 END) AS bought
     FROM referrals WHERE referrer_id=?`,
  )
    .bind(user.id)
    .first<{ invited: number; bought: number | null }>();
  const invited = row?.invited ?? 0;
  const bought = row?.bought ?? 0;
  const origin = new URL(c.req.url).origin;
  return ok(c, {
    code,
    link: `${origin}/register.html?ref=${code}`,
    invited_count: invited,
    bought_count: bought,
    days_earned: bought * REFERRAL_REFERRER_REWARD_DAYS,
    // Diskon pembelian pertama milik user INI (sebagai invitee) — dipakai
    // halaman pembayaran untuk menampilkan harga terpotong.
    invitee_discount: {
      eligible: await inviteeDiscountEligible(c.env.DB, user.id),
      percent: Math.round(REFERRAL_INVITEE_DISCOUNT * 100),
    },
  });
});

export default referral;
