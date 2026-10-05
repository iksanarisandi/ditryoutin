import { Hono } from 'hono';
import { fail, ok } from '../../utils/response';
import { readJson } from '../../utils/body';
import { getPaymentMode, setPaymentMode, parsePaymentMode } from '../../services/settings';
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
  if (!mode) return fail(c, 'Mode tidak valid — pakai: pakasir | hybrid | manual', 422);
  await setPaymentMode(c.env, mode);
  return ok(c, { ok: true, mode });
});

export default settings;
