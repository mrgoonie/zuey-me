import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import type { APIContext } from 'astro';
import { createTestD1 } from './helpers/d1';
import {
  formatVnd, lab200AssetUrl, lab200Link, lab200PriceView, parseLab200Course, parseLab200Feed, parseLab200Items,
  parseLab200LearningPath, parseLab200Pricing, sanitizeText, splitFeatured, LAB200_FEEDS,
} from '../src/lib/lab200/catalog';
import { renderLab200Markdown } from '../src/lib/lab200/markdown';
import { getLab200Catalog, LAB200_MAX_FEED_BYTES, LAB200_STALE_MS, refreshLab200Feed } from '../src/lib/lab200/store';
import { parseLab200Catalog } from '../src/components/lab200/lab200-api-client';
import { GET as getLab200Md } from '../src/pages/200lab.md';

const FIXTURES = path.join(import.meta.dir, 'fixtures', 'lab200');
const COURSES_JSON = fs.readFileSync(path.join(FIXTURES, 'courses.json'), 'utf8');
const PATHS_JSON = fs.readFileSync(path.join(FIXTURES, 'learning-paths.json'), 'utf8');
const COURSES: unknown = JSON.parse(COURSES_JSON);
const PATHS: unknown = JSON.parse(PATHS_JSON);

const HARNESS = 'agent-harness-foundations';
const FREE = 'lam-chu-tu-duy-trong-thoi-dai-ai-tu-duy-he-thong-cach-giao-viec-va-quan-ly-agent';
const UNAVAILABLE = 'thiet-ke-api-giua-cac-service-error-model-versioning-va-contract-test';

/** A valid course item to mutate in a test. */
function course(over: Record<string, unknown> = {}): Record<string, unknown> {
  const slug = typeof over.slug === 'string' ? over.slug : 'demo-course';
  return {
    slug,
    url: `https://200lab.io/courses/${slug}`,
    jsonUrl: `https://200lab.io/courses/${slug}.json`,
    title: 'Demo',
    subtitle: 'Sub',
    summary: 'Sum',
    cover: { url: 'https://assets.200lab.io/sha256/aa/x', variants: [{ width: 640, url: 'https://assets.200lab.io/cdn-cgi/image/width=640/x' }] },
    category: { slug: 'ai', name: 'AI' },
    publishedAt: '2026-10-01T00:00:00Z',
    lessonCount: 10,
    readingMinutes: 100,
    pricing: { state: 'available', prices: [{ minorUnits: 99000, currency: 'VND', compareAtMinorUnits: 199000 }] },
    ...over,
  };
}

type Answer = { status: number; body: string; headers?: Record<string, string> } | 'timeout';

/** Answers for each feed URL in order (default 500); every requested URL is recorded. */
function fakeFetch(answers: { courses?: Answer[]; learningPaths?: Answer[] }) {
  const calls: string[] = [];
  const queues = { [LAB200_FEEDS.courses.url]: [...(answers.courses ?? [])], [LAB200_FEEDS.learningPaths.url]: [...(answers.learningPaths ?? [])] };
  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    calls.push(input);
    expect(init?.redirect).toBe('manual');
    const next = queues[input]?.shift() ?? { status: 500, body: '' };
    if (next === 'timeout') throw new DOMException('The operation timed out.', 'TimeoutError');
    return new Response(next.body, { status: next.status, headers: next.headers });
  };
  return { fetchImpl, calls };
}

const ok = (body: string): Answer => ({ status: 200, body });

