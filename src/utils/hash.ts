import { argon2id as argon2idRaw } from '@noble/hashes/argon2.js';

// Argon2id (prioritas PRD) via @noble/hashes — implementasi JS murni tanpa WASM,
// karena workerd melarang kompilasi WASM dinamis (WebAssembly.compile).
// Parameter mengikuti rekomendasi OWASP (m=19456 KiB, t=2, p=1), hash 32 byte.
// Hasil disimpan sebagai string PHC sehingga parameter bisa dinaikkan lagi tanpa migrasi.

const T = 2;
const M = 19456;
const P = 1;
const DKLEN = 32;

/** Uint8Array -> base64 tanpa padding (format PHC). */
function b64u(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/=+$/, '');
}

/** base64 tanpa padding -> Uint8Array. */
function b64uDecode(s: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]+$/.test(s)) throw new Error('bad base64');
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s + pad);
  return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
}

export function hashPassword(password: string): string {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = argon2idRaw(password, salt, { t: T, m: M, p: P, dkLen: DKLEN });
  return `$argon2id$v=19$m=${M},t=${T},p=${P}$${b64u(salt)}$${b64u(hash)}`;
}

/** SHA-256 hex dari string — untuk menyimpan token reset password.
 *  Token punya 256-bit entropi acak sehingga hash polos sudah cukup
 *  (berbeda dari sesi yang memakai HMAC karena tokennya bisa ditebak user). */
export async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function verifyPassword(password: string, phc: string): boolean {
  try {
    // format: $argon2id$v=19$m=..,t=..,p=..$<salt_b64>$<hash_b64>
    const parts = phc.split('$');
    if (parts.length !== 6 || parts[1] !== 'argon2id' || parts[2] !== 'v=19') return false;
    const params = new Map(
      parts[3].split(',').map((kv) => {
        const [k, v] = kv.split('=');
        return [k, Number(v)];
      }),
    );
    const t = params.get('t');
    const m = params.get('m');
    const p = params.get('p');
    if (!t || !m || !p || t < 1 || m < 8 || p < 1 || t > 16 || m > 1048576 || p > 8) return false;
    const salt = b64uDecode(parts[4]);
    const expected = b64uDecode(parts[5]);
    if (salt.length < 8 || expected.length < 16 || expected.length > 512) return false;
    const actual = argon2idRaw(password, salt, { t, m, p, dkLen: expected.length });
    // bandingkan konstan-waktu
    let diff = actual.length ^ expected.length;
    for (let i = 0; i < actual.length && i < expected.length; i++) diff |= actual[i] ^ expected[i];
    return diff === 0;
  } catch {
    return false;
  }
}
