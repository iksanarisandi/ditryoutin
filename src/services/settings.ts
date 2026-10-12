import type { Env } from '../types';

// Mode pembayaran efektif aplikasi. Sumber kebenaran: baris `payment_mode` di
// tabel settings (D1) — ditulis toggle admin di panel Transaksi, efektif tanpa
// deploy. Bila belum pernah di-toggle (baris belum ada), fallback ke env var:
// PAYMENT_MODE=manual -> manual; SHOW_MANUAL_PAYMENT=true -> hybrid; selain itu gateway.
// Nilai 'gateway' dulunya 'pakasir' (di-rename migration 0015 setelah ada dua
// gateway) — alias lama tetap diterima agar tab admin lama tidak merusak nilai.
export type PaymentMode = 'gateway' | 'hybrid' | 'manual';
const MODES: readonly PaymentMode[] = ['gateway', 'hybrid', 'manual'];

export function parsePaymentMode(v: unknown): PaymentMode | null {
  if (typeof v !== 'string') return null;
  if (v === 'pakasir') return 'gateway'; // alias legacy (pre-Duitku)
  return (MODES as readonly string[]).includes(v) ? (v as PaymentMode) : null;
}

export async function getPaymentMode(env: Env): Promise<PaymentMode> {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key=?')
    .bind('payment_mode')
    .first<{ value: string }>();
  const fromDb = parsePaymentMode(row?.value);
  if (fromDb) return fromDb;
  if (env.PAYMENT_MODE === 'manual') return 'manual';
  if (env.SHOW_MANUAL_PAYMENT === 'true') return 'hybrid';
  return 'gateway';
}

export async function setPaymentMode(env: Env, mode: PaymentMode): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES ('payment_mode', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
  )
    .bind(mode, new Date().toISOString())
    .run();
}

// Gateway aktif untuk transaksi QRIS baru (Pakasir / Duitku). Toggle admin di
// panel Transaksi (tabel settings, key 'active_gateway') menimpa env ACTIVE_GATEWAY.
// Bila gateway aktif error saat create, route pembayaran otomatis mencoba
// gateway satunya bila layak dipakai (services/duitku: duitkuUsable).
export type Gateway = 'pakasir' | 'duitku';
const GATEWAYS: readonly Gateway[] = ['pakasir', 'duitku'];

export function parseGateway(v: unknown): Gateway | null {
  return typeof v === 'string' && (GATEWAYS as readonly string[]).includes(v)
    ? (v as Gateway)
    : null;
}

export async function getActiveGateway(env: Env): Promise<Gateway> {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key=?')
    .bind('active_gateway')
    .first<{ value: string }>();
  const fromDb = parseGateway(row?.value);
  if (fromDb) return fromDb;
  return parseGateway(env.ACTIVE_GATEWAY) ?? 'pakasir';
}

export async function setActiveGateway(env: Env, gateway: Gateway): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES ('active_gateway', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
  )
    .bind(gateway, new Date().toISOString())
    .run();
}
