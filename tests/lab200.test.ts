import { describe, it, expect } from 'vitest';
import type { APIContext } from 'astro';
import { createTestD1 } from './helpers/d1';
import { courseImageFromHtml, courseLink, parseCoursesMarkdown, slugFromCourseUrl, splitFeatured } from '../src/lib/lab200/courses';
import { renderLab200Markdown } from '../src/lib/lab200/markdown';
import { getLab200Snapshot, LAB200_STALE_MS, refreshLab200Snapshot } from '../src/lib/lab200/store';
import { GET as getLab200Md } from '../src/pages/200lab.md';

const COURSES_MD = `# Khóa học 200Lab

> Các khóa học đang mở, mới nhất trước.

- [Thiết kế API giữa các service - error model, versioning và contract test](https://200lab.io/courses/thiet-ke-api-giua-cac-service-error-model-versioning-va-contract-test.md): Khoá học về thiết kế API giữa các service, xoay quanh contract. · 25 bài học · Đang mở bán, giá từ 49.000 ₫
- [Làm chủ tư duy trong thời đại AI - tư duy hệ thống, cách giao việc và quản lý agent](https://200lab.io/courses/lam-chu-tu-duy-trong-thoi-dai-ai-tu-duy-he-thong-cach-giao-viec-va-quan-ly-agent.md): Đây là khoá nền tảng về cách nghĩ khi làm việc với AI. · 28 bài học · Miễn phí
- [Hiểu chuẩn dữ liệu để "Giao tiếp" hiệu quả với AI](https://200lab.io/courses/tim-hieu-cac-file-du-lieu-thuong-gap-json-jsonl-csv-yaml-va-markdown-frontmatter.md): JSON, JSONL, CSV · YAML và Markdown. · 8 bài học · Miễn phí
- [Agent Harness Foundations](https://200lab.io/courses/agent-harness-foundations.md): Khóa học nền tảng về Harness. · 25 bài học · Đang mở bán, giá từ 199.000 ₫
- [Not a course](https://evil.example/courses/agent-harness-foundations.md): ignored · 1 bài học · Miễn phí

Sitemap: https://200lab.io/sitemaps/courses.xml
`;

const imageFor = (slug: string) => `https://assets.200lab.io/sha256/aa/${slug}/generations/1`;
const coursePage = (slug: string) =>
  `<!doctype html><html><head><meta property="og:title" content="x"/><meta property="og:image" content="${imageFor(slug)}"/></head><body>${'x'.repeat(2000)}</body></html>`;

/**
 * courses.md answers come from `responses` in order; course pages answer with an og:image unless
 * `pageStatus` says otherwise. `calls` records courses.md fetches, `pageCalls` course page fetches.
 */
function fakeFetch(responses: Array<{ status: number; body: string }>, pageStatus = 200) {
  const calls: string[] = [];
  const pageCalls: string[] = [];
  const fetchImpl = async (input: string): Promise<Response> => {
    if (input.endsWith('/courses.md')) {
      calls.push(input);
      const next = responses.shift() ?? { status: 500, body: '' };
      return new Response(next.body, { status: next.status });
    }
    pageCalls.push(input);
    const slug = input.split('/courses/')[1];
    return new Response(pageStatus === 200 ? coursePage(slug) : 'nope', { status: pageStatus });
  };
  return { fetchImpl, calls, pageCalls };
}

