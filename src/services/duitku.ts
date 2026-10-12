// Klien Duitku Payment Gateway (V.2 API) — gateway alternatif selain Pakasir.
// QRIS saja untuk saat ini (paymentMethod 'SP' = ShopeePay QRIS, interoperabel
// untuk semua aplikasi QRIS; bisa diganti via env DUITKU_QRIS_METHOD, mis. 'NQ').

import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import type { Env } from '../types';

const SANDBOX_BASE = 'https://sandbox.duitku.com/webapi/api/merchant';
const PROD_BASE = 'https://passport.duitku.com/webapi/api/merchant';

// Batas bayar QRIS Duitku (dikirim sebagai expiryPeriod, menit). Docs: maks 60.
export const DUITKU_QRIS_EXPIRY_MINUTES = 30;

export class DuitkuError extends Error {
  // HTTP status respons gateway (bila ada).
  constructor(message: string, public status?: number) {
    super(message);
  }
}

export type DuitkuTxn = {
  reference: string; // referensi gateway — disimpan ke payments.txn_id
  qr_string?: string;
  payment_url?: string;
  amount?: number;
  is_sandbox: boolean;
};

// Kosakata status sama dengan PakasirTxn.status agar polling/rekonsiliasi seragam.
export type DuitkuStatus = {
  state: 'completed' | 'pending' | 'expired';
  statusCode: string;
  reference?: string;
  amount?: number;
};

export type DuitkuConfig = {
  merchantCode: string;
  apiKey: string;
  sandbox: boolean;
  base: string;
};

export function duitkuConfig(env: Env): DuitkuConfig | null {
  const merchantCode = env.DUITKU_MERCHANT_CODE?.trim();
  const apiKey = env.DUITKU_API_KEY?.trim();
  if (!merchantCode || !apiKey) return null;
  const sandbox = env.DUITKU_SANDBOX === 'true';
  return { merchantCode, apiKey, sandbox, base: sandbox ? SANDBOX_BASE : PROD_BASE };
}

export function isDuitkuConfigured(env: Env): boolean {
  return duitkuConfig(env) !== null;
}

// Gateway sandbox tidak boleh menangani uang user nyata di host produksi.
// Sandbox tetap bisa dipakai penuh di localhost / preview *.workers.dev untuk
// uji end-to-end (termasuk callback sungguhan dari Duitku).
//
// CATATAN PENTING: `wrangler dev` me-rewrite host di c.req.url DAN header Host
// menjadi domain custom dari routes config (ditryout.in) walau dijalankan lokal
// — host saja TIDAK cukup membedakan dev vs produksi. Sinyal pembeda yang andal:
// header x-forwarded-proto, selalu diset edge Cloudflare asli dan tidak pernah
// diset wrangler dev (asumsi sama dengan middleware force-HTTPS di index.ts;
// edge juga selalu menimpa nilainya sehingga tak bisa dipalsukan visitor).
// Host hanya dipercaya bila request benar-benar lewat edge.
export function isProdHost(host: string | undefined): boolean {
  const h = host?.toLowerCase().split(':')[0];
  return h === 'ditryout.in' || h === 'www.ditryout.in';
}

/** Host efektif untuk guard sandbox: undefined = pasti bukan edge produksi. */
export function guardHost(headerHost: string | undefined, forwardedProto: string | undefined): string | undefined {
  return forwardedProto ? headerHost : undefined;
}

/** Boleh dipakai membuat transaksi? (terkonfigurasi + bukan sandbox di host produksi) */
export function duitkuUsable(env: Env, host: string | undefined): boolean {
  const cfg = duitkuConfig(env);
  return cfg !== null && !(cfg.sandbox && isProdHost(host));
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Skema signature resmi terbaru (docs.duitku.com): HMAC-SHA256(stringToSign, apiKey),
// hex lowercase — terverifikasi sandbox 2026-10-08 via scripts/duitku-smoke.mjs.
// Varian warisan (bila kelak produksi menolak): MD5(concat + apiKey), tersedia
// TANPA dependency baru dari '@noble/hashes/legacy.js' (md5) — cukup ganti fungsi ini.
function sign(stringToSign: string, apiKey: string): string {
  const enc = new TextEncoder();
  return toHex(hmac(sha256, enc.encode(apiKey), enc.encode(stringToSign)));
}

async function duitkuFetch(url: string, body: unknown): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new DuitkuError('Tidak dapat menghubungi server Duitku');
  }
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok || !json) {
    const msg = (json?.statusMessage ?? json?.responseMessage ?? `Duitku merespon ${res.status}`);
    throw new DuitkuError(String(msg), res.status);
  }
  return json;
}

