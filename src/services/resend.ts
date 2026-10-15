// Kirim email lewat REST API Resend (https://resend.com/docs/api-reference)
// — cukup fetch, tanpa SDK tambahan. Domain pengirim harus status "Verified"
// di dashboard Resend; kalau belum, Resend menolak dengan 403 dan pesannya
// terlihat di `wrangler tail` (log error di bawah).
import type { Env } from '../types';

const FROM = 'Tryout UPKP <info@ditryout.in>';
// Balasan email situs diarahkan ke inbox pribadi admin (info@ tidak punya MX —
// domain ini kirim-saja). Balasan broadcast di Resend memakai nilai yang sama.
const REPLY_TO = 'iksan10058@gmail.com';

// Tautan di email notifikasi selalu ke domain produksi: cron tidak punya
// request (tidak ada origin), dan email dibaca di luar sesi dev lokal.
export const SITE_URL = 'https://ditryout.in';

export type EmailKind = 'reset' | 'receipt' | 'reminder' | 'welcome';

// Kuota harian Resend dipakai BERSAMA semua jenis email. Ambang = porsi kuota
// (rolling 24 jam) yang boleh sudah terpakai sebelum jenis ini berhenti
// dikirim: sambutan berhenti paling dulu, lalu pengingat, lalu bukti bayar —
// sisa kuota selalu tersedia untuk reset password (tanpa ambang: satu-satunya
// jalan user kembali ke akunnya; batas akhirnya ditegakkan Resend sendiri).
const KIND_QUOTA_SHARE: Record<EmailKind, number | null> = {
  reset: null,
  receipt: 0.95,
  reminder: 0.85,
  welcome: 0.7,
};

// Paket Free Resend = 100 email/hari. Upgrade paket → naikkan EMAIL_DAILY_LIMIT
// di wrangler.jsonc (tanpa ubah kode).
function dailyLimit(env: Env): number {
  const n = Number(env.EMAIL_DAILY_LIMIT);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 100;
}

