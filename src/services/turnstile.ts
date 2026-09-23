// Verifikasi token Cloudflare Turnstile (https://developers.cloudflare.com/turnstile/).
// Aktif hanya jika TURNSTILE_SITE_KEY + TURNSTILE_SECRET_KEY keduanya di-set.

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/**
 * Verifikasi token ke siteverify.
 * Fail-open HANYA saat siteverify tidak bisa dihubungi (gangguan jaringan) —
 * respons non-200 atau success=false selalu dianggap gagal.
 */
export async function verifyTurnstile(
  secret: string,
  token: string,
  ip: string | null,
): Promise<boolean> {
  const form = new URLSearchParams({ secret, response: token });
  if (ip) form.set('remoteip', ip);
  try {
    const res = await fetch(SITEVERIFY_URL, { method: 'POST', body: form });
    if (!res.ok) return false;
    const data = (await res.json()) as { success?: boolean };
    return data.success === true;
  } catch (e) {
    // Jangan matikan login/register saat siteverify down — catat & izinkan.
    console.error('[turnstile] siteverify unreachable', e);
    return true;
  }
}
