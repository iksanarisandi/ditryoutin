import type { Env } from '../types';

// Login dengan Google — OAuth 2.0 authorization code flow + PKCE, dijalankan
// di server (tanpa SDK/JS Google di frontend). Scope hanya openid/email/profile
// (non-sensitif: tanpa review keamanan Google). Token akses Google tidak pernah
// disimpan — dipakai sekali untuk membaca identitas lalu dibuang.

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);
const PROD_ORIGIN = 'https://ditryout.in';
const DEV_ORIGIN = 'http://localhost:8787';
const CALLBACK_PATH = '/api/auth/google/callback';

export function googleEnabled(env: Env): boolean {
  return !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}

// redirect_uri harus SAMA PERSIS dengan yang terdaftar di Google Console dan
// sama antara langkah authorize dan tukar kode. Tidak boleh diturunkan dari
// c.req.url: wrangler dev me-rewrite host menjadi ditryout.in walau lokal.
// Request dari edge Cloudflare asli selalu membawa x-forwarded-proto (lihat
// guardHost di services/duitku) → produksi; tanpa header itu → dev lokal.
export function googleRedirectUri(env: Env, forwardedProto: string | undefined): string {
  if (env.GOOGLE_REDIRECT_URI) return env.GOOGLE_REDIRECT_URI;
  return (forwardedProto ? PROD_ORIGIN : DEV_ORIGIN) + CALLBACK_PATH;
}

function b64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecodeText(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return new TextDecoder().decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0)));
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return b64url(new Uint8Array(digest));
}

export function googleAuthUrl(
  env: Env,
  redirectUri: string,
  state: string,
  codeChallenge: string,
): string {
  const p = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID as string,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    // Selalu tampilkan pemilih akun: banyak peserta punya >1 akun Google
    // (pribadi & kantor) dan perlu memilih yang benar.
    prompt: 'select_account',
    access_type: 'online',
  });
  return `${AUTH_URL}?${p.toString()}`;
}

export type GoogleIdentity = {
  sub: string;
  email: string;
  emailVerified: boolean;
  // Google otoritatif atas email ini (Gmail, atau akun Workspace ber-klaim hd).
  // Untuk alamat lain, email_verified hanya berarti "pernah diverifikasi" —
  // kepemilikannya bisa sudah berpindah (mis. domain kedaluwarsa dibeli orang).
  emailAuthoritative: boolean;
  name: string;
};

export class GoogleAuthError extends Error {}

/**
 * Tukar authorization code dengan ID token lalu baca identitasnya.
 * Tanda tangan ID token tidak diverifikasi ulang: token diterima LANGSUNG dari
 * endpoint token Google lewat TLS dengan client secret kita (OpenID Connect
 * Core 3.1.3.7 butir 6 mengizinkan ini). iss/aud/exp tetap dicek.
 */
export async function exchangeGoogleCode(
  env: Env,
  code: string,
  codeVerifier: string,
  redirectUri: string,
): Promise<GoogleIdentity> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID as string,
      client_secret: env.GOOGLE_CLIENT_SECRET as string,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code_verifier: codeVerifier,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const data = (await res.json().catch(() => null)) as { id_token?: string; error?: string } | null;
  if (!res.ok || !data?.id_token) {
    throw new GoogleAuthError(`token ${res.status} ${data?.error ?? ''}`.trim());
  }

  const parts = data.id_token.split('.');
  if (parts.length !== 3) throw new GoogleAuthError('id_token tidak valid');
  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(b64urlDecodeText(parts[1])) as Record<string, unknown>;
  } catch {
    throw new GoogleAuthError('id_token tidak bisa dibaca');
  }
  if (!ISSUERS.has(String(claims.iss))) throw new GoogleAuthError('iss tidak cocok');
  if (claims.aud !== env.GOOGLE_CLIENT_ID) throw new GoogleAuthError('aud tidak cocok');
  if (typeof claims.exp !== 'number' || claims.exp * 1000 < Date.now()) {
    throw new GoogleAuthError('id_token kedaluwarsa');
  }
  if (typeof claims.sub !== 'string' || !claims.sub || typeof claims.email !== 'string') {
    throw new GoogleAuthError('klaim sub/email tidak ada');
  }
  const lower = claims.email.toLowerCase();
  return {
    sub: claims.sub,
    email: claims.email,
    // Google mengirim boolean; sebagian dokumentasi lama menyebut string "true".
    emailVerified: claims.email_verified === true || claims.email_verified === 'true',
    emailAuthoritative:
      lower.endsWith('@gmail.com') ||
      lower.endsWith('@googlemail.com') ||
      (typeof claims.hd === 'string' && claims.hd !== ''),
    name: typeof claims.name === 'string' ? claims.name : '',
  };
}