// POST /v2/inquiry — buat invoice QRIS. merchantOrderId = reference transaksi
// kita (format TO-... bersambung minus, diterima — lihat smoke test).
export async function createTransaction(
  env: Env,
  opts: {
    orderId: string;
    amount: number;
    productDetails: string;
    email: string;
    customerName: string;
    callbackUrl: string;
    returnUrl: string;
  },
): Promise<DuitkuTxn> {
  const cfg = duitkuConfig(env);
  if (!cfg) throw new DuitkuError('Duitku belum dikonfigurasi');

  const json = await duitkuFetch(`${cfg.base}/v2/inquiry`, {
    merchantCode: cfg.merchantCode,
    paymentAmount: opts.amount,
    merchantOrderId: opts.orderId,
    productDetails: opts.productDetails.slice(0, 255),
    paymentMethod: (env.DUITKU_QRIS_METHOD || 'SP').toUpperCase(),
    customerVaName: opts.customerName.slice(0, 20), // docs: string(20)
    email: opts.email,
    callbackUrl: opts.callbackUrl,
    returnUrl: opts.returnUrl,
    expiryPeriod: DUITKU_QRIS_EXPIRY_MINUTES,
    signature: sign(cfg.merchantCode + opts.orderId + opts.amount, cfg.apiKey),
  });

  if (json.statusCode !== '00') {
    throw new DuitkuError(String(json.statusMessage ?? 'Duitku menolak transaksi'));
  }
  return {
    reference: String(json.reference ?? ''),
    qr_string: typeof json.qrString === 'string' ? json.qrString : undefined,
    payment_url: typeof json.paymentUrl === 'string' ? json.paymentUrl : undefined,
    amount: typeof json.amount === 'string' ? Number(json.amount) : undefined,
    is_sandbox: cfg.sandbox,
  };
}

// POST /transactionStatus — cek by merchantOrderId (= reference kita, bukan txn_id).
// statusCode: '00' sukses, '01' proses, '02' gagal/kedaluwarsa (docs.duitku.com).
// Catatan rate limit Duitku: polling terlalu rapat memicu blokir ~1 jam —
// panggil ini paling cepat 15 detik/transaksi (shouldCheckStatus di services/payments).
export async function getTransactionStatus(env: Env, merchantOrderId: string): Promise<DuitkuStatus> {
  const cfg = duitkuConfig(env);
  if (!cfg) throw new DuitkuError('Duitku belum dikonfigurasi');

  const json = await duitkuFetch(`${cfg.base}/transactionStatus`, {
    merchantCode: cfg.merchantCode,
    merchantOrderId,
    signature: sign(cfg.merchantCode + merchantOrderId, cfg.apiKey),
  });

  const statusCode = String(json.statusCode ?? '');
  if (statusCode === '00') return { state: 'completed', statusCode, reference: json.reference ? String(json.reference) : undefined, amount: json.amount ? Number(json.amount) : undefined };
  if (statusCode === '01') return { state: 'pending', statusCode, reference: json.reference ? String(json.reference) : undefined };
  if (statusCode === '02') return { state: 'expired', statusCode, reference: json.reference ? String(json.reference) : undefined };
  throw new DuitkuError(`Status Duitku tidak dikenal: ${statusCode || '(kosong)'}`);
}

// Signature callback: HMAC-SHA256(merchantCode + amount + merchantOrderId, apiKey).
// Perbandingan konstan-waktu dilakukan pemanggil (routes) via timingSafeEqual.
export function callbackSignature(cfg: DuitkuConfig, amount: string, merchantOrderId: string): string {
  return sign(cfg.merchantCode + amount + merchantOrderId, cfg.apiKey);
}
