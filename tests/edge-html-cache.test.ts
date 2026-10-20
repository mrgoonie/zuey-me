import { describe, expect, test } from 'bun:test';
import {
  EDGE_HTML_FRESH_S, EDGE_HTML_STALE_S, edgeCacheBypassReason, edgeCacheKey, isEdgeCachedPath, isStorableResponse,
  serveWithEdgeCache, type EdgeCache,
} from '../src/lib/edge-html-cache';

function memoryCache(): EdgeCache & { store: Map<string, Response> } {
  const store = new Map<string, Response>();
  return {
    store,
    async match(req) { return store.get(req.url)?.clone(); },
    async put(req, res) { store.set(req.url, res.clone()); },
  };
}

const req = (path: string, headers: Record<string, string> = {}, method = 'GET') => new Request(`https://zuey.me${path}`, { method, headers });
const html = (body = 'page', headers: Record<string, string> = {}, status = 200) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300', ...headers } });

async function serve(cache: EdgeCache, request: Request, render: () => Promise<Response>, now = 0, jobs: Promise<unknown>[] = []) {
  return serveWithEdgeCache(request, new URL(request.url), render, { cache, now: () => now, waitUntil: p => { jobs.push(p); } });
}

describe('edge HTML cache: which requests use it', () => {
  test('only the public landing pages', () => {
    for (const p of ['/', '/articles', '/pricing', '/articles/tui-dang-xay-nhung-cong-cu']) expect(isEdgeCachedPath(p)).toBe(true);
    for (const p of ['/account', '/articles/x.md', '/articles/a/b', '/api/v1/reads', '/reads', '/articles/Bad_Slug']) expect(isEdgeCachedPath(p)).toBe(false);
  });

  test('member, admin and OAuth sessions, Authorization, search and preview bypass', () => {
    const reason = (r: Request) => edgeCacheBypassReason(r, new URL(r.url));
    expect(reason(req('/'))).toBeNull();
    expect(reason(req('/', { cookie: 'zuey_locale=en; ph_123_posthog=abc; zr_ref=CODE' }))).toBeNull();
    expect(reason(req('/', { cookie: 'ph=1; zuey_member=tok' }))).toBe('session');
    expect(reason(req('/articles/a', { cookie: 'zuey_session=admin' }))).toBe('session');
    expect(reason(req('/', { cookie: 'zuey_member_oauth=state' }))).toBe('session');
    expect(reason(req('/articles', { authorization: 'Bearer zk_x' }))).toBe('authorization');
    expect(reason(req('/articles?q=ai'))).toBe('query');
    expect(reason(req('/articles/a?preview=1'))).toBe('query');
    expect(reason(req('/', {}, 'POST'))).toBe('method');
  });
});

describe('edge HTML cache: key and storability', () => {
  test('the key carries the resolved locale and ignores tracking parameters and other cookies', () => {
    const key = (r: Request) => edgeCacheKey(r, new URL(r.url)).url;
    expect(key(req('/articles?page=2&utm_source=x&fbclid=y&ref=ABC'))).toBe('https://zuey.me/articles?page=2&__locale=vi');
    expect(key(req('/articles?tag=b&category=a'))).toBe(key(req('/articles?category=a&tag=b')));
    expect(key(req('/', { 'accept-language': 'en-US,en;q=0.9' }))).toBe('https://zuey.me/?__locale=en');
    expect(key(req('/', { cookie: 'zuey_locale=en' }))).toBe('https://zuey.me/?__locale=en');
    expect(key(req('/?lang=vi', { cookie: 'zuey_locale=en' }))).toBe('https://zuey.me/?lang=vi&__locale=vi');
    expect(key(req('/', { cookie: 'ph=1' }))).toBe(key(req('/')));
  });

  test('only shareable 200 HTML without cookies is stored', () => {
    expect(isStorableResponse(html())).toBe(true);
    expect(isStorableResponse(html('x', {}, 404))).toBe(false);
    expect(isStorableResponse(html('x', { 'Set-Cookie': 'zuey_voter=1' }))).toBe(false);
    expect(isStorableResponse(html('x', { 'Cache-Control': 'private, no-store' }))).toBe(false);
    expect(isStorableResponse(new Response('{}', { headers: { 'Content-Type': 'application/json' } }))).toBe(false);
  });
});

