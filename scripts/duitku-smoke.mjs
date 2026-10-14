// Smoke test Duitku Payment Gateway (V.2 API) — tentukan skema signature yang
// diterima (HMAC-SHA256 vs MD5 warisan) SEBELUM wiring kode Worker, dan ulangi
// saat switch sandbox -> produksi (skema bisa berbeda antar environment!).
//
// Pemakaian:
//   DUITKU_MERCHANT_CODE=DSxxxxx DUITKU_API_KEY=xxxx node scripts/duitku-smoke.mjs          # sandbox
//   DUITKU_MERCHANT_CODE=Dxxxxx DUITKU_API_KEY=xxxx node scripts/duitku-smoke.mjs --prod    # produksi
//   --method=NQ (opsional) — channel yang diuji; default SP,NQ urut fallback produksi
//
// Kredensial HANYA dari environment — jangan pernah hardcode di file ini.
// Output: statusCode inquiry, skema signature yang lolos, hadirnya qrString,
// penerimaan merchantOrderId bersambung minus (format TO-... ala genReference()),
// daftar metode QRIS bila kode 'SP' ditolak, dan uji transactionStatus.

import { createHash } from 'node:crypto';

const prod = process.argv.includes('--prod');
const BASE = prod ? 'https://passport.duitku.com' : 'https://sandbox.duitku.com';
const merchantCode = process.env.DUITKU_MERCHANT_CODE;
const apiKey = process.env.DUITKU_API_KEY;

if (!merchantCode || !apiKey) {
  console.error('Set DUITKU_MERCHANT_CODE dan DUITKU_API_KEY dulu (lihat header file).');
  process.exit(1);
}

// ---------- signature: dua kandidat skema ----------

function md5Hex(s) {
  return createHash('md5').update(s, 'utf8').digest('hex');
}

async function hmacSha256Hex(key, msg) {
  const enc = new TextEncoder();
  const keyData = await crypto.subtle.importKey(
    'raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', keyData, enc.encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Docs terbaru: HMAC_SHA256(stringToSign, apiKey) — apiKey sebagai HMAC key.
const signHmac = (parts) => hmacSha256Hex(apiKey, parts.join(''));
// Skema warisan: MD5(concat(parts) + apiKey) — apiKey diappend di akhir.
const signMd5 = (parts) => md5Hex(parts.join('') + apiKey);

// ---------- endpoint ----------

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* biarkan null */ }
  return { httpStatus: res.status, json, text: text.slice(0, 500) };
}

async function tryInquiry(scheme, orderId, paymentMethod) {
  const signature = await scheme([merchantCode, orderId, '10000']);
  const r = await post('/webapi/api/merchant/v2/inquiry', {
    merchantCode,
    paymentAmount: 10000,
    merchantOrderId: orderId,
    productDetails: 'Smoke test signature Duitku',
    paymentMethod,
    customerVaName: 'Smoke Test',
    email: 'smoke@example.com',
    callbackUrl: 'https://example.com/callback',
    returnUrl: 'https://example.com/return',
    expiryPeriod: 10,
    signature,
  });
  return r;
}

// ---------- 1) inquiry: uji kedua skema + merchantOrderId minus ----------

// Format sama persis dengan genReference() di src/services/payments.ts
// (minus dipertahankan — bila ditolak, fallback kode: strip '-' saat kirim).
function genReferenceLike() {
  const rand = crypto.getRandomValues(new Uint8Array(4));
  const suffix = [...rand].map((b) => b.toString(36).padStart(2, '0')).join('').slice(0, 6).toUpperCase();
  return `TO-${Date.now().toString(36).toUpperCase()}-${suffix}`;
}

// Channel yang diuji: --method=NQ (atau daftar --method=NQ,SP). Default keduanya
// — sama dengan DUITKU_QRIS_METHOD produksi; tiap channel dicoba sampai ada yang
// lolos (urutan fallback sama dengan createTransaction di services/duitku).
const methodArg = process.argv.find((a) => a.startsWith('--method='));
const methods = (methodArg ? methodArg.slice(9) : 'SQ,NQ,SP').split(',').map((m) => m.trim().toUpperCase()).filter(Boolean);

let winner = null;
for (const method of methods) {
  for (const [name, scheme] of [['hmac-sha256', signHmac], ['md5', signMd5]]) {
    const orderId = genReferenceLike();
    const r = await tryInquiry(scheme, orderId, method);
    const sc = r.json?.statusCode ?? '(no json)';
    const msg = r.json?.statusMessage ?? r.text;
    console.log(`[inquiry:${method}:${name}] order=${orderId} http=${r.httpStatus} statusCode=${sc} statusMessage=${msg}`);
    if (r.json?.statusCode === '00') {
      console.log(`  >> LOLOS channel ${method} dengan ${name}`);
      console.log(`  >> reference=${r.json.reference ?? '-'} qrString=${r.json.qrString ? 'ADA (' + r.json.qrString.slice(0, 40) + '...)' : 'TIDAK ADA'} paymentUrl=${r.json.paymentUrl ?? '-'}`);
      winner = { name, scheme, orderId, ref: r.json.reference };
      break;
    }
  }
  if (winner) break;
}

if (!winner) {
  console.log('\nKedua skema gagal — kemungkinan kredensial/channel. Cek statusMessage di atas.');
}

// ---------- 2) getpaymentmethod: daftar metode + kode QRIS yang tersedia ----------

{
  const datetime = new Date().toISOString().replace('T', ' ').slice(0, 19);
  for (const [name, mk] of [
    ['hmac', () => signHmac([merchantCode, '10000', datetime])],
    ['sha256-plain', async () => toHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(merchantCode + '10000' + datetime + apiKey)))],
    ['md5', () => signMd5([merchantCode, '10000', datetime])],
  ]) {
    const r = await post('/webapi/api/merchant/paymentmethod/getpaymentmethod', {
      merchantcode: merchantCode,
      amount: '10000',
      datetime,
      signature: await mk(),
    });
    if (r.json?.responseCode === '00') {
      console.log(`\n[getpaymentmethod:${name}] OK — metode tersedia:`);
      for (const m of r.json.paymentFee ?? []) console.log(`  ${m.paymentMethod.padEnd(4)} ${m.paymentName} (fee ${m.totalFee})`);
      break;
    } else {
      console.log(`[getpaymentmethod:${name}] gagal: ${r.json?.responseMessage ?? r.text}`);
    }
  }
}

function toHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------- 3) transactionStatus dengan skema pemenang ----------

if (winner) {
  const signature = await winner.scheme([merchantCode, winner.orderId]);
  const r = await post('/webapi/api/merchant/transactionStatus', {
    merchantCode,
    merchantOrderId: winner.orderId,
    signature,
  });
  console.log(`\n[transactionStatus] http=${r.httpStatus} statusCode=${r.json?.statusCode ?? '-'} statusMessage=${r.json?.statusMessage ?? r.text}`);
  console.log(`\nKESIMPULAN: set DUITKU_SIGNATURE_SCHEME=${winner.name === 'hmac-sha256' ? 'hmac' : 'md5'}`);
}
