import { describe, expect, test } from 'bun:test';
import type { APIRoute } from 'astro';
import { GET } from '../src/pages/api/v1/lab200';
import type { D1DatabaseLike } from '../src/db/store';
import { createTestD1 } from './helpers/d1';

function call(db: D1DatabaseLike | undefined): Promise<Response> {
  const request = new Request('https://zuey.me/api/v1/lab200');
  const ctx = { request, params: {}, url: new URL(request.url), locals: { runtime: { env: { DB: db } } } };
  // The handler only reads locals; a full APIContext is not constructible in tests.
  return Promise.resolve(GET(ctx as unknown as Parameters<APIRoute>[0]));
}

const COURSE = { slug: 'ai-agent', title: 'AI Agent', summary: 'Build agents', lessons: 12, status: 'open', free: false, image: 'https://200lab.io/a.png' };

describe('GET /api/v1/lab200', () => {
  test('returns the stored snapshot in the success envelope, cacheable for a minute', async () => {
    const d1 = createTestD1();
    // A future checked_at keeps the snapshot fresh, so no refresh (network) is attempted.
    d1.raw.query('UPDATE lab200_snapshot SET courses_json = ?, synced_at = ?, checked_at = ? WHERE id = 1')
      .run(JSON.stringify([COURSE]), '2026-10-20T00:00:00.000Z', '2999-01-01T00:00:00.000Z');
    const res = await call(d1);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=60');
    expect(await res.json()).toEqual({ success: true, data: { courses: [COURSE], synced_at: '2026-10-20T00:00:00.000Z' } });
  });

  test('a database error is a 500 error envelope that is not publicly cached', async () => {
    const broken: D1DatabaseLike = { ...createTestD1(), prepare: () => { throw new Error('D1 unavailable'); } };
    const res = await call(broken);
    expect(res.status).toBe(500);
    expect(res.headers.get('Cache-Control') ?? '').not.toContain('public');
    const body = await res.json();
    expect(body).toEqual({ success: false, error: { code: 'internal_error', message: 'Internal server error' } });
  });
});