describe('200lab courses parser and links', () => {
  it('parses every course line and ignores other hosts', () => {
    const courses = parseCoursesMarkdown(COURSES_MD);
    expect(courses.map(c => c.slug)).toEqual([
      'thiet-ke-api-giua-cac-service-error-model-versioning-va-contract-test',
      'lam-chu-tu-duy-trong-thoi-dai-ai-tu-duy-he-thong-cach-giao-viec-va-quan-ly-agent',
      'tim-hieu-cac-file-du-lieu-thuong-gap-json-jsonl-csv-yaml-va-markdown-frontmatter',
      'agent-harness-foundations',
    ]);
    expect(courses[0]).toMatchObject({ lessons: 25, status: 'Đang mở bán, giá từ 49.000 ₫', free: false });
    expect(courses[1]).toMatchObject({ lessons: 28, status: 'Miễn phí', free: true });
    // A " · " inside the summary stays in the summary.
    expect(courses[2].summary).toBe('JSON, JSONL, CSV · YAML và Markdown.');
    expect(courses[2].title).toBe('Hiểu chuẩn dữ liệu để "Giao tiếp" hiệu quả với AI');
  });

  it('builds course links without .md and with the referral code', () => {
    expect(courseLink('agent-harness-foundations')).toBe('https://200lab.io/courses/agent-harness-foundations?ref=T2CWW3D7');
    expect(slugFromCourseUrl('https://200lab.io/courses/agent-harness-foundations.md')).toBe('agent-harness-foundations');
    expect(slugFromCourseUrl('https://200lab.io/courses/agent-harness-foundations')).toBe('agent-harness-foundations');
    expect(slugFromCourseUrl('https://200lab.io/blog/x.md')).toBeNull();
    expect(slugFromCourseUrl('https://200lab.io/courses/Bad_Slug.md')).toBeNull();
  });

  it('puts featured courses first and skips featured slugs that are gone', () => {
    const { featured, others } = splitFeatured(parseCoursesMarkdown(COURSES_MD));
    expect(featured.map(c => c.slug)).toEqual([
      'agent-harness-foundations',
      'lam-chu-tu-duy-trong-thoi-dai-ai-tu-duy-he-thong-cach-giao-viec-va-quan-ly-agent',
    ]);
    expect(others).toHaveLength(2);
  });

  it('reads only https og:image URLs on assets.200lab.io', () => {
    expect(courseImageFromHtml(coursePage('a'))).toBe(imageFor('a'));
    expect(courseImageFromHtml('<meta content="https://assets.200lab.io/x.webp" property="og:image">')).toBe('https://assets.200lab.io/x.webp');
    expect(courseImageFromHtml('<meta property="og:image" content="https://evil.example/x.png">')).toBeNull();
    expect(courseImageFromHtml('<meta property="og:image" content="http://assets.200lab.io/x.png">')).toBeNull();
    expect(courseImageFromHtml('<meta property="og:image:alt" content="https://assets.200lab.io/x.png">')).toBeNull();
  });

  it('renders markdown whose course links all carry the referral code', () => {
    const md = renderLab200Markdown({ courses: parseCoursesMarkdown(COURSES_MD), syncedAt: '2026-10-09T06:00:00.000Z' });
    expect(md.match(/\?ref=T2CWW3D7\)/g)).toHaveLength(4);
    expect(md).not.toMatch(/200lab\.io\/courses\/[^)\s]*\.md/);
    expect(md).toContain('Việt Trần');
    expect(md).toContain('(https://nextlevelbuilder.io)');
  });
});

