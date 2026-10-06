// Kirim email lewat REST API Resend (https://resend.com/docs/api-reference)
// — cukup fetch, tanpa SDK tambahan. Domain pengirim harus status "Verified"
// di dashboard Resend; kalau belum, Resend menolak dengan 403 dan pesannya
// terlihat di `wrangler tail` (log error di bawah).
const FROM = 'Tryout UPKP <info@ditryout.in>';
// Balasan email situs diarahkan ke inbox pribadi admin (info@ tidak punya MX —
// domain ini kirim-saja). Balasan broadcast di Resend memakai nilai yang sama.
const REPLY_TO = 'iksan10058@gmail.com';

// Email client tidak memuat CSS eksternal — semua style harus inline.
function resetEmailHtml(resetUrl: string): string {
  return `<!DOCTYPE html>
<html lang="id">
<body style="margin:0;padding:24px;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif;color:#0f172a">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:28px">
    <img src="https://ditryout.in/img/logo-192.png" alt="Tryout UPKP" width="48" height="48" style="display:block;margin-bottom:16px">
    <h2 style="margin:0 0 12px;font-size:20px">Permintaan Reset Password</h2>
    <p style="margin:0 0 20px;line-height:1.6">
      Kami menerima permintaan reset password untuk akun Tryout UPKP milik email ini.
      Klik tombol di bawah untuk mengatur password baru.
    </p>
    <a href="${resetUrl}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;padding:13px 28px;border-radius:8px;font-weight:bold;font-size:15px">Reset Password</a>
    <p style="margin:20px 0 8px;line-height:1.6">Atau salin tautan berikut ke browser Anda:</p>
    <p style="margin:0 0 20px;word-break:break-all"><a href="${resetUrl}" style="color:#2563eb">${resetUrl}</a></p>
    <p style="margin:0 0 8px;line-height:1.6">
      Tautan berlaku <strong>1 jam</strong> dan hanya bisa dipakai <strong>sekali</strong>.
    </p>
    <p style="margin:0;line-height:1.6;color:#64748b">
      Jika Anda tidak meminta reset password, abaikan email ini —
      password Anda tidak akan berubah.
    </p>
  </div>
</body>
</html>`;
}

/**
 * Kirim email reset password. Mengembalikan true/false (bukan throw) agar
 * pemanggil bisa menjaga respons endpoint tetap netral — kegagalan kirim
 * cukup di-log untuk observability, tidak di-bocorkan ke peminta.
 */
export async function sendPasswordResetEmail(
  apiKey: string,
  to: string,
  resetUrl: string,
): Promise<boolean> {
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: FROM,
        reply_to: REPLY_TO,
        to: [to],
        subject: 'Reset password akun Tryout UPKP',
        html: resetEmailHtml(resetUrl),
      }),
    });
    if (!res.ok) {
      // Body berisi alasan Resend (domain belum verified, key salah, dsb.)
      console.error('[resend] gagal kirim ke', to, res.status, await res.text());
      return false;
    }
    return true;
  } catch (e) {
    console.error('[resend] error jaringan', e);
    return false;
  }
}

/**
 * Tambah pendaftar baru ke daftar kontak Resend (bahan Broadcast info/promo).
 * Fire-and-forget: pemanggil memakai waitUntil — gagal/timeout tidak boleh
 * mengganggu pendaftaran. Kontak sudah ada (mis. hasil impor CSV) bukan error
 * fatal; cukup ter-log untuk observability.
 */
export async function addResendContact(
  apiKey: string,
  email: string,
  name: string,
): Promise<boolean> {
  try {
    // Nama dipecah agar broadcast bisa personalisasi "Halo {{first_name}}".
    const parts = name.trim().split(/\s+/);
    const res = await fetch('https://api.resend.com/contacts', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email,
        first_name: parts[0] ?? '',
        last_name: parts.slice(1).join(' '),
      }),
    });
    if (!res.ok) {
      console.error('[resend] tambah kontak gagal', email, res.status, await res.text());
      return false;
    }
    return true;
  } catch (e) {
    console.error('[resend] error jaringan kontak', e);
    return false;
  }
}
