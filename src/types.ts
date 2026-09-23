export type Env = {
  DB: D1Database;
  ASSETS: Fetcher;
  SESSION_SECRET: string;
  PAKASIR_API_KEY?: string;
  PAKASIR_PROJECT?: string;
  PAKASIR_WEBHOOK_SECRET?: string;
  SETUP_SECRET?: string;
  // "manual" = QRIS pribadi + verifikasi admin (mode transisi selama sandbox);
  // selain itu (default) = Pakasir.
  PAYMENT_MODE?: string;
  // Nomor WA (format internasional tanpa +) untuk konfirmasi pembayaran manual.
  MANUAL_WA?: string;
  // Cloudflare Turnstile (anti-bot register/login). Aktif jika keduanya terisi.
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
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
