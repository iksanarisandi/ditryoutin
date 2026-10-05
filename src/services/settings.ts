import type { Env } from '../types';

// Mode pembayaran efektif aplikasi. Sumber kebenaran: baris `payment_mode` di
// tabel settings (D1) — ditulis toggle admin di panel Transaksi, efektif tanpa
// deploy. Bila belum pernah di-toggle (baris belum ada), fallback ke env var:
// PAYMENT_MODE=manual -> manual; SHOW_MANUAL_PAYMENT=true -> hybrid; selain itu pakasir.
export type PaymentMode = 'pakasir' | 'hybrid' | 'manual';
const MODES: readonly PaymentMode[] = ['pakasir', 'hybrid', 'manual'];

export function parsePaymentMode(v: unknown): PaymentMode | null {
  return typeof v === 'string' && (MODES as readonly string[]).includes(v)
    ? (v as PaymentMode)
    : null;
}

export async function getPaymentMode(env: Env): Promise<PaymentMode> {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key=?')
    .bind('payment_mode')
    .first<{ value: string }>();
  const fromDb = parsePaymentMode(row?.value);
  if (fromDb) return fromDb;
  if (env.PAYMENT_MODE === 'manual') return 'manual';
  if (env.SHOW_MANUAL_PAYMENT === 'true') return 'hybrid';
  return 'pakasir';
}

export async function setPaymentMode(env: Env, mode: PaymentMode): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES ('payment_mode', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
  )
    .bind(mode, new Date().toISOString())
    .run();
}