// Hanya email yang (mungkin) diterima Resend yang memakan kuota — 'failed' tidak.
async function usedLast24h(db: D1Database): Promise<number> {
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM email_log WHERE created_at > ? AND status != 'failed'`)
    .bind(since)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function postResend(
  apiKey: string,
  to: string,
  subject: string,
  html: string,
): Promise<boolean> {
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: FROM, reply_to: REPLY_TO, to: [to], subject, html }),
    });
    if (!res.ok) {
      // Body berisi alasan Resend (domain belum verified, key salah, kuota habis, dsb.)
      console.error('[resend] gagal kirim ke', to, res.status, await res.text());
      return false;
    }
    return true;
  } catch (e) {
    console.error('[resend] error jaringan', e);
    return false;
  }
}

export type EmailMessage = {
  kind: EmailKind;
  to: string;
  subject: string;
  html: string;
  userId?: number | null;
  // Diisi untuk email per transaksi: unique (kind, payment_id) = anti-dobel
  // lintas jalur (webhook + polling + cron bisa men-settle hampir bersamaan).
  paymentId?: number | null;
};

/**
 * Kirim satu email + catat di email_log. Tidak pernah throw — semua pemanggil
 * memperlakukan email sebagai efek samping yang tidak boleh menggagalkan alur
 * utama (daftar, settlement, reset). Return true bila diterima Resend.
 */
export async function sendEmail(env: Env, msg: EmailMessage): Promise<boolean> {
  if (!env.RESEND_API_KEY) {
    console.error('[resend] RESEND_API_KEY belum diset — email', msg.kind, 'tidak terkirim');
    return false;
  }

  let logId: number | null = null;
  try {
    const share = KIND_QUOTA_SHARE[msg.kind];
    if (share !== null) {
      const used = await usedLast24h(env.DB);
      const cap = Math.floor(dailyLimit(env) * share);
      if (used >= cap) {
        console.log('[resend] kuota', msg.kind, 'dilewati', used, '/', cap);
        return false;
      }
    }
    // Klaim dulu baru kirim: pemanggil kedua untuk (kind, payment) yang sama
    // kalah di unique index (changes=0) dan tidak mengirim ulang.
    const ins = await env.DB.prepare(
      'INSERT OR IGNORE INTO email_log (kind, user_id, payment_id, status, created_at) VALUES (?, ?, ?, ?, ?)',
    )
      .bind(msg.kind, msg.userId ?? null, msg.paymentId ?? null, 'sending', new Date().toISOString())
      .run();
    if (!ins.meta.changes) return false;
    logId = Number(ins.meta.last_row_id);
  } catch (e) {
    // Tabel belum ada (deploy mendahului migrasi) / D1 bermasalah: reset password
    // tetap dikirim — tanpa itu user terkunci dari akunnya. Email lain dilewati
    // karena anti-dobel & kuotanya tidak bisa dijamin.
    console.error('[resend] email_log error', msg.kind, e);
    if (msg.kind !== 'reset') return false;
  }

  const sent = await postResend(env.RESEND_API_KEY, msg.to, msg.subject, msg.html);
  if (logId !== null) {
    try {
      await env.DB.prepare('UPDATE email_log SET status=? WHERE id=?')
        .bind(sent ? 'sent' : 'failed', logId)
        .run();
    } catch (e) {
      console.error('[resend] update email_log', logId, e);
    }
  }
  return sent;
}

// ---------- Helper template ----------
// Email client tidak memuat CSS eksternal — semua style harus inline.

export function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (ch) =>
    ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '"' ? '&quot;' : '&#39;',
  );
}

export function rupiah(n: number): string {
  return 'Rp' + Math.round(n).toLocaleString('id-ID');
}

// Tampilan waktu user = WITA (Asia/Makassar), konsisten dengan UI.
export function fmtWita(iso: string | null | undefined): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  return (
    new Intl.DateTimeFormat('id-ID', {
      timeZone: 'Asia/Makassar',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(d) + ' WITA'
  );
}

// Nama depan untuk sapaan; sebagian peserta mengisi nama dengan email.
export function firstName(name: string | null | undefined): string {
  const first = String(name ?? '').trim().split(/\s+/)[0] ?? '';
  return !first || first.includes('@') ? 'Peserta' : first;
}

function button(href: string, label: string): string {
  return `<a href="${esc(href)}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;padding:13px 28px;border-radius:8px;font-weight:bold;font-size:15px">${esc(label)}</a>`;
}

// preheader = teks pratinjau di daftar inbox (disembunyikan di badan email).
function layout(preheader: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="id">
<body style="margin:0;padding:24px;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif;color:#0f172a">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(preheader)}</div>
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:28px">
    <img src="${SITE_URL}/img/logo-192.png" alt="Tryout UPKP" width="48" height="48" style="display:block;margin-bottom:16px">
    ${body}
  </div>
  <p style="max-width:560px;margin:16px auto 0;font-size:12px;line-height:1.5;color:#64748b;text-align:center">
    Email otomatis dari Tryout UPKP (<a href="${SITE_URL}" style="color:#64748b">ditryout.in</a>).
    Ada pertanyaan? Cukup balas email ini.
  </p>
</body>
</html>`;
}

function detailTable(rows: [string, string][]): string {
  return `<table role="presentation" style="width:100%;border-collapse:collapse;margin:0 0 20px;font-size:14px">
    ${rows
      .map(
        ([k, v]) =>
          `<tr><td style="padding:8px 0;border-bottom:1px solid #e2e8f0;color:#64748b">${esc(k)}</td><td style="padding:8px 0;border-bottom:1px solid #e2e8f0;text-align:right;font-weight:bold">${esc(v)}</td></tr>`,
      )
      .join('')}
  </table>`;
}

const BENEFITS = [
  'Simulasi seperti hari-H: kategori berurutan dengan timer yang dijaga server.',
  'Pembahasan di setiap soal, jadi kamu tahu kenapa jawabanmu keliru.',
  'Skor per kategori dibanding passing grade, plus riwayat nilai untuk memantau kemajuan.',
  'Bank soal yang terus bertambah dan ringkasan materi PDF.',
  'Satu kali beli, semua paket dan seluruh soal terbuka selama masa akses.',
];

function benefitList(items: string[]): string {
  return `<ul style="margin:0 0 20px;padding-left:20px;line-height:1.7">${items
    .map((b) => `<li>${esc(b)}</li>`)
    .join('')}</ul>`;
}