describe('edge HTML cache: serving', () => {
  test('a miss renders and stores; the next anonymous visit is a hit without rendering', async () => {
    const cache = memoryCache();
    let renders = 0;
    const render = async () => { renders++; return html(`v${renders}`); };
    const first = await serve(cache, req('/'), render);
    expect(first.headers.get('X-Edge-Cache')).toBe('MISS');
    expect(await first.text()).toBe('v1');
    const second = await serve(cache, req('/'), render, 30_000);
    expect(second.headers.get('X-Edge-Cache')).toBe('HIT');
    expect(second.headers.has('X-Edge-Stored-At')).toBe(false);
    expect(await second.text()).toBe('v1');
    expect(renders).toBe(1);
  });

  test('a signed-in member never reads or writes the cache', async () => {
    const cache = memoryCache();
    await serve(cache, req('/'), async () => html('anonymous'));
    const member = await serve(cache, req('/', { cookie: 'zuey_member=tok' }), async () => html('member page', { 'Cache-Control': 'private, no-store' }));
    expect(await member.text()).toBe('member page');
    expect(member.headers.get('X-Edge-Cache')).toBe('BYPASS');
    expect([...cache.store.values()].length).toBe(1);
  });

  test('responses that set cookies or are not 200 are not stored', async () => {
    const cache = memoryCache();
    await serve(cache, req('/articles/a'), async () => html('x', { 'Set-Cookie': 'a=b' }));
    await serve(cache, req('/articles/b'), async () => html('missing', {}, 404));
    await serve(cache, req('/articles/c'), async () => html('paid text', { 'Cache-Control': 'private, no-store' }));
    expect(cache.store.size).toBe(0);
  });

  test('locales are cached separately', async () => {
    const cache = memoryCache();
    await serve(cache, req('/', { 'accept-language': 'en' }), async () => html('english'));
    const vi = await serve(cache, req('/', { 'accept-language': 'vi' }), async () => html('tiếng việt'));
    expect(await vi.text()).toBe('tiếng việt');
    expect(cache.store.size).toBe(2);
  });

  test('after the fresh window a stale copy is served while it re-renders in the background', async () => {
    const cache = memoryCache();
    let version = 1;
    const render = async () => html(`v${version}`);
    await serve(cache, req('/pricing'), render, 0);
    version = 2;
    const jobs: Promise<unknown>[] = [];
    const stale = await serve(cache, req('/pricing'), render, (EDGE_HTML_FRESH_S + 1) * 1000, jobs);
    expect(stale.headers.get('X-Edge-Cache')).toBe('STALE');
    expect(await stale.text()).toBe('v1');
    await Promise.all(jobs);
    const fresh = await serve(cache, req('/pricing'), render, (EDGE_HTML_FRESH_S + 2) * 1000);
    expect(await fresh.text()).toBe('v2');
    expect(fresh.headers.get('X-Edge-Cache')).toBe('HIT');
  });

  test('beyond the stale window the page renders again', async () => {
    const cache = memoryCache();
    let version = 1;
    await serve(cache, req('/'), async () => html(`v${version}`), 0);
    version = 2;
    const later = await serve(cache, req('/'), async () => html(`v${version}`), (EDGE_HTML_FRESH_S + EDGE_HTML_STALE_S + 1) * 1000);
    expect(later.headers.get('X-Edge-Cache')).toBe('MISS');
    expect(await later.text()).toBe('v2');
  });

  test('without a cache binding every request renders', async () => {
    const res = await serveWithEdgeCache(req('/'), new URL('https://zuey.me/'), async () => html('x'), { cache: undefined });
    expect(res.headers.get('X-Edge-Cache')).toBe('BYPASS');
  });
});
