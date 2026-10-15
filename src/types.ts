export type Env = {
  DB: D1Database;
  ASSETS: Fetcher;
  // Bucket R2 untuk byte PDF materi bacaan (metadata ada di tabel materials).
  MATERI_BUCKET: R2Bucket;
  SESSION_SECRET: string;
  PAKASIR_API_KEY?: string;
  PAKASIR_PROJECT?: string;
  PAKASIR_WEBHOOK_SECRET?: string;
  // Duitku — gateway alternatif (QRIS). API key = RAHASIA: set lewat
  // `wrangler secret put DUITKU_API_KEY` / .dev.vars, jangan di git.
  // DUITKU_SANDBOX "true" = pakai sandbox.duitku.com (uji) — sandbox tidak
  // pernah dipakai untuk transaksi user di host produksi (lihat services/duitku).
  DUITKU_MERCHANT_CODE?: string;
  DUITKU_API_KEY?: string;
  DUITKU_SANDBOX?: string;
  // Daftar preferensi channel QRIS Duitku, dipisah koma (default 'SQ,NQ,SP' —
  // SQ = Nusapay, NQ = Nobu, SP = ShopeePay; channel pertama yang diterima dipakai).
  DUITKU_QRIS_METHOD?: string;
  // Fee QRIS Duitku (%) yang ditanggung merchant — dipass-through ke pembeli
  // via gross-up nominal (lihat duitkuFeePct/grossUp di services/duitku).
  // "0.7" = MDR QRIS Duitku; kosong/0 = tanpa markup (fee menanggung merchant).
  DUITKU_FEE_PCT?: string;
  // Gateway aktif untuk transaksi baru (baseline env — toggle admin di tabel
  // settings D1 menimpa ini, sama seperti payment_mode).
  ACTIVE_GATEWAY?: string;
  SETUP_SECRET?: string;
  // "manual" = QRIS pribadi + verifikasi admin (mode fallback bila gateway bermasalah);
  // selain itu (default) = gateway otomatis. Baseline saja — toggle admin
  // (settings.payment_mode) menimpa nilai ini.
  PAYMENT_MODE?: string;
  // "true" = tombol Bayar Manual tampil di halaman bayar (fallback gateway).
  // Selain "true" = disembunyikan; alur manual tetap hidup jika PAYMENT_MODE=manual.
  SHOW_MANUAL_PAYMENT?: string;
  // Nomor WA (format internasional tanpa +) untuk konfirmasi pembayaran manual.
  MANUAL_WA?: string;
  // Cloudflare Turnstile (anti-bot register/login). Aktif jika keduanya terisi.
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  // Resend — pengirim email reset password. Rahasia: set lewat
  // `wrangler secret put RESEND_API_KEY` atau dashboard Cloudflare, bukan di git.
  RESEND_API_KEY?: string;
  // Kuota email harian paket Resend (default 100 = paket Free). Penjaga kuota
  // berhenti mengirim email prioritas rendah sebelum batas ini tercapai.
  EMAIL_DAILY_LIMIT?: string;
  // Durable Object rate limiter (counter per limiter+key).
  RATE_LIMIT_DO: DurableObjectNamespace;
};

export type SessionUser = {
  id: number;
  name: string;
  email: string;
  role: 'user' | 'admin';
  access_expires_at: string | null;
  access_started_at: string | null;
};

export type AppEnv = {
  Bindings: Env;
  Variables: {
    user: SessionUser;
    sessionId: number;
  };
};