describe('200lab catalog feeds', () => {
  test('validates the saved courses.json fixture', () => {
    const feed = parseLab200Feed('courses', COURSES);
    if (!feed.ok) throw new Error(feed.reason);
    expect(feed.locale).toBe('vi');
    expect(feed.items).toHaveLength(6);
    const harness = feed.items.find(c => c.slug === HARNESS);
    expect(harness).toMatchObject({
      url: `https://200lab.io/courses/${HARNESS}`,
      jsonUrl: `https://200lab.io/courses/${HARNESS}.json`,
      title: 'Agent Harness Foundations',
      category: { slug: 'harness', name: 'Harness' },
      lessonCount: 25,
      pricing: { state: 'available', prices: [{ minorUnits: 289000, currency: 'VND', compareAtMinorUnits: 699000 }] },
    });
    expect(harness?.cover?.url).toStartWith('https://assets.200lab.io/');
    expect(harness?.cover?.variants.map(v => v.width)).toEqual([640, 960]);
    expect(feed.items.find(c => c.slug === UNAVAILABLE)?.pricing.state).toBe('unavailable');
  });

  test('validates the saved learning-paths.json fixture', () => {
    const feed = parseLab200Feed('learningPaths', PATHS);
    if (!feed.ok) throw new Error(feed.reason);
    expect(feed.locale).toBe('vi');
    expect(feed.items).toHaveLength(3);
    expect(feed.items[0]).toMatchObject({
      slug: 'thiet-ke-he-thong-qua-bai-toan-thuc-te-saas-realtime-va-video',
      url: 'https://200lab.io/learning-paths/thiet-ke-he-thong-qua-bai-toan-thuc-te-saas-realtime-va-video',
      courseCount: 5,
      pricing: { state: 'available', prices: [{ minorUnits: 859000, currency: 'VND', compareAtMinorUnits: 965000 }] },
    });
    expect(feed.items[2].pricing.state).toBe('unavailable');
  });

  test('rejects unsupported versions, wrong or empty lists and feeds without a valid item', () => {
    expect(parseLab200Feed('courses', { version: 2, locale: 'vi', courses: [course()] })).toMatchObject({ ok: false });
    expect(parseLab200Feed('courses', { locale: 'vi', courses: [course()] })).toMatchObject({ ok: false });
    expect(parseLab200Feed('courses', { version: 1, courses: [course()] })).toMatchObject({ ok: false });
    expect(parseLab200Feed('courses', { version: 1, locale: '<b>', courses: [course()] })).toMatchObject({ ok: false });
    expect(parseLab200Feed('courses', { version: 1, locale: 'vi', courses: [] })).toMatchObject({ ok: false });
    expect(parseLab200Feed('courses', { version: 1, locale: 'vi', learningPaths: [course()] })).toMatchObject({ ok: false });
    expect(parseLab200Feed('courses', { version: 1, locale: 'vi', courses: [{ slug: 'x' }] })).toMatchObject({ ok: false });
    expect(parseLab200Feed('courses', [course()])).toMatchObject({ ok: false });
    expect(parseLab200Feed('courses', { version: 1, locale: 'vi', courses: [course()] })).toMatchObject({ ok: true });
    // A learning path is never accepted from the courses list and vice versa (path prefix differs).
    expect(parseLab200Feed('learningPaths', COURSES)).toMatchObject({ ok: false });
  });

  test('drops items whose links are not the canonical 200lab URLs', () => {
    expect(parseLab200Course(course())).not.toBeNull();
    for (const over of [
      { url: 'https://evil.example/courses/demo-course' },
      { url: 'http://200lab.io/courses/demo-course' },
      { url: 'https://200lab.io.evil.example/courses/demo-course' },
      { url: 'https://user:pw@200lab.io/courses/demo-course' },
      { url: 'https://200lab.io:8443/courses/demo-course' },
      { url: 'https://200lab.io/courses/other-course' },
      { url: 'https://200lab.io/learning-paths/demo-course' },
      { url: 'javascript:alert(1)' },
      { jsonUrl: 'https://evil.example/courses/demo-course.json' },
      { jsonUrl: 'https://200lab.io/courses/demo-course.json?redirect=https://evil.example' },
      { jsonUrl: 'https://200lab.io/courses/other.json' },
      { slug: 'Bad_Slug' },
      { slug: '../etc' },
      { title: '' },
      { title: '<script></script>' },
    ]) {
      expect(parseLab200Course(course(over))).toBeNull();
    }
    // A query on the page URL is kept, a fragment is dropped.
    expect(parseLab200Course(course({ url: 'https://200lab.io/courses/demo-course?utm_source=feed#x' }))?.url)
      .toBe('https://200lab.io/courses/demo-course?utm_source=feed');
    expect(parseLab200LearningPath(course())).toBeNull();
  });

  test('strips markup and control characters from feed text', () => {
    const c = parseLab200Course(course({
      title: 'Hello <script>alert(1)</script><img src=x onerror=alert(1)> world\u0000\u202e',
      summary: 'Line 1\n\nLine 2 <b>bold</b>',
      category: { slug: 'ai', name: '<i>AI</i>' },
    }));
    expect(c?.title).toBe('Hello alert(1) world');
    expect(c?.summary).toBe('Line 1 Line 2 bold');
    expect(c?.category).toEqual({ slug: 'ai', name: 'AI' });
    expect(sanitizeText('x'.repeat(50), 10)).toBe(`${'x'.repeat(9)}…`);
    expect(sanitizeText(42, 10)).toBe('');
  });

  test('accepts only https images on assets.200lab.io', () => {
    expect(lab200AssetUrl('https://assets.200lab.io/a.webp')).toBe('https://assets.200lab.io/a.webp');
    expect(lab200AssetUrl('http://assets.200lab.io/a.webp')).toBeNull();
    expect(lab200AssetUrl('https://evil.example/a.webp')).toBeNull();
    expect(lab200AssetUrl('data:image/png;base64,AAAA')).toBeNull();
    const mixed = parseLab200Course(course({
      cover: {
        url: 'https://evil.example/x.png',
        variants: [
          { width: 960, url: 'https://assets.200lab.io/960' },
          { width: 640, url: 'https://evil.example/640' },
          { width: 'wide', url: 'https://assets.200lab.io/bad' },
        ],
      },
    }));
    expect(mixed?.cover).toEqual({ url: 'https://assets.200lab.io/960', variants: [{ width: 960, url: 'https://assets.200lab.io/960' }] });
    expect(parseLab200Course(course({ cover: { url: 'https://evil.example/x.png' } }))?.cover).toBeNull();
    expect(parseLab200Course(course({ cover: 'https://assets.200lab.io/x' }))?.cover).toBeNull();
    expect(parseLab200Course(course({ cover: null }))).not.toBeNull();
  });

  test('ignores missing or removed featured slugs', () => {
    const feed = parseLab200Feed('courses', COURSES);
    if (!feed.ok) throw new Error(feed.reason);
    const { featured, others } = splitFeatured(feed.items);
    expect(featured.map(c => c.slug)).toEqual([HARNESS, FREE, 'xay-copilot-ho-tro-nguoi-truc-chat-tu-cau-chuyen-that-den-san-pham-chay-duoc']);
    expect(others).toHaveLength(3);
    expect(splitFeatured([]).featured).toEqual([]);
  });
});