// ---------- Template ----------

function resetEmailHtml(resetUrl: string): string {
  return layout(
    'Tautan reset password akun Tryout UPKP kamu.',
    `<h2 style="margin:0 0 12px;font-size:20px">Permintaan Reset Password</h2>
    <p style="margin:0 0 20px;line-height:1.6">
      Kami menerima permintaan reset password untuk akun Tryout UPKP milik email ini.
      Klik tombol di bawah untuk mengatur password baru.
    </p>
    ${button(resetUrl, 'Reset Password')}
    <p style="margin:20px 0 8px;line-height:1.6">Atau salin tautan berikut ke browser Anda:</p>
    <p style="margin:0 0 20px;word-break:break-all"><a href="${esc(resetUrl)}" style="color:#2563eb">${esc(resetUrl)}</a></p>
    <p style="margin:0 0 8px;line-height:1.6">
      Tautan berlaku <strong>1 jam</strong> dan hanya bisa dipakai <strong>sekali</strong>.
    </p>
    <p style="margin:0;line-height:1.6;color:#64748b">
      Jika Anda tidak meminta reset password, abaikan email ini —
      password Anda tidak akan berubah.
    </p>`,
  );
}

export type WelcomeProduct = { id: number; name: string; price: number; duration_days: number };

export function welcomeEmailHtml(opts: {
  name: string;
  products: WelcomeProduct[];
  discountPct: number;
}): string {
  const priceOf = (p: WelcomeProduct) =>
    opts.discountPct ? p.price - Math.round((p.price * opts.discountPct) / 100) : p.price;
  const productRows = opts.products
    .map(
      (p) => `<tr>
        <td style="padding:10px 0;border-bottom:1px solid #e2e8f0">
          <strong>${esc(p.name)}</strong><br>
          <span style="color:#64748b;font-size:13px">${p.duration_days} hari akses penuh · setara ${rupiah(Math.floor(priceOf(p) / p.duration_days))}/hari</span>
        </td>
        <td style="padding:10px 0;border-bottom:1px solid #e2e8f0;text-align:right;white-space:nowrap">
          ${opts.discountPct ? `<span style="color:#94a3b8;text-decoration:line-through;font-size:13px">${rupiah(p.price)}</span><br>` : ''}
          <strong>${rupiah(priceOf(p))}</strong><br>
          <a href="${SITE_URL}/payment.html?product=${p.id}" style="color:#2563eb;font-size:13px">Pilih</a>
        </td>
      </tr>`,
    )
    .join('');

  return layout(
    'Akunmu sudah aktif. Ini yang bisa kamu pakai untuk persiapan UPKP.',
    `<h2 style="margin:0 0 12px;font-size:20px">Selamat datang, ${esc(firstName(opts.name))}!</h2>
    <p style="margin:0 0 16px;line-height:1.6">
      Akun Tryout UPKP kamu sudah aktif. Ini yang bisa kamu dapatkan untuk persiapan UPKP:
    </p>
    ${benefitList(BENEFITS)}
    ${
      opts.discountPct
        ? `<div style="margin:0 0 20px;padding:12px 14px;background:#ecfdf5;border-radius:8px;line-height:1.6">
            Kamu daftar lewat undangan teman: dapat <strong>diskon ${opts.discountPct}%</strong> untuk pembelian akses pertamamu. Harga di bawah sudah dipotong.
          </div>`
        : ''
    }
    ${
      opts.products.length
        ? `<h3 style="margin:0 0 8px;font-size:16px">Pilihan paket akses</h3>
          <table role="presentation" style="width:100%;border-collapse:collapse;margin:0 0 20px;font-size:14px">${productRows}</table>`
        : ''
    }
    ${button(`${SITE_URL}/payment.html`, 'Lihat Paket & Mulai Latihan')}
    <p style="margin:20px 0 0;line-height:1.6;color:#64748b">
      Simpan email ini. Bukti pembayaran dan tautan reset password akan dikirim ke alamat ini.
    </p>`,
  );
}

