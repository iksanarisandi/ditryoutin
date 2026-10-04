import { Hono } from 'hono';
import { ok } from '../utils/response';
import { requireAuth } from '../middleware/auth';
import { getOrCreateReferralCode, REFERRAL_REWARD_DAYS } from '../services/referrals';
import type { AppEnv } from '../types';

// Kartu undangan di dashboard: kode + link + statistik. Kode dibuat malas saat
// panggilan pertama. Link dibangun dari origin permintaan sehingga selalu
// cocok dengan domain yang dipakai user (ditryout.in, atau localhost saat dev).

const referral = new Hono<AppEnv>();
referral.use('*', requireAuth);

referral.get('/', async (c) => {
  const user = c.get('user');
  const code = await getOrCreateReferralCode(c.env.DB, user.id);
  const row = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM referrals WHERE referrer_id=?')
    .bind(user.id)
    .first<{ n: number }>();
  const invited = row?.n ?? 0;
  const origin = new URL(c.req.url).origin;
  return ok(c, {
    code,
    link: `${origin}/register.html?ref=${code}`,
    invited_count: invited,
    days_earned: invited * REFERRAL_REWARD_DAYS,
  });
});

export default referral;
