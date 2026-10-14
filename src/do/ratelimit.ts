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
    const periodMs = cfg.period * 1000;
    const stored = await this.state.storage.get<Window>('w');

    if (!stored || now - stored.start >= periodMs) {
      // Window baru (atau pertama kali): mulai hitung dan pasang alarm di akhir
      // window agar storage DO dibersihkan sendiri (lihat alarm()). Tanpa ini,
      // tiap key unik (ip:*, email:*) meninggalkan satu baris storage selamanya.
      await this.state.storage.put('w', { start: now, count: 1 });
      await this.state.storage.setAlarm(now + periodMs);
      return Response.json({ success: true });
    }
    const count = stored.count + 1;
    await this.state.storage.put('w', { start: stored.start, count });
    return Response.json({ success: count <= cfg.limit });
  }

  // Window berakhir -> buang seluruh state DO. Instance menjadi "kosong" dan
  // tidak lagi menyimpan apa pun, sehingga jumlah key tak terbatas (IP/email
  // yang dikendalikan penyerang) tidak menumpuk storage selamanya. Hit baru
  // setelah ini otomatis membuka window + alarm baru.
  async alarm(): Promise<void> {
    await this.state.storage.deleteAll();
  }
}