describe('200lab pricing', () => {
  const pricing = (state: string, prices: unknown) => parseLab200Pricing({ state, prices });

  test('shows free, paid, unavailable and unpriced items from the JSON price fields only', () => {
    expect(lab200PriceView(pricing('available', [{ minorUnits: 0, currency: 'VND' }])!)).toEqual({ kind: 'free' });
    expect(lab200PriceView(pricing('available', [{ minorUnits: 289000, currency: 'VND', compareAtMinorUnits: 699000 }])!))
      .toEqual({ kind: 'paid', amount: 289000, from: false, compareAt: 699000 });
    expect(lab200PriceView(pricing('unavailable', [{ minorUnits: 289000, currency: 'VND' }])!)).toEqual({ kind: 'unavailable' });
    expect(lab200PriceView(pricing('coming_soon', [])!)).toEqual({ kind: 'unavailable' });
    expect(lab200PriceView(pricing('available', [])!)).toEqual({ kind: 'unknown' });
    expect(lab200PriceView(parseLab200Pricing({ state: 'available' })!)).toEqual({ kind: 'unknown' });
  });

  test('uses the lowest of several prices and never applies a referral discount', () => {
    const view = lab200PriceView(pricing('available', [
      { minorUnits: 499000, currency: 'VND', compareAtMinorUnits: 899000 },
      { minorUnits: 199000, currency: 'VND', compareAtMinorUnits: 399000 },
    ])!);
    expect(view).toEqual({ kind: 'paid', amount: 199000, from: true, compareAt: 399000 });
    expect(formatVnd(199000)).toBe('199.000 ₫');
    expect(formatVnd(1055000)).toBe('1.055.000 ₫');
  });

  test('ignores comparison prices that are not above the price and skips unsupported currencies', () => {
    expect(pricing('available', [{ minorUnits: 100, currency: 'VND', compareAtMinorUnits: 100 }])?.prices[0].compareAtMinorUnits).toBeNull();
    expect(pricing('available', [{ minorUnits: 100, currency: 'VND', compareAtMinorUnits: 50 }])?.prices[0].compareAtMinorUnits).toBeNull();
    expect(pricing('available', [{ minorUnits: 500, currency: 'USD' }])).toEqual({ state: 'available', prices: [] });
    expect(lab200PriceView(pricing('available', [{ minorUnits: 500, currency: 'USD' }])!)).toEqual({ kind: 'unknown' });
  });

  test('rejects malformed prices (the item is dropped)', () => {
    for (const bad of [
      [{ minorUnits: -1, currency: 'VND' }],
      [{ minorUnits: 1.5, currency: 'VND' }],
      [{ minorUnits: '199000', currency: 'VND' }],
      [{ minorUnits: Number.MAX_VALUE, currency: 'VND' }],
      [{ minorUnits: 100, currency: 'vnd' }],
      [{ minorUnits: 100 }],
      [{ minorUnits: 100, currency: 'VND', compareAtMinorUnits: 'x' }],
      'free',
      Array.from({ length: 11 }, () => ({ minorUnits: 1, currency: 'VND' })),
    ]) {
      expect(pricing('available', bad)).toBeNull();
      expect(parseLab200Course(course({ pricing: { state: 'available', prices: bad } }))).toBeNull();
    }
    expect(parseLab200Pricing({ prices: [] })).toBeNull();
    expect(parseLab200Course(course({ pricing: undefined }))).toBeNull();
  });
});

