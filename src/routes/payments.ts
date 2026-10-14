import { Hono } from 'hono';
import { fail, ok } from '../utils/response';
import { requireAuth } from '../middleware/auth';
import { toInt } from '../utils/validate';
import { readJson } from '../utils/body';
import { timingSafeEqual } from '../middleware/security';
import { PakasirError, createTransaction, getTransactionStatus } from '../services/pakasir';
import {
  createTransaction as createDuitkuTransaction,
  getTransactionStatus as getDuitkuTransactionStatus,
  callbackSignature,
  duitkuConfig,
  duitkuUsable,
  duitkuFeePct,
  grossUp,
  guardHost,
  isProdHost,
  DuitkuError,
  DUITKU_QRIS_EXPIRY_MINUTES,
} from '../services/duitku';
import { qrStringToSvg } from '../services/qr';
import {
  genReference,
  remainingSeconds,
  settlePayment,
  shouldCheckStatus,
  effectiveExpiryIso,
  PAKASIR_TTL_MS,
  type PaymentRow,
} from '../services/payments';
import { inviteeDiscountEligible, REFERRAL_INVITEE_DISCOUNT } from '../services/referrals';
import { getPaymentMode, getActiveGateway, type Gateway } from '../services/settings';
import type { AppEnv } from '../types';


const payments = new Hono<AppEnv>();

// Batas transaksi pending per user — tanpa ini, spam create menghabiskan
// kuota tulis D1 dan menumpuk baris payment tak berarti.
const MAX_PENDING_PAYMENTS = 5;

