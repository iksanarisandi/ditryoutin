export const SESSION_COOKIE = 'tryout_session';
export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

export function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Token sesi tidak pernah disimpan mentah di DB — hanya HMAC-SHA256(SESSION_SECRET, token).
export async function hashToken(secret: string, token: string): Promise<string> {
  return hmacHex(secret, token);
}

export function sessionSetCookie(token: string, secure: boolean): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure ? '; Secure' : ''}`;
}

export function clearSessionCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
}

export function isSecureRequest(c: { req: { url: string } }): boolean {
  return new URL(c.req.url).protocol === 'https:';
}

// Enforce satu akun = satu sesi: sesi lama dihapus, sesi baru dibuat.
export async function createSession(db: D1Database, secret: string, userId: number): Promise<string> {
  await db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId).run();
  const token = generateToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  await db
    .prepare('INSERT INTO sessions (user_id, token_hash, expires_at) VALUES (?, ?, ?)')
    .bind(userId, await hashToken(secret, token), expiresAt)
    .run();
  return token;
}