describe('200lab referral links', () => {
  test('add ref=T2CWW3D7 exactly once to the canonical URL', () => {
    expect(lab200Link('https://200lab.io/courses/agent-harness-foundations')).toBe('https://200lab.io/courses/agent-harness-foundations?ref=T2CWW3D7');
    expect(lab200Link('https://200lab.io/courses/a?ref=OTHER&ref=X&utm_source=feed#top')).toBe('https://200lab.io/courses/a?utm_source=feed&ref=T2CWW3D7');
    expect(lab200Link(lab200Link('https://200lab.io/learning-paths/p'))).toBe('https://200lab.io/learning-paths/p?ref=T2CWW3D7');
  });

  test('fall back to the 200lab home page for anything else', () => {
    expect(lab200Link('https://evil.example/courses/a')).toBe('https://200lab.io/?ref=T2CWW3D7');
    expect(lab200Link('javascript:alert(1)')).toBe('https://200lab.io/?ref=T2CWW3D7');
    expect(lab200Link('http://200lab.io/courses/a')).toBe('https://200lab.io/?ref=T2CWW3D7');
  });
});

describe('200lab D1 catalog', () => {
  const t0 = new Date('2026-10-23T06:00:00.000Z');
  const after = (from: Date, ms = LAB200_STALE_MS + 1) => new Date(from.getTime() + ms);
  const row = (d1: ReturnType<typeof createTestD1>, kind: string) =>
    d1.raw.query('SELECT items_json, locale, content_hash, synced_at, checked_at FROM lab200_catalog WHERE kind = ?').get(kind) as
      { items_json: string; locale: string | null; content_hash: string; synced_at: string | null; checked_at: string };

  test('fetches only the two JSON feeds on the first request, then serves D1 and refreshes each stale feed later', async () => {
    const d1 = createTestD1();
    const { fetchImpl, calls } = fakeFetch({ courses: [ok(COURSES_JSON), ok(COURSES_JSON)], learningPaths: [ok(PATHS_JSON), ok(PATHS_JSON)] });

    const first = await getLab200Catalog(d1, { fetchImpl, now: () => t0 });
    expect(first.courses.items).toHaveLength(6);
    expect(first.learningPaths.items).toHaveLength(3);
    expect(first.courses).toMatchObject({ locale: 'vi', syncedAt: t0.toISOString() });
    expect(first.learningPaths).toMatchObject({ locale: 'vi', syncedAt: t0.toISOString() });
    // Exactly the two catalog feeds: no courses.md, no course pages, no per-item detail JSON.
    expect(calls.sort()).toEqual(['https://200lab.io/courses.json', 'https://200lab.io/learning-paths.json']);
    expect(row(d1, 'courses').content_hash).toMatch(/^[0-9a-f]{16,}$/);

    // Fresh: no fetch.
    await getLab200Catalog(d1, { fetchImpl, now: () => after(t0, 60_000) });
    expect(calls).toHaveLength(2);

    // Stale: served from D1 at once; one background refresh per feed is handed to waitUntil.
    const jobs: Promise<unknown>[] = [];
    const later = after(t0);
    const stale = await getLab200Catalog(d1, { fetchImpl, now: () => later, waitUntil: p => jobs.push(p) });
    expect(stale.courses.items).toHaveLength(6);
    expect(stale.courses.syncedAt).toBe(t0.toISOString());
    expect(jobs).toHaveLength(2);
    await Promise.all(jobs);
    expect(calls).toHaveLength(4);
    expect(row(d1, 'learning_paths').synced_at).toBe(later.toISOString());
  });

  test('a failing feed neither blocks nor wipes the other', async () => {
    const d1 = createTestD1();
    const first = await getLab200Catalog(d1, {
      fetchImpl: fakeFetch({ courses: [ok(COURSES_JSON)], learningPaths: [{ status: 503, body: 'down' }] }).fetchImpl,
      now: () => t0,
    });
    expect(first.courses.items).toHaveLength(6);
    expect(first.learningPaths).toEqual({ items: [], locale: null, syncedAt: null });

    // Learning paths recover on a later request; courses are untouched (fresh, no fetch).
    const t1 = after(t0);
    const retry = fakeFetch({ learningPaths: [ok(PATHS_JSON)] });
    const second = await getLab200Catalog(d1, { fetchImpl: retry.fetchImpl, now: () => after(t0, 1000) });
    expect(second.learningPaths.items).toHaveLength(0); // still inside the throttle window of the failed attempt
    const third = await getLab200Catalog(d1, { fetchImpl: retry.fetchImpl, now: () => t1, waitUntil: () => {} });
    expect(third.learningPaths.items).toHaveLength(3);
    expect(third.courses.items).toHaveLength(6);
  });

  test('keeps the last good copy on timeout, HTTP error, invalid JSON, unsupported version, empty list, redirect or oversized body', async () => {
    const d1 = createTestD1();
    expect(await refreshLab200Feed(d1, 'courses', { fetchImpl: fakeFetch({ courses: [ok(COURSES_JSON)] }).fetchImpl, now: () => t0 })).toBe(true);
    const good = row(d1, 'courses');

    const failures: Answer[] = [
      'timeout',
      { status: 500, body: 'oops' },
      { status: 200, body: '{"version":1,"locale":"vi","courses":[' },
      ok(JSON.stringify({ version: 2, locale: 'vi', courses: [course()] })),
      ok(JSON.stringify({ version: 1, locale: 'vi', courses: [] })),
      ok(JSON.stringify({ version: 1, locale: 'vi', courses: [{ slug: 'x', url: 'https://evil.example/' }] })),
      { status: 302, body: '', headers: { Location: 'https://evil.example/courses.json' } },
      { status: 200, body: 'x', headers: { 'Content-Length': String(LAB200_MAX_FEED_BYTES + 1) } },
      ok(' '.repeat(LAB200_MAX_FEED_BYTES + 1)),
    ];
    let t = t0;
    for (const answer of failures) {
      t = after(t);
      expect(await refreshLab200Feed(d1, 'courses', { fetchImpl: fakeFetch({ courses: [answer] }).fetchImpl, now: () => t })).toBe(false);
      const now = row(d1, 'courses');
      expect(now.items_json).toBe(good.items_json);
      expect(now.content_hash).toBe(good.content_hash);
      expect(now.synced_at).toBe(t0.toISOString());
      expect(now.checked_at).toBe(t.toISOString());
    }
    const snap = await getLab200Catalog(d1, { fetchImpl: fakeFetch({}).fetchImpl, now: () => t });
    expect(snap.courses.items).toHaveLength(6);
    expect(snap.courses.syncedAt).toBe(t0.toISOString());
  });

  test('updates the hash only when the feed changes', async () => {
    const d1 = createTestD1();
    await refreshLab200Feed(d1, 'learningPaths', { fetchImpl: fakeFetch({ learningPaths: [ok(PATHS_JSON)] }).fetchImpl, now: () => t0 });
    const before = row(d1, 'learning_paths');
    const t1 = after(t0);
    await refreshLab200Feed(d1, 'learningPaths', { fetchImpl: fakeFetch({ learningPaths: [ok(PATHS_JSON)] }).fetchImpl, now: () => t1 });
    expect(row(d1, 'learning_paths').content_hash).toBe(before.content_hash);
    expect(row(d1, 'learning_paths').synced_at).toBe(t1.toISOString());
    const changed = PATHS_JSON.replace('"courseCount": 5', '"courseCount": 6');
    const t2 = after(t1);
    await refreshLab200Feed(d1, 'learningPaths', { fetchImpl: fakeFetch({ learningPaths: [ok(changed)] }).fetchImpl, now: () => t2 });
    expect(row(d1, 'learning_paths').content_hash).not.toBe(before.content_hash);
  });

  test('lets only one request refresh each feed within the stale window', async () => {
    const d1 = createTestD1();
    const { fetchImpl, calls } = fakeFetch({ courses: [ok(COURSES_JSON), ok(COURSES_JSON)], learningPaths: [ok(PATHS_JSON), ok(PATHS_JSON)] });
    await Promise.all([
      getLab200Catalog(d1, { fetchImpl, now: () => t0 }),
      getLab200Catalog(d1, { fetchImpl, now: () => t0 }),
      refreshLab200Feed(d1, 'courses', { fetchImpl, now: () => t0 }),
    ]);
    expect(calls.filter(u => u.endsWith('/courses.json'))).toHaveLength(1);
    expect(calls.filter(u => u.endsWith('/learning-paths.json'))).toHaveLength(1);
  });

  test('fetches both feeds live without D1 and degrades to empty lists', async () => {
    const live = await getLab200Catalog(undefined, { fetchImpl: fakeFetch({ courses: [ok(COURSES_JSON)] }).fetchImpl, now: () => t0 });
    expect(live.courses.items).toHaveLength(6);
    expect(live.learningPaths.items).toEqual([]);
  });

  test('re-validates stored rows and drops anything that no longer passes', async () => {
    const d1 = createTestD1();
    d1.raw.query('UPDATE lab200_catalog SET items_json = ?, synced_at = ?, checked_at = ? WHERE kind = ?')
      .run(JSON.stringify([course(), course({ slug: 'evil', url: 'https://evil.example/courses/evil' })]), t0.toISOString(), '2999-01-01T00:00:00.000Z', 'courses');
    const snap = await getLab200Catalog(d1, { fetchImpl: fakeFetch({}).fetchImpl, now: () => t0 });
    expect(snap.courses.items.map(c => c.slug)).toEqual(['demo-course']);
  });
});

