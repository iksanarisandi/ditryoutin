import qrcode from 'qrcode-generator';
import type { Env } from '../types';

const BASE_URL = 'https://app.pakasir.com';

export class PakasirError extends Error {}

export type PakasirTxn = {
  txn_id: string;
  order_id?: string;
  amount?: number;
  fee?: number;
  total_payment?: number;
  payment_method?: string;
  qr_string?: string;
  va_number?: string;
  payment_link?: string;
  expired_at?: string;
  is_sandbox?: boolean;
  status?: string;
  completed_at?: string;
};

function requireConfig(env: Env): { apiKey: string; slug: string } {
  if (!env.PAKASIR_API_KEY || !env.PAKASIR_PROJECT) {
    throw new PakasirError('Payment gateway belum dikonfigurasi. Hubungi admin.');
  }
  return { apiKey: env.PAKASIR_API_KEY, slug: env.PAKASIR_PROJECT };
}

function extract(json: unknown): PakasirTxn {
  const rec = json as Record<string, unknown> | null;
  const p = (rec?.payment ?? rec) as Record<string, unknown> | null;
  if (!p || typeof p !== 'object' || typeof p.txn_id !== 'string') {
    throw new PakasirError('Respon Pakasir tidak valid');
  }
  return p as unknown as PakasirTxn;
}

async function pakasirFetch(url: string, init: RequestInit): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new PakasirError('Tidak dapat menghubungi server Pakasir');
  }
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const msg =
      (json as Record<string, unknown> | null)?.message ??
      (json as Record<string, unknown> | null)?.error ??
      `Pakasir merespon ${res.status}`;
    throw new PakasirError(String(msg));
  }
  return json;
}

// POST /api/v2/create-transaction/{slug}/{order_id} — idempotent (find-or-create).
export async function createTransaction(
  env: Env,
  orderId: string,
  amount: number,
  method: string = 'qris',
): Promise<PakasirTxn> {
  const { apiKey, slug } = requireConfig(env);
  const json = await pakasirFetch(
    `${BASE_URL}/api/v2/create-transaction/${encodeURIComponent(slug)}/${encodeURIComponent(orderId)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
      body: JSON.stringify({ method, amount }),
    },
  );
  return extract(json);
}

// GET /api/v2/transaction-status/{slug}/{txn_id} — rate limit Pakasir: 1x/4 detik per transaksi.
export async function getTransactionStatus(env: Env, txnId: string): Promise<PakasirTxn> {
  const { apiKey, slug } = requireConfig(env);
  const json = await pakasirFetch(
    `${BASE_URL}/api/v2/transaction-status/${encodeURIComponent(slug)}/${encodeURIComponent(txnId)}`,
    { method: 'GET', headers: { 'X-Api-Key': apiKey } },
  );
  return extract(json);
}

// Render QR string menjadi SVG (server-side, tanpa library frontend).
export function qrStringToSvg(text: string): string {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const size = qr.getModuleCount();
  let path = '';
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (qr.isDark(y, x)) path += `M${x} ${y}h1v1h-1z`;
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="Kode QR pembayaran">` +
    `<rect width="${size}" height="${size}" fill="#ffffff"/><path d="${path}" fill="#000000"/></svg>`
  );
}