describe('200lab snapshot', () => {
  const t0 = new Date('2026-10-09T06:00:00.000Z');

  it('fetches on the first request, then serves D1 and refreshes in the background when stale', async () => {
    const d1 = createTestD1();
    const { fetchImpl, calls } = fakeFetch([{ status: 200, body: COURSES_MD }, { status: 200, body: COURSES_MD }]);

    const first = await getLab200Snapshot(d1, { fetchImpl, now: () => t0 });
    expect(first.courses).toHaveLength(4);
    expect(first.syncedAt).toBe(t0.toISOString());
    expect(calls).toHaveLength(1);

    // Fresh: no fetch.
    await getLab200Snapshot(d1, { fetchImpl, now: () => new Date(t0.getTime() + 60_000) });
    expect(calls).toHaveLength(1);

    // Stale: the page still gets the snapshot; the refresh is handed to waitUntil.
    const jobs: Promise<unknown>[] = [];
    const later = new Date(t0.getTime() + LAB200_STALE_MS + 1);
    const stale = await getLab200Snapshot(d1, { fetchImpl, now: () => later, waitUntil: p => jobs.push(p) });
    expect(stale.courses).toHaveLength(4);
    expect(jobs).toHaveLength(1);
    await Promise.all(jobs);
    expect(calls).toHaveLength(2);
  });

  it('keeps the last good snapshot when 200lab fails or returns no courses', async () => {
    const d1 = createTestD1();
    const ok = fakeFetch([{ status: 200, body: COURSES_MD }]);
    expect(await refreshLab200Snapshot(d1, { fetchImpl: ok.fetchImpl, now: () => t0 })).toBe(true);

    const t1 = new Date(t0.getTime() + LAB200_STALE_MS + 1);
    const down = fakeFetch([{ status: 500, body: 'oops' }]);
    expect(await refreshLab200Snapshot(d1, { fetchImpl: down.fetchImpl, now: () => t1 })).toBe(false);

    const t2 = new Date(t1.getTime() + LAB200_STALE_MS + 1);
    const empty = fakeFetch([{ status: 200, body: '# Khóa học 200Lab\n\nNothing here.' }]);
    expect(await refreshLab200Snapshot(d1, { fetchImpl: empty.fetchImpl, now: () => t2 })).toBe(false);

    const snap = await getLab200Snapshot(d1, { fetchImpl: empty.fetchImpl, now: () => t2 });
    expect(snap.courses).toHaveLength(4);
    expect(snap.syncedAt).toBe(t0.toISOString());
  });

  it('saves thumbnails without a referral code, defers them on the first request, and reuses them', async () => {
    const d1 = createTestD1();
    const { fetchImpl, calls, pageCalls } = fakeFetch([{ status: 200, body: COURSES_MD }, { status: 200, body: COURSES_MD }]);
    const jobs: Promise<unknown>[] = [];

    // First request: the list is saved and returned before the course pages are read.
    const first = await getLab200Snapshot(d1, { fetchImpl, now: () => t0, waitUntil: p => jobs.push(p) });
    expect(first.courses.every(c => c.image === null)).toBe(true);
    expect(jobs).toHaveLength(1);
    await Promise.all(jobs);
    expect(pageCalls).toHaveLength(4);
    expect(pageCalls.every(u => !u.includes('ref='))).toBe(true);

    const fresh = await getLab200Snapshot(d1, { fetchImpl, now: () => new Date(t0.getTime() + 1000) });
    expect(fresh.courses.map(c => c.image)).toEqual(fresh.courses.map(c => imageFor(c.slug)));

    // Same courses.md later: images are kept and no course page is fetched again.
    const t1 = new Date(t0.getTime() + LAB200_STALE_MS + 1);
    expect(await refreshLab200Snapshot(d1, { fetchImpl, now: () => t1 })).toBe(true);
    expect(calls).toHaveLength(2);
    expect(pageCalls).toHaveLength(4);
    const kept = await getLab200Snapshot(d1, { fetchImpl, now: () => t1 });
    expect(kept.courses.every(c => c.image === imageFor(c.slug))).toBe(true);
  });

  it('keeps previous thumbnails when course pages fail after courses.md changed', async () => {
    const d1 = createTestD1();
    await refreshLab200Snapshot(d1, { fetchImpl: fakeFetch([{ status: 200, body: COURSES_MD }]).fetchImpl, now: () => t0 });
    const changed = COURSES_MD.replace('25 bài học · Đang mở bán, giá từ 199.000 ₫', '26 bài học · Đang mở bán, giá từ 199.000 ₫');
    const down = fakeFetch([{ status: 200, body: changed }], 503);
    const t1 = new Date(t0.getTime() + LAB200_STALE_MS + 1);
    expect(await refreshLab200Snapshot(d1, { fetchImpl: down.fetchImpl, now: () => t1 })).toBe(true);
    expect(down.pageCalls).toHaveLength(4);
    const snap = await getLab200Snapshot(d1, { fetchImpl: down.fetchImpl, now: () => t1 });
    expect(snap.courses.find(c => c.slug === 'agent-harness-foundations')?.lessons).toBe(26);
    expect(snap.courses.every(c => c.image === imageFor(c.slug))).toBe(true);
  });

  it('lets only one request refresh within the stale window', async () => {
    const d1 = createTestD1();
    const { fetchImpl, calls } = fakeFetch([{ status: 200, body: COURSES_MD }, { status: 200, body: COURSES_MD }]);
    await Promise.all([
      refreshLab200Snapshot(d1, { fetchImpl, now: () => t0 }),
      refreshLab200Snapshot(d1, { fetchImpl, now: () => t0 }),
    ]);
    expect(calls).toHaveLength(1);
  });

  it('serves /200lab.md from the snapshot', async () => {
    const d1 = createTestD1();
    await refreshLab200Snapshot(d1, { fetchImpl: fakeFetch([{ status: 200, body: COURSES_MD }]).fetchImpl, now: () => new Date() });
    const res = await getLab200Md({ locals: { runtime: { env: { DB: d1 } } } } as unknown as APIContext);
    expect(res.headers.get('Content-Type')).toContain('text/markdown');
    const body = await res.text();
    expect(body.match(/\?ref=T2CWW3D7\)/g)).toHaveLength(4);
  });
});