describe('200lab catalog migration', () => {
  const legacy = [
    { slug: HARNESS, title: 'Agent Harness Foundations', summary: 'Harness', lessons: 25, status: 'Đang mở bán, giá từ 199.000 ₫', free: false, image: 'https://assets.200lab.io/sha256/aa/harness' },
    { slug: FREE, title: 'Làm chủ tư duy', summary: 'Free', lessons: 28, status: 'Miễn phí', free: true, image: null },
  ];
  const upgraded = () => createTestD1({
    beforeMigration: (file, db) => {
      if (file.startsWith('0030_')) {
        db.query('UPDATE lab200_snapshot SET courses_json = ?, content_hash = ?, synced_at = ? WHERE id = 1')
          .run(JSON.stringify(legacy), 'old', '2026-10-09T06:00:00.000Z');
      }
    },
  });

  test('backfills the old courses.md snapshot and keeps the old table intact', async () => {
    const d1 = upgraded();
    const old = d1.raw.query('SELECT courses_json FROM lab200_snapshot WHERE id = 1').get() as { courses_json: string };
    expect(JSON.parse(old.courses_json)).toEqual(legacy);

    // 200lab is down: the app still shows the upgraded last good list.
    const t = new Date('2026-10-23T06:00:00.000Z');
    const snap = await getLab200Catalog(d1, { fetchImpl: fakeFetch({}).fetchImpl, now: () => t, waitUntil: () => {} });
    expect(snap.courses.syncedAt).toBe('2026-10-09T06:00:00.000Z');
    expect(snap.courses.items).toHaveLength(2);
    expect(snap.courses.items[0]).toMatchObject({
      slug: HARNESS,
      url: `https://200lab.io/courses/${HARNESS}`,
      jsonUrl: `https://200lab.io/courses/${HARNESS}.json`,
      lessonCount: 25,
      cover: { url: 'https://assets.200lab.io/sha256/aa/harness', variants: [] },
      pricing: { state: 'available', prices: [] },
    });
    expect(snap.courses.items[1]).toMatchObject({ cover: null, pricing: { state: 'available', prices: [{ minorUnits: 0, currency: 'VND' }] } });
    expect(lab200PriceView(snap.courses.items[0].pricing)).toEqual({ kind: 'unknown' });
    expect(snap.learningPaths.items).toEqual([]);
  });

  test('replaces the backfilled list with the JSON feed on the first valid fetch', async () => {
    const d1 = upgraded();
    const t = new Date('2026-10-23T06:00:00.000Z');
    expect(await refreshLab200Feed(d1, 'courses', { fetchImpl: fakeFetch({ courses: [ok(COURSES_JSON)] }).fetchImpl, now: () => t })).toBe(true);
    const snap = await getLab200Catalog(d1, { fetchImpl: fakeFetch({}).fetchImpl, now: () => t });
    expect(snap.courses.items).toHaveLength(6);
    expect(snap.courses.syncedAt).toBe(t.toISOString());
  });

  test('a fresh database starts with two empty feeds', () => {
    const d1 = createTestD1();
    const rows = d1.raw.query('SELECT kind, items_json, synced_at FROM lab200_catalog ORDER BY kind').all();
    expect(rows).toEqual([
      { kind: 'courses', items_json: '[]', synced_at: null },
      { kind: 'learning_paths', items_json: '[]', synced_at: null },
    ]);
  });
});

