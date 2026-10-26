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

const COURSE = {
  slug: 'ai-agent',
  url: 'https://200lab.io/courses/ai-agent',
  jsonUrl: 'https://200lab.io/courses/ai-agent.json',
  title: 'AI Agent',
  subtitle: '',
  summary: 'Build agents',
  cover: { url: 'https://assets.200lab.io/a', variants: [] },
  publishedAt: null,
  pricing: { state: 'available', prices: [{ minorUnits: 199000, currency: 'VND', compareAtMinorUnits: null }] },
  category: null,
  lessonCount: 12,
  readingMinutes: null,
};

const PATH = {
  slug: 'agent-path',
  url: 'https://200lab.io/learning-paths/agent-path',
  jsonUrl: 'https://200lab.io/learning-paths/agent-path.json',
  title: 'Agent path',
  subtitle: '',
  summary: 'Five courses',
  cover: null,
  publishedAt: '2026-10-13T15:52:03.112Z',
  pricing: { state: 'unavailable', prices: [] },
  courseCount: 5,
};

describe('GET /api/v1/lab200', () => {
  test('returns both stored catalogs in the success envelope, cacheable for a minute', async () => {
    const d1 = createTestD1();
    // A future checked_at keeps each feed fresh, so no refresh (network) is attempted.
    d1.raw.query('UPDATE lab200_catalog SET items_json = ?, locale = ?, synced_at = ?, checked_at = ? WHERE kind = ?')
      .run(JSON.stringify([COURSE]), 'vi', '2026-10-20T00:00:00.000Z', '2999-01-01T00:00:00.000Z', 'courses');
    d1.raw.query('UPDATE lab200_catalog SET items_json = ?, locale = ?, synced_at = ?, checked_at = ? WHERE kind = ?')
      .run(JSON.stringify([PATH]), 'vi', '2026-10-21T00:00:00.000Z', '2999-01-01T00:00:00.000Z', 'learning_paths');
    const res = await call(d1);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=60');
    expect(await res.json()).toEqual({
      success: true,
      data: {
        courses: [COURSE],
        synced_at: '2026-10-20T00:00:00.000Z',
        courses_locale: 'vi',
        learning_paths: [PATH],
        learning_paths_synced_at: '2026-10-21T00:00:00.000Z',
        learning_paths_locale: 'vi',
      },
    });
  });

  test('before migration 0030 the endpoint answers with empty lists, not a 500', async () => {
    const d1 = createTestD1();
    d1.raw.run('DROP TABLE lab200_catalog');
    const res = await call(d1);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toMatchObject({ courses: [], learning_paths: [], synced_at: null, learning_paths_synced_at: null });
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
