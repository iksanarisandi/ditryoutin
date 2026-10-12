import { Hono } from 'hono';
import { fail, ok } from '../../utils/response';
import { readJson } from '../../utils/body';
import { getPaymentMode, setPaymentMode, parsePaymentMode, getActiveGateway, setActiveGateway, parseGateway } from '../../services/settings';
import { isDuitkuConfigured } from '../../services/duitku';
import type { AppEnv } from '../../types';

// Pengaturan runtime panel admin. Seluruh grup sudah dibungkus requireAdmin
// lewat mount di index.ts (app.route('/api/admin', admin)).
const settings = new Hono<AppEnv>();

// Mode pembayaran aktif + baseline env-nya (dipakai UI untuk menandai asal nilai).
// Catatan propagasi: /api/products di-cache edge 60 detik, sehingga halaman
// bayar mengikuti mode baru maks. 1 menit; POST /payments/create langsung.
settings.get('/payment-mode', async (c) => {
  return ok(c, { mode: await getPaymentMode(c.env) });
});

settings.post('/payment-mode', async (c) => {
  const body = await readJson(c);
  const mode = parsePaymentMode(body?.mode);
  if (!mode) return fail(c, 'Mode tidak valid — pakai: gateway | hybrid | manual', 422);
  await setPaymentMode(c.env, mode);
  return ok(c, { ok: true, mode });
});

// Gateway aktif untuk transaksi QRIS baru + status konfigurasi tiap gateway
// (dipakai UI: disable pilihan belum dikonfigurasi, peringatan sandbox).
settings.get('/active-gateway', async (c) => {
  return ok(c, {
    gateway: await getActiveGateway(c.env),
    pakasir_configured: !!(c.env.PAKASIR_API_KEY && c.env.PAKASIR_PROJECT),
    duitku_configured: isDuitkuConfigured(c.env),
    duitku_sandbox: c.env.DUITKU_SANDBOX === 'true',
  });
});

settings.post('/active-gateway', async (c) => {
  const body = await readJson(c);
  const gateway = parseGateway(body?.gateway);
  if (!gateway) return fail(c, 'Gateway tidak valid — pakai: pakasir | duitku', 422);
  if (gateway === 'duitku' && !isDuitkuConfigured(c.env)) {
    return fail(c, 'Duitku belum dikonfigurasi (DUITKU_MERCHANT_CODE / DUITKU_API_KEY)', 422);
  }
  if (gateway === 'pakasir' && !(c.env.PAKASIR_API_KEY && c.env.PAKASIR_PROJECT)) {
    return fail(c, 'Pakasir belum dikonfigurasi (PAKASIR_API_KEY / PAKASIR_PROJECT)', 422);
  }
  await setActiveGateway(c.env, gateway);
  return ok(c, { ok: true, gateway });
});

export default settings;
