// Durable Object rate limiter — pengganti binding "ratelimit" Cloudflare yang
// ternyata tidak enforce pada akun ini (selalu success=true). DO bekerja di
// semua plan, strongly-consistent per key, dan satu instance per key berarti
// bebas race condition (request diproses berurutan).

type Window = { start: number; count: number };

export class RateLimiter implements DurableObject {
  constructor(
    private state: DurableObjectState,
    _env: unknown,
  ) {}

  // Fixed window: POST { limit, period } -> { success }
  async fetch(req: Request): Promise<Response> {
    let cfg: { limit: number; period: number };
    try {
      cfg = (await req.json()) as { limit: number; period: number };
    } catch {
      return Response.json({ success: true }); // body rusak -> jangan blokir
    }
    if (!Number.isFinite(cfg.limit) || !Number.isFinite(cfg.period) || cfg.limit < 1 || cfg.period < 1) {
      return Response.json({ success: true });
    }

    const now = Date.now();
    const w = (await this.state.storage.get<Window>('w')) ?? { start: now, count: 0 };
    let success: boolean;
    if (now - w.start >= cfg.period * 1000) {
      // window baru
      await this.state.storage.put('w', { start: now, count: 1 });
      success = true;
    } else {
      w.count += 1;
      await this.state.storage.put('w', w);
      success = w.count <= cfg.limit;
    }
    return Response.json({ success });
  }
}