describe('/200lab.md', () => {
  test('lists both catalogs with referral links, sources, disclosure and sync times', async () => {
    const d1 = createTestD1();
    const t = new Date();
    await refreshLab200Feed(d1, 'courses', { fetchImpl: fakeFetch({ courses: [ok(COURSES_JSON)] }).fetchImpl, now: () => t });
    await refreshLab200Feed(d1, 'learningPaths', { fetchImpl: fakeFetch({ learningPaths: [ok(PATHS_JSON)] }).fetchImpl, now: () => t });
    const res = await getLab200Md({ locals: { runtime: { env: { DB: d1 } } } } as unknown as APIContext);
    expect(res.headers.get('Content-Type')).toContain('text/markdown');
    const md = await res.text();

    expect(md).toContain('## Khóa học / Courses (6)');
    expect(md).toContain('## Lộ trình / Learning paths (3)');
    expect(md).toContain('Source: https://200lab.io/courses.json');
    expect(md).toContain('Source: https://200lab.io/learning-paths.json');
    expect(md.match(/Last synced: /g)).toHaveLength(2);
    expect(md).toContain('T2CWW3D7');
    expect(md).toContain('Duy nhận hoa hồng giới thiệu');
    // Every item link is its canonical page with the referral code exactly once.
    const links = [...md.matchAll(/\]\((https:\/\/200lab\.io\/[^)]+)\)/g)].map(m => m[1]);
    expect(links).toHaveLength(9);
    for (const l of links) {
      expect(l).toMatch(/^https:\/\/200lab\.io\/(courses|learning-paths)\/[a-z0-9-]+\?ref=T2CWW3D7$/);
    }
    expect(md).not.toMatch(/\.md\?ref=/);
    // Prices straight from the JSON: no referral arithmetic (289.000 × 0.8 = 231.200).
    expect(md).toContain('giá 200lab 289.000 ₫ (giá so sánh 699.000 ₫)');
    expect(md).not.toContain('231.200');
    expect(md).toContain('Miễn phí / Free');
    expect(md).toContain('Chưa mở bán / Not on sale');
    expect(md).toContain('5 khoá học');
    expect(md).toContain('xác nhận khi thanh toán');
  });

  test('neutralizes markup in feed text and degrades to an honest empty state', () => {
    const item = parseLab200Course(course({ title: 'A [link](https://evil.example) > b', summary: '<x' }));
    if (!item) throw new Error('fixture invalid');
    const md = renderLab200Markdown({
      courses: { items: [item], locale: 'vi', syncedAt: null },
      learningPaths: { items: [], locale: null, syncedAt: null },
    });
    expect(md).toContain('- [A \\[link\\](https://evil.example) › b](https://200lab.io/courses/demo-course?ref=T2CWW3D7): ‹x');
    expect(md).toContain('The learning paths could not be loaded');
    expect(md).toContain('https://200lab.io/?ref=T2CWW3D7');
  });
});

describe('GET /api/v1/lab200 client parser', () => {
  test('round-trips the API payload through the same validators', () => {
    const courses = parseLab200Items('courses', (COURSES as { courses: unknown }).courses);
    const learningPaths = parseLab200Items('learningPaths', (PATHS as { learningPaths: unknown }).learningPaths);
    const parsed = parseLab200Catalog({
      courses: [...courses, { slug: 'evil', url: 'https://evil.example' }],
      synced_at: '2026-10-23T06:00:00.000Z',
      courses_locale: 'vi',
      learning_paths: learningPaths,
      learning_paths_synced_at: null,
      learning_paths_locale: 'vi',
    });
    expect(parsed?.courses.items).toEqual(courses);
    expect(parsed?.learningPaths.items).toEqual(learningPaths);
    expect(parsed?.courses.syncedAt).toBe('2026-10-23T06:00:00.000Z');
    expect(parsed?.learningPaths.syncedAt).toBeNull();
    expect(parseLab200Catalog({ learning_paths: [] })).toBeNull();
    expect(parseLab200Catalog(null)).toBeNull();
  });
});