export function receiptEmailHtml(opts: {
  name: string;
  productName: string;
  reference: string;
  paid: number;
  paidAt: string | null;
  accessUntil: string | null;
}): string {
  return layout(
    `Pembayaran ${opts.productName} berhasil. Akses aktif sampai ${fmtWita(opts.accessUntil)}.`,
    `<h2 style="margin:0 0 12px;font-size:20px">Pembayaran Berhasil</h2>
    <p style="margin:0 0 16px;line-height:1.6">
      Terima kasih, ${esc(firstName(opts.name))}! Pembayaranmu sudah kami terima dan akses tryout sudah aktif.
    </p>
    ${detailTable([
      ['Produk', opts.productName],
      ['No. referensi', opts.reference],
      ['Total dibayar', rupiah(opts.paid)],
      ['Waktu bayar', fmtWita(opts.paidAt)],
      ['Akses aktif sampai', fmtWita(opts.accessUntil)],
    ])}
    ${button(`${SITE_URL}/dashboard.html`, 'Mulai Tryout')}
    <p style="margin:20px 0 0;line-height:1.6;color:#64748b">
      Simpan email ini sebagai bukti pembayaran. Semua paket dan seluruh soal terbuka selama masa aksesmu.
    </p>`,
  );
}

export function reminderEmailHtml(opts: {
  name: string;
  productName: string;
  durationDays: number | null;
  // Tagihan masih bisa dibayar (Pakasir: 24 jam) → tautan lanjut bayar;
  // null = sudah kedaluwarsa → tautan buat tagihan baru.
  payUntil: string | null;
  amountDue: number | null;
  payUrl: string;
  supportWa: string;
}): string {
  const stillOpen = !!opts.payUntil;
  const rows: [string, string][] = [['Paket', opts.productName]];
  if (opts.durationDays) rows.push(['Masa akses', `${opts.durationDays} hari`]);
  if (stillOpen && opts.amountDue) rows.push(['Total tagihan', rupiah(opts.amountDue)]);
  if (stillOpen) rows.push(['Bayar sebelum', fmtWita(opts.payUntil)]);

  return layout(
    stillOpen
      ? `Tagihan ${opts.productName} masih menunggu pembayaran.`
      : `Tagihan ${opts.productName} sudah kedaluwarsa, buat tagihan baru dalam satu klik.`,
    `<h2 style="margin:0 0 12px;font-size:20px">Pembayaranmu Belum Selesai</h2>
    <p style="margin:0 0 16px;line-height:1.6">
      Halo ${esc(firstName(opts.name))}, kamu sempat memesan akses Tryout UPKP tetapi pembayarannya belum selesai.
      ${
        stillOpen
          ? 'Tagihanmu masih aktif, jadi kamu bisa langsung melanjutkannya.'
          : 'Tagihan QRIS sebelumnya sudah kedaluwarsa, tapi kamu bisa membuat tagihan baru kapan saja dalam satu klik.'
      }
    </p>
    ${detailTable(rows)}
    ${button(opts.payUrl, stillOpen ? 'Lanjutkan Pembayaran' : 'Buat Tagihan Baru')}
    <p style="margin:20px 0 8px;line-height:1.6">Setelah bayar, akses langsung aktif otomatis untuk:</p>
    ${benefitList(BENEFITS.slice(0, 3))}
    <p style="margin:0;line-height:1.6;color:#64748b">
      Ada kendala saat membayar? Balas email ini${
        opts.supportWa
          ? ` atau hubungi <a href="https://wa.me/${esc(opts.supportWa)}" style="color:#2563eb">WhatsApp admin</a>`
          : ''
      }.
      Sudah membayar? Abaikan email ini — akses aktif otomatis begitu pembayaran terverifikasi.
    </p>`,
  );
}

/**
 * Kirim email reset password. Mengembalikan true/false (bukan throw) agar
 * pemanggil bisa menjaga respons endpoint tetap netral — kegagalan kirim
 * cukup di-log untuk observability, tidak di-bocorkan ke peminta.
 */
export async function sendPasswordResetEmail(
  env: Env,
  userId: number,
  to: string,
  resetUrl: string,
): Promise<boolean> {
  return sendEmail(env, {
    kind: 'reset',
    to,
    userId,
    subject: 'Reset password akun Tryout UPKP',
    html: resetEmailHtml(resetUrl),
  });
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
