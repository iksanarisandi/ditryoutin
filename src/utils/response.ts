import type { Context } from 'hono';

type FailStatus = 400 | 401 | 403 | 404 | 405 | 409 | 410 | 413 | 422 | 429 | 500 | 502 | 503;

export function ok<T>(c: Context, data: T, status: 200 | 201 = 200) {
  return c.json({ success: true, data }, status);
}

export function fail(c: Context, error: string, status: FailStatus = 400) {
  return c.json({ success: false, error }, status);
}
