import { addResendContact } from './resend';
import { sendWelcomeEmail } from './notifications';
import { recordReferral } from './referrals';
import type { Env } from '../types';

/**
 * Efek samping setelah akun baru dibuat (register email maupun Login Google).
 * Tidak ada yang boleh membatalkan pendaftaran yang sudah jadi:
 * - Referal dicatat TANPA hadiah di muka (diskon & bonus keluar di jalur
 *   pembayaran). Kode salah diabaikan diam-diam — mencegah oracle enumerasi kode.
 * - Kontak Resend (bahan broadcast) + email sambutan via waitUntil — tidak
 *   menahan respons. Sambutan dijadwalkan SETELAH referal tercatat agar diskon
 *   undangan ikut tampil di email.
 */
export async function afterSignup(
  env: Env,
  ctx: { waitUntil(promise: Promise<unknown>): void },
  user: { id: number; email: string; name: string },
  ref: unknown,
  logTag: string,
): Promise<void> {
  if (ref) {
    try {
      await recordReferral(env.DB, ref, user.id);
    } catch (e) {
      console.error(`[${logTag}:referral]`, user.email, e);
    }
  }
  if (env.RESEND_API_KEY) {
    ctx.waitUntil(addResendContact(env.RESEND_API_KEY, user.email, user.name));
    ctx.waitUntil(sendWelcomeEmail(env, user.id, user.email, user.name));
  } else {
    console.error(`[${logTag}] RESEND_API_KEY belum diset — kontak Resend tidak tersinkron`);
  }
}
