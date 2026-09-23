import { Hono } from 'hono';
import { fail, ok } from '../utils/response';
import { requireAuth } from '../middleware/auth';
import { toInt } from '../utils/validate';
import { readJson } from '../utils/body';
import { timingSafeEqual } from '../middleware/security';
import { PakasirError, createTransaction, getTransactionStatus, qrStringToSvg } from '../services/pakasir';
import { genReference, remainingSeconds, settlePayment, shouldCheckStatus, PAKASIR_TTL_MS, type PaymentRow } from '../services/payments';
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

  const pending = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM payments WHERE user_id=? AND status='pending'`,
  )
    .bind(user.id)
    .first<{ n: number }>();
  if ((pending?.n ?? 0) >= MAX_PENDING_PAYMENTS) {
    return fail(
      c,
      `Anda masih memiliki ${MAX_PENDING_PAYMENTS} transaksi pending. Selesaikan atau hubungi admin sebelum membuat yang baru.`,
      429,
    );
  }

  // Amount SELALU dari database, bukan dari client.
  const manualMode = c.env.PAYMENT_MODE === 'manual';
  let paymentId = 0;
  let reference = '';
  for (let i = 0; i < 3; i++) {
    reference = genReference();
    try {
      const res = await c.env.DB.prepare(
        'INSERT INTO payments (user_id, product_id, reference, amount, method) VALUES (?, ?, ?, ?, ?)',
      )
        .bind(user.id, product.id, reference, product.price, manualMode ? 'manual' : 'qris')
        .run();
      paymentId = Number(res.meta.last_row_id);
      break;
    } catch (e) {
      if (!String(e).includes('UNIQUE')) throw e; // referensi bentuk -> coba lagi
    }
  }
  if (!paymentId) return fail(c, 'Gagal membuat referensi transaksi', 500);

  // Mode manual (transisi selama Pakasir sandbox): tanpa transaksi gateway —
  // user bayar ke QRIS pribadi lalu konfirmasi via WA; admin menandai lunas.
  if (manualMode) {
    return ok(
      c,
      {
        payment: { id: paymentId, reference, amount: product.price, product_name: product.name },
        manual: {
          qr_url: '/img/qris.jpg',
          wa: c.env.MANUAL_WA || '',
        },
      },
      201,
    );
  }

  let txn;
  try {
    txn = await createTransaction(c.env, reference, product.price, 'qris');
  } catch (e) {
    await c.env.DB.prepare(`UPDATE payments SET status='failed', updated_at=? WHERE id=?`)
      .bind(new Date().toISOString(), paymentId)
      .run();
    return fail(c, e instanceof PakasirError ? e.message : 'Gagal membuat transaksi pembayaran', 502);
  }

  await c.env.DB.prepare(
    `UPDATE payments SET txn_id=?, qr_string=?, total_payment=?, fee=?, expires_at=?, updated_at=? WHERE id=?`,
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
      payment: { id: paymentId, reference, amount: product.price, product_name: product.name },
      txn: {
        txn_id: txn.txn_id,
        total_payment: txn.total_payment ?? product.price,
        fee: txn.fee ?? 0,
        expired_at: txn.expired_at ?? null,
        is_sandbox: !!txn.is_sandbox,
      },
      qr_svg: txn.qr_string ? qrStringToSvg(txn.qr_string) : null,
    },
    201,
  );
});

// Status pembayaran (+ polling ke Pakasir sebagai fallback jika webhook belum/terlambat).
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
    } else if (shouldCheckStatus(p.id)) {
      try {
        const txn = await getTransactionStatus(c.env, p.txn_id);
        if (txn.status === 'completed') {
          await settlePayment(c.env.DB, p, txn.completed_at);
          p.status = 'paid';
        } else if (txn.status === 'canceled') {
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

  return ok(c, {
    payment: {
      id: p.id,
      reference: p.reference,
      amount: p.amount,
      status: p.status,
      method: p.method,
      paid_at: p.paid_at,
      created_at: p.created_at,
      product_name: p.product_name ?? null,
    },
    ...(p.status === 'pending' && p.txn_id
      ? {
          txn: {
            txn_id: p.txn_id,
            total_payment: p.total_payment ?? p.amount,
            fee: p.fee ?? 0,
            expired_at: p.expires_at,
            expired_in_seconds: p.expires_at ? remainingSeconds(p.expires_at) : null,
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

export default payments;