payments.post('/create', requireAuth, async (c) => {
  const user = c.get('user');
  const body = await readJson(c);
  const productId = toInt(body?.product_id, 0);

  const product = await c.env.DB.prepare(
    'SELECT id, name, price FROM products WHERE id=? AND active=1',
  )
    .bind(productId)
    .first<{ id: number; name: string; price: number }>();
  if (!product) return fail(c, 'Produk akses tidak ditemukan', 404);

  // Hanya pending yang masih dalam umur bayar (24 jam + 1 jam tenggang) —
  // transaksi lebih tua pasti sudah expired (rekonsiliasi cron/polling) atau
  // ditinggalkan (manual), sehingga tidak boleh memblokir transaksi baru selamanya.
  const pending = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM payments WHERE user_id=? AND status='pending' AND created_at > ?`,
  )
    .bind(user.id, new Date(Date.now() - PAKASIR_TTL_MS - 3600000).toISOString())
    .first<{ n: number }>();
  if ((pending?.n ?? 0) >= MAX_PENDING_PAYMENTS) {
    return fail(
      c,
      `Anda masih memiliki ${MAX_PENDING_PAYMENTS} transaksi pending. Selesaikan salah satunya atau tunggu transaksi lama kedaluwarsa (maks. 24 jam).`,
      429,
    );
  }

  // Amount SELALU dari database, bukan dari client. User yang terdaftar lewat
  // kode undangan berhak diskon pembelian pertama: amount di sini menjadi acuan
  // tunggal — dikirim ke gateway, disimpan di payments, dan diverifikasi callback
  // terhadapnya — sehingga diskon konsisten di semua jalur settlement.
  const discountEligible = await inviteeDiscountEligible(c.env.DB, user.id);
  const amount = discountEligible
    ? product.price - Math.round(product.price * REFERRAL_INVITEE_DISCOUNT)
    : product.price;

  // Mode pembayaran efektif dari toggle admin (fallback env — services/settings):
  // "manual" = dipaksa global (fallback bila gateway bermasalah), "hybrid" =
  // gateway + tombol manual, "gateway" = gateway saja.
  const mode = await getPaymentMode(c.env);
  const manualAllowed = mode !== 'gateway';
  if (body?.method === 'manual' && !manualAllowed) {
    return fail(c, 'Pembayaran manual sedang tidak tersedia. Silakan bayar via QRIS.', 400);
  }
  const manualMode = mode === 'manual' || body?.method === 'manual';
  let paymentId = 0;
  let reference = '';
  for (let i = 0; i < 3; i++) {
    reference = genReference();
    try {
      const res = await c.env.DB.prepare(
        'INSERT INTO payments (user_id, product_id, reference, amount, method) VALUES (?, ?, ?, ?, ?)',
      )
        .bind(user.id, product.id, reference, amount, manualMode ? 'manual' : 'qris')
        .run();
      paymentId = Number(res.meta.last_row_id);
      break;
    } catch (e) {
      if (!String(e).includes('UNIQUE')) throw e; // referensi bentuk -> coba lagi
    }
  }
  if (!paymentId) return fail(c, 'Gagal membuat referensi transaksi', 500);

  // Mode manual (fallback): tanpa transaksi gateway —
  // user bayar ke QRIS pribadi lalu konfirmasi via WA; admin menandai lunas.
  if (manualMode) {
    return ok(
      c,
      {
        payment: { id: paymentId, reference, amount, product_name: product.name },
        manual: {
          qr_url: '/img/qris.jpg',
          wa: c.env.MANUAL_WA || '',
        },
      },
      201,
    );
  }

  // Urutan gateway: gateway aktif (toggle admin) dulu, lalu gateway satunya
  // sebagai fallback otomatis saat create error. Kandidat harus terkonfigurasi;
  // Duitku sandbox tidak pernah dipakai di host produksi (duitkuUsable) —
  // uang user nyata mustahil lewat environment uji coba.
  const url = new URL(c.req.url);
  const host = guardHost(c.req.header('host') || url.host, c.req.header('x-forwarded-proto'));
  // Pembeli publik di ditryout.in mengikuti toggle admin. Hostname lain
  // (localhost saat dev, preview *.workers.dev) memaksa Duitku — URL preview
  // tidak dipublikasikan dan dipakai reviewer Duitku / pengujian internal
  // gateway alternatif; sandbox tetap terblokir di host produksi karena
  // duitkuUsable sudah menyaringnya.
  const active = isProdHost(host) ? await getActiveGateway(c.env) : 'duitku';
  const order: Gateway[] = active === 'duitku' ? ['duitku', 'pakasir'] : ['pakasir', 'duitku'];
  const candidates = order.filter((g) =>
    g === 'pakasir'
      ? !!(c.env.PAKASIR_API_KEY && c.env.PAKASIR_PROJECT)
      : duitkuUsable(c.env, host),
  );

  if (!candidates.length) {
    await c.env.DB.prepare(`UPDATE payments SET status='failed', updated_at=? WHERE id=?`)
      .bind(new Date().toISOString(), paymentId)
      .run();
    return fail(c, 'Payment gateway belum dikonfigurasi. Hubungi admin.', 502);
  }

  for (const g of candidates) {
    try {
      if (g === 'pakasir') {
        const txn = await createTransaction(c.env, reference, amount, 'qris');
        await c.env.DB.prepare(
          `UPDATE payments SET gateway='pakasir', txn_id=?, qr_string=?, total_payment=?, fee=?, expires_at=?, updated_at=? WHERE id=?`,
        )
          .bind(
            txn.txn_id,
            txn.qr_string ?? null,
            txn.total_payment ?? null,
            txn.fee ?? null,
            txn.expired_at ?? null,
            new Date().toISOString(),
            paymentId,
          )
          .run();
        return ok(
          c,
          {
            payment: { id: paymentId, reference, amount, product_name: product.name },
            gateway: 'pakasir',
            txn: {
              txn_id: txn.txn_id,
              total_payment: txn.total_payment ?? amount,
              fee: txn.fee ?? 0,
              expired_at: effectiveExpiryIso(txn.expired_at, new Date().toISOString()),
              is_sandbox: !!txn.is_sandbox,
            },
            qr_svg: txn.qr_string ? qrStringToSvg(txn.qr_string) : null,
            support_wa: c.env.MANUAL_WA || '',
          },
          201,
        );
      }

      // Fee QRIS Duitku (MDR) ditanggung merchant secara kontrak — pass-through
      // ke pembeli via gross-up: tagihan = harga + fee, dana masuk tetap = harga
      // (pola sama dengan fee/total_payment Pakasir; halaman bayar otomatis
      // menampilkan "termasuk biaya layanan"). payments.amount tetap harga dasar.
      const feePct = duitkuFeePct(c.env);
      const charge = grossUp(amount, feePct);
      const dt = await createDuitkuTransaction(c.env, {
        orderId: reference,
        amount: charge,
        productDetails: product.name,
        email: user.email,
        customerName: user.name,
        callbackUrl: `${url.origin}/api/payments/duitku/callback`,
        returnUrl: `${url.origin}/payment.html?payment=${paymentId}`,
      });
      // Duitku tidak mengirim expiry di respons — batas bayar ditentukan kita
      // (expiryPeriod saat create), simpan agar countdown & expiry lokal akurat.
      const expiresAt = new Date(Date.now() + DUITKU_QRIS_EXPIRY_MINUTES * 60_000).toISOString();
      await c.env.DB.prepare(
        `UPDATE payments SET gateway='duitku', txn_id=?, qr_string=?, total_payment=?, fee=?, expires_at=?, payment_url=?, updated_at=? WHERE id=?`,
      )
        .bind(dt.reference, dt.qr_string ?? null, charge, charge - amount, expiresAt, dt.payment_url ?? null, new Date().toISOString(), paymentId)
        .run();
      return ok(
        c,
        {
          payment: { id: paymentId, reference, amount, product_name: product.name },
          gateway: 'duitku',
          txn: {
            txn_id: dt.reference,
            total_payment: charge,
            fee: charge - amount,
            expired_at: expiresAt,
            is_sandbox: dt.is_sandbox,
            payment_url: dt.payment_url ?? null, // link halaman bayar (dipakai admin saat uji sandbox)
          },
          qr_svg: dt.qr_string ? qrStringToSvg(dt.qr_string) : null,
          support_wa: c.env.MANUAL_WA || '',
        },
        201,
      );
    } catch (e) {
      // Gateway bermasalah -> coba gateway berikutnya dengan reference yang sama
      // (aman: create Pakasir idempotent; inquiry Duitku gagal = invoice belum jadi,
      // kemungkinan invoice "yatim" bila timeout sesudah terbit akan kedaluwarsa
      // sendiri dalam 30 menit di sisi Duitku).
      console.error('[create:fallback]', g, reference, e);
    }
  }

  await c.env.DB.prepare(`UPDATE payments SET status='failed', updated_at=? WHERE id=?`)
    .bind(new Date().toISOString(), paymentId)
    .run();
  return fail(c, 'Gagal membuat transaksi pembayaran. Silakan coba lagi.', 502);
});

// Status pembayaran (+ polling ke gateway sebagai fallback jika callback belum/terlambat).
payments.get('/:id', requireAuth, async (c) => {
  const user = c.get('user');
  const id = toInt(c.req.param('id'), 0);

  const p = await c.env.DB.prepare(
    'SELECT pm.*, pr.name AS product_name FROM payments pm LEFT JOIN products pr ON pr.id=pm.product_id WHERE pm.id=?',
  )
    .bind(id)
    .first<
      PaymentRow & {
        product_name: string | null;
        qr_string: string | null;
        total_payment: number | null;
        fee: number | null;
        expires_at: string | null;
      }
    >();
  if (!p || (p.user_id !== user.id && user.role !== 'admin')) {
    return fail(c, 'Pembayaran tidak ditemukan', 404);
  }

  if (p.status === 'pending' && p.txn_id) {
    if (Date.parse(p.created_at) < Date.now() - PAKASIR_TTL_MS) {
      await c.env.DB.prepare(`UPDATE payments SET status='expired', updated_at=? WHERE id=? AND status='pending'`)
        .bind(new Date().toISOString(), p.id)
        .run();
      p.status = 'expired';
    } else if (p.gateway === 'duitku') {
      // QR Duitku mati permanen setelah expires_at — tandai kedaluwarsa secara
      // lokal (tanpa panggilan API; callback terlambat tetap bisa settle).
      if (p.expires_at && Date.now() > Date.parse(p.expires_at) + 60_000) {
        await c.env.DB.prepare(`UPDATE payments SET status='expired', updated_at=? WHERE id=? AND status='pending'`)
          .bind(new Date().toISOString(), p.id)
          .run();
        p.status = 'expired';
      } else if (shouldCheckStatus(p.id, 15_000)) {
        // Rate limit Duitku ketat (blokir ~1 jam bila terlalu rapat): 15 detik.
        try {
          const st = await getDuitkuTransactionStatus(c.env, p.reference);
          if (st.state === 'completed') {
            await settlePayment(c.env.DB, p);
            p.status = 'paid';
          } else if (st.state === 'expired') {
            await c.env.DB.prepare(`UPDATE payments SET status='expired', updated_at=? WHERE id=? AND status='pending'`)
              .bind(new Date().toISOString(), p.id)
              .run();
            p.status = 'expired';
          }
        } catch {
          // rate-limit / jaringan: kembalikan status saat ini, polling berikutnya mencoba lagi
        }
      }
    } else if (shouldCheckStatus(p.id)) {
      try {
        const txn = await getTransactionStatus(c.env, p.txn_id!);
        if (txn.status === 'completed') {
          await settlePayment(c.env.DB, p, txn.completed_at);
          p.status = 'paid';
        } else if (txn.status === 'canceled' || txn.status === 'expired' || txn.status === 'failed') {
          await c.env.DB.prepare(`UPDATE payments SET status='expired', updated_at=? WHERE id=? AND status='pending'`)
            .bind(new Date().toISOString(), p.id)
            .run();
          p.status = 'expired';
        }
      } catch {
        // rate-limit / jaringan: kembalikan status saat ini, polling berikutnya mencoba lagi
      }
    }
  }

  let accessExpiresAt: string | null = null;
  if (p.status === 'paid') {
    const u = await c.env.DB.prepare('SELECT access_expires_at FROM users WHERE id=?')
      .bind(p.user_id)
      .first<{ access_expires_at: string | null }>();
    accessExpiresAt = u?.access_expires_at ?? null;
  }

  // Batas bayar efektif untuk transaksi pending (gateway umumnya tidak mengirim
  // expired_at — fallback ke umur maksimal aplikasi 24 jam sejak dibuat).
  const expiryIso = effectiveExpiryIso(p.expires_at, p.created_at);

  return ok(c, {
    payment: {
      id: p.id,
      reference: p.reference,
      amount: p.amount,
      status: p.status,
      method: p.method,
      gateway: p.gateway,
      paid_at: p.paid_at,
      created_at: p.created_at,
      product_name: p.product_name ?? null,
    },
    ...(p.status === 'pending' && p.txn_id
      ? {
          gateway: p.gateway,
          txn: {
            txn_id: p.txn_id,
            total_payment: p.total_payment ?? p.amount,
            fee: p.fee ?? 0,
            // Gateway tidak selalu mengirim expired_at (Pakasir: tidak pernah) —
            // batas bayar efektif = yang lebih awal antara expiry gateway dan umur
            // maksimal transaksi di sisi aplikasi (24 jam sejak dibuat).
            expired_at: expiryIso,
            expired_in_seconds: remainingSeconds(expiryIso),
            is_sandbox: p.gateway === 'duitku' ? c.env.DUITKU_SANDBOX === 'true' : false,
            // Halaman bayar Duitku — di sandbox ini halaman simulator (satu-
            // satunya cara menyelesaikan pembayaran uji; QR sandbox tak bisa
            // discan aplikasi nyata), di produksi alternatif bayar via app.
            payment_url: p.payment_url ?? null,
          },
          qr_svg: p.qr_string ? qrStringToSvg(p.qr_string) : null,
        }
      : {}),
    // Pembayaran manual: pending tanpa txn gateway, tidak pernah auto-expire
    // (uang bisa sudah masuk — admin tetap bisa menandai lunas kapan saja).
    ...(p.method === 'manual' && p.status === 'pending'
      ? { manual: { qr_url: '/img/qris.jpg', wa: c.env.MANUAL_WA || '' } }
      : {}),
    access_expires_at: accessExpiresAt,
    support_wa: c.env.MANUAL_WA || '',
  });
});

// Webhook Pakasir: POST dengan header X-Secret. Idempotent + double-check ke API status.
payments.post('/webhook', async (c) => {
  const secret = c.env.PAKASIR_WEBHOOK_SECRET;
  if (!secret) return fail(c, 'Webhook secret belum dikonfigurasi', 503);

  const xSecret = c.req.header('x-secret') ?? '';
  if (!timingSafeEqual(xSecret, secret)) return fail(c, 'Secret tidak valid', 403);

  const body = await readJson(c);
  if (!body) return fail(c, 'Body tidak valid', 400);

  const orderId = typeof body.order_id === 'string' ? body.order_id : '';
  const txnId = typeof body.txn_id === 'string' ? body.txn_id : '';
  const amount = toInt(body.amount, -1);
  const status = typeof body.status === 'string' ? body.status : '';

  if (status !== 'completed') return ok(c, { ignored: true, reason: `status=${status}` });

  const p = await c.env.DB.prepare('SELECT * FROM payments WHERE reference=?')
    .bind(orderId)
    .first<PaymentRow>();
  if (!p) return fail(c, 'Referensi transaksi tidak dikenal', 404);

  // Ikat webhook pada transaksi yang benar-benar kita buat + amount harus cocok.
  if (!p.txn_id || p.txn_id !== txnId) return fail(c, 'txn_id tidak cocok', 400);
  if (p.amount !== amount) return fail(c, 'Amount tidak cocok', 400);
  if (p.status === 'paid') return ok(c, { ok: true, already_paid: true });

  // Double-check ke API status Pakasir (jika API key tersedia).
  if (c.env.PAKASIR_API_KEY) {
    let txn;
    try {
      txn = await getTransactionStatus(c.env, p.txn_id);
    } catch (e) {
      return fail(c, `Gagal verifikasi ke Pakasir: ${e instanceof Error ? e.message : 'error'}`, 502);
    }
    if (txn.status !== 'completed' || toInt(txn.amount, -1) !== p.amount) {
      return fail(c, 'Verifikasi status transaksi gagal', 400);
    }
  }

  const completedAt = typeof body.completed_at === 'string' ? body.completed_at : undefined;
  await settlePayment(c.env.DB, p, completedAt);
  return ok(c, { ok: true });
});

// Callback Duitku: POST x-www-form-urlencoded (docs.duitku.com — callback).
// Verifikasi: signature HMAC-SHA256 konstan-waktu + binding reference gateway
// + amount, lalu double-check ke API status (pola sama dengan webhook Pakasir).
// Balas 200 untuk diterima/duplikat/abaikan; selain itu Duitku retry maks 5x.
payments.post('/duitku/callback', async (c) => {
  const cfg = duitkuConfig(c.env);
  if (!cfg) return fail(c, 'Duitku belum dikonfigurasi', 503);

  const form = await c.req.parseBody();
  const merchantCode = String(form.merchantCode ?? '');
  const amount = String(form.amount ?? '');
  const merchantOrderId = String(form.merchantOrderId ?? '');
  const reference = String(form.reference ?? '');
  const resultCode = String(form.resultCode ?? '');
  const signature = String(form.signature ?? '');

  if (merchantCode !== cfg.merchantCode) return fail(c, 'merchantCode tidak valid', 403);
  // Signature: HMAC(merchantCode + amount + merchantOrderId, apiKey) — hex lowercase.
  if (!timingSafeEqual(signature.toLowerCase(), callbackSignature(cfg, amount, merchantOrderId))) {
    return fail(c, 'Signature tidak valid', 403);
  }

  const p = await c.env.DB.prepare('SELECT * FROM payments WHERE reference=?')
    .bind(merchantOrderId)
    .first<PaymentRow & { total_payment: number | null }>();
  if (!p) return fail(c, 'Referensi transaksi tidak dikenal', 404);

  // Ikat callback pada invoice Duitku yang benar-benar kita buat (reference
  // gateway tersimpan di txn_id saat create).
  if (p.gateway !== 'duitku' || !p.txn_id || p.txn_id !== reference) {
    return fail(c, 'Transaksi tidak cocok', 400);
  }

  if (resultCode === '01') {
    // Dibatalkan/gagal di sisi Duitku — pending ditandai expired (idempoten;
    // bila ternyata sudah lunas, biarkan: tidak menimpa status paid).
    await c.env.DB.prepare(`UPDATE payments SET status='expired', updated_at=? WHERE id=? AND status='pending'`)
      .bind(new Date().toISOString(), p.id)
      .run();
    return ok(c, { ok: true, failed: true });
  }
  if (resultCode !== '00') return ok(c, { ignored: true, reason: `resultCode=${resultCode}` });

  // Nominal yang dibayar pembeli = total tagihan (harga + fee pass-through,
  // gross-up) — BUKAN amount dasar (harga produk). total_payment row lama
  // (pra-markup) memang = amount, jadi fallback ?? tetap konsisten.
  const charge = p.total_payment ?? p.amount;
  if (toInt(amount, -1) !== charge) return fail(c, 'Amount tidak cocok', 400);
  if (p.status === 'paid') return ok(c, { ok: true, already_paid: true });

  // Double-check ke API status Duitku (jaringan bermasalah -> 502 agar Duitku
  // me-retry callback ini nanti; hasil tidak cocok -> 400, jangan diulang).
  let st;
  try {
    st = await getDuitkuTransactionStatus(c.env, p.reference);
  } catch (e) {
    const msg = e instanceof DuitkuError ? e.message : 'error';
    return fail(c, `Gagal verifikasi ke Duitku: ${msg}`, 502);
  }
  if (st.state !== 'completed' || (st.amount !== undefined && st.amount !== charge)) {
    return fail(c, 'Verifikasi status transaksi gagal', 400);
  }

  await settlePayment(c.env.DB, p);
  return ok(c, { ok: true });
});

export default payments;
