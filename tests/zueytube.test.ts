import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import type { APIRoute } from 'astro';
import { createTestD1 } from './helpers/d1';
import { createSession } from '../src/db/store';
import type { RuntimeEnv } from '../src/env';
import { buildContextMessage, retrieveContext } from '../src/lib/ai/context';
import type { McpContext } from '../src/lib/mcp/types';
import { allMcpTools } from '../src/lib/mcp/dispatch';
import { OPENAPI_FRAGMENTS } from '../src/lib/openapi/registry';
import { requireCan, resolvePrincipal } from '../src/lib/members/policy';
import { TOOL_ACCESS } from '../src/lib/oauth/tool-access';
import { searchKnowledge } from '../src/lib/search';
import { reindexArticle } from '../src/lib/search/indexer';
import { compactTranscript, parseAnyMdVideo, transcriptSegments } from '../src/lib/videos/anymd-transcript-parser';
import { renderVideosMarkdown } from '../src/lib/videos/markdown';
import { videosMcpModule } from '../src/lib/videos/mcp';
import { relatedArticlesForVideo, relatedVideosForArticle } from '../src/lib/videos/related-content';
import { getVideo, listVideos } from '../src/lib/videos/store';
import { addVideo, refetchTranscript } from '../src/lib/videos/video-ingest-service';
import { searchVideos } from '../src/lib/videos/video-search';
import { parseWatchHtml } from '../src/lib/videos/youtube-watch-metadata';
import { embedUrl, parseYoutubeId } from '../src/lib/videos/youtube-url';
import { GET as listApi, POST as addApi } from '../src/pages/api/v1/videos/index';
import { DELETE as deleteApi, GET as getApi, PATCH as patchApi } from '../src/pages/api/v1/videos/[id]';
import { GET as videosMdApi } from '../src/pages/videos.md';

const ORIGIN = 'https://zuey.test';
const VI_ID = 'aaaaaaaaaa1';
const EN_ID = 'bbbbbbbbbb2';
const NOCAP_ID = 'ccccccccccc';
const BROKEN_ID = 'ddddddddddd';

let d1 = createTestD1();

// ---------- Fake AnyMD + YouTube watch page ----------

function anymdMarkdown(id: string, title: string, lines: string[]): string {
  const transcript = lines.length
    ? lines.map(l => `**${l.split(' ')[0]}** · ${l.split(' ').slice(1).join(' ')}`).join('\n\n')
    : '> Transcript unavailable for this video.';
  return [
    '---',
    `title: ${JSON.stringify(title)}`,
    'author: "Zuey"',
    `source: https://www.youtube.com/watch?v=${id}`,
    `description: ${JSON.stringify(title)}`,
    `image: https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    'kind: youtube',
    `word_count: ${lines.length * 5}`,
    '---',
    '',
    `# ${title}`,
    '',
    '## Transcript',
    '',
    transcript,
    '',
  ].join('\n');
}

const FIXTURES: Record<string, string> = {
  [VI_ID]: anymdMarkdown(VI_ID, 'Tự host n8n trên VPS', [
    '0:00 Xin chào, hôm nay mình hướng dẫn tự host n8n',
    '1:05 Đầu tiên cài Docker và cấu hình reverse proxy với Caddy',
    '2:30 Từ khoá bí mật là zebracornflake chỉ có trong video',
  ]),
  [EN_ID]: anymdMarkdown(EN_ID, 'Self-hosting n8n on a VPS', [
    '0:00 Hi, today we self-host n8n',
    '1:10 Install Docker and set up a Caddy reverse proxy',
  ]),
  [NOCAP_ID]: anymdMarkdown(NOCAP_ID, 'Short without captions', []),
};

const WATCH_HTML = (desc: string) =>
  `<html><script>var x = {"lengthSeconds":"877","publishDate":"2026-03-02T05:00:00-08:00","shortDescription":${JSON.stringify(desc)}};</script></html>`;

let anymdCalls: string[] = [];
let anymdLanguages: unknown[] = [];

async function fakeFetch(input: string, init?: RequestInit): Promise<Response> {
  if (input.startsWith('https://anymd.cc/')) {
    const body: unknown = JSON.parse(String(init?.body));
    const url = typeof body === 'object' && body !== null && 'url' in body && typeof body.url === 'string' ? body.url : '';
    const id = parseYoutubeId(url) ?? '';
    anymdCalls.push(id);
    anymdLanguages.push(typeof body === 'object' && body !== null && 'language' in body ? body.language : undefined);
    if (id === BROKEN_ID) return new Response(JSON.stringify({ error: 'upstream exploded' }), { status: 502 });
    const md = FIXTURES[id];
    return md ? new Response(md, { status: 200, headers: { 'Content-Type': 'text/markdown' } }) : new Response('not found', { status: 404 });
  }
  if (input.startsWith('https://www.youtube.com/watch')) {
    return new Response(WATCH_HTML('Mô tả video.\nLink: https://zuey.me'), { status: 200 });
  }
  return new Response('unexpected', { status: 500 });
}

const deps = () => ({ db: d1, fetchImpl: fakeFetch });

// ---------- Route + MCP harness ----------

async function call(handler: APIRoute, init: { method?: string; body?: unknown; params?: Record<string, string>; headers?: Record<string, string>; query?: string } = {}): Promise<Response> {
  const headers = new Headers(init.headers ?? {});
  if (init.body !== undefined) headers.set('Content-Type', 'application/json');
  const request = new Request(`${ORIGIN}/api/v1/videos${init.query ?? ''}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const context = { request, params: init.params ?? {}, url: new URL(request.url), locals: { runtime: { env: { DB: d1, PUBLIC_SITE_URL: ORIGIN } } } };
  // The handlers only read request/params/url/locals; a full APIContext is not constructible in tests.
  return handler(context as unknown as Parameters<APIRoute>[0]);
}

function rec(v: unknown): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(`expected an object, got ${JSON.stringify(v)}`);
  return Object.fromEntries(Object.entries(v));
}

async function payload(res: Response): Promise<{ status: number; data: Record<string, unknown>; code: string | null }> {
  const body = rec(await res.json());
  const error = body.error === undefined ? {} : rec(body.error);
  return { status: res.status, data: body.data === undefined ? {} : rec(body.data), code: typeof error.code === 'string' ? error.code : null };
}

function mcpCtx(headers: Record<string, string>): McpContext {
  const request = new Request(`${ORIGIN}/api/mcp`, { headers });
  const env: RuntimeEnv = { DB: d1, PUBLIC_SITE_URL: ORIGIN };
  const principal = () => resolvePrincipal(request, env);
  return {
    request, env, d1, principal,
    async isAdmin() { return (await principal()).kind === 'admin'; },
    async requireAdmin() { requireCan(await principal(), 'admin'); },
  };
}

function insertArticle(slug: string, access: 'free' | 'knowledges', texts: string[], title: string): string {
  const id = `art_${slug}`;
  const doc = { version: 1, blocks: texts.map((text, i) => ({ id: `p${i}`, type: 'paragraph', text })) };
  const at = '2026-01-01T00:00:00.000Z';
  d1.raw.query(
    `INSERT INTO articles (id, slug, locale, title, excerpt, tags, access, status, draft_json, published_json, revision, created_at, updated_at, published_at)
     VALUES (?, ?, 'vi', ?, '', '[]', ?, 'published', ?, ?, 1, ?, ?, ?)`
  ).run(id, slug, title, access, JSON.stringify(doc), JSON.stringify(doc), at, at, at);
  d1.raw.query(
    `INSERT INTO article_editions (id, article_id, locale, title, excerpt, draft_json, published_json, revision, published_revision, status, created_at, updated_at, published_at)
     VALUES (?, ?, 'vi', ?, '', ?, ?, 1, 1, 'published', ?, ?, ?)`
  ).run(`ed_${slug}`, id, title, JSON.stringify(doc), JSON.stringify(doc), at, at, at);
  return id;
}

beforeEach(() => {
  d1 = createTestD1();
  anymdCalls = [];
  anymdLanguages = [];
});

// ---------- Pure helpers ----------

describe('YouTube links and AnyMD parsing', () => {
  it('extracts ids from every common link form and rejects others', () => {
    for (const url of [
      `https://www.youtube.com/watch?v=${VI_ID}&t=10s`,
      `https://youtu.be/${VI_ID}?si=x`,
      `https://www.youtube.com/shorts/${VI_ID}`,
      `https://www.youtube.com/live/${VI_ID}`,
      `https://www.youtube-nocookie.com/embed/${VI_ID}`,
      `m.youtube.com/watch?v=${VI_ID}`,
      VI_ID,
    ]) expect(parseYoutubeId(url)).toBe(VI_ID);
    expect(parseYoutubeId('https://vimeo.com/123')).toBeNull();
    expect(parseYoutubeId('https://www.youtube.com/@imzuey')).toBeNull();
    expect(embedUrl(VI_ID, 65)).toBe(`https://www.youtube-nocookie.com/embed/${VI_ID}?rel=0&modestbranding=1&start=65`);
  });

  it('parses frontmatter and timestamped transcript; drops a description equal to the title', () => {
    const parsed = parseAnyMdVideo(FIXTURES[VI_ID]);
    expect(parsed.title).toBe('Tự host n8n trên VPS');
    expect(parsed.description).toBe('');
    expect(parsed.thumbnail_url).toBe(`https://i.ytimg.com/vi/${VI_ID}/hqdefault.jpg`);
    expect(parsed.word_count).toBe(15);
    const segments = transcriptSegments(parsed.transcript);
    expect(segments).toHaveLength(3);
    expect(segments[1]).toEqual({ start: 65, label: '1:05', text: 'Đầu tiên cài Docker và cấu hình reverse proxy với Caddy' });
    expect(compactTranscript(FIXTURES[NOCAP_ID])).toBeNull();
  });

  it('reads duration, publish date and description from the watch page', () => {
    expect(parseWatchHtml(WATCH_HTML('Line 1\nLine "2"'))).toEqual({
      duration_seconds: 877,
      published_at: '2026-03-02T13:00:00.000Z',
      description: 'Line 1\nLine "2"',
    });
    expect(parseWatchHtml('<html></html>')).toEqual({ duration_seconds: null, published_at: null, description: null });
  });
});

// ---------- Ingest ----------

describe('adding videos', () => {
  it('stores the transcript and metadata, pairs the other language and rejects duplicates', async () => {
    const vi = await addVideo(deps(), { url: `https://youtu.be/${VI_ID}`, locale: 'vi' });
    expect(vi.transcript_status).toBe('ready');
    const en = await addVideo(deps(), { url: `https://www.youtube.com/watch?v=${EN_ID}`, locale: 'en', pair_with: vi.video.id });
    expect(en.video.id).toBe(vi.video.id);
    // Captions are requested in each edition's language (YouTube can mis-detect Vietnamese speech).
    expect(anymdLanguages).toEqual(['vi', 'en']);

    const video = await getVideo(d1, EN_ID, { transcript: true });
    expect(video?.editions.map(e => e.locale)).toEqual(['vi', 'en']);
    const viEdition = video?.editions[0];
    expect(viEdition?.duration_seconds).toBe(877);
    expect(viEdition?.description).toBe('Mô tả video.\nLink: https://zuey.me');
    expect(viEdition?.transcript).toContain('1:05 Đầu tiên cài Docker');

    await expect(addVideo(deps(), { url: VI_ID, locale: 'vi' })).rejects.toMatchObject({ code: 'video_exists' });
    await expect(addVideo(deps(), { url: 'https://example.com/x', locale: 'vi' })).rejects.toMatchObject({ code: 'invalid_youtube_url' });
    await expect(addVideo(deps(), { url: NOCAP_ID, locale: 'vi', pair_with: vi.video.id })).rejects.toMatchObject({ code: 'edition_exists' });
    await expect(addVideo(deps(), { url: NOCAP_ID, locale: 'en', pair_with: 'vid_missing' })).rejects.toMatchObject({ code: 'video_not_found' });
    expect((await listVideos(d1)).total).toBe(1);
  });

  it('keeps the video with a visible status when captions are missing or AnyMD fails', async () => {
    const nocap = await addVideo(deps(), { url: NOCAP_ID, locale: 'vi' });
    expect(nocap.transcript_status).toBe('unavailable');
    const broken = await addVideo(deps(), { url: BROKEN_ID, locale: 'en', title: 'Manual title' });
    expect(broken.transcript_status).toBe('failed');
    expect(broken.transcript_error).toBeTruthy();
    const stored = await getVideo(d1, BROKEN_ID);
    expect(stored?.editions[0].transcript_status).toBe('failed');
    expect((await listVideos(d1)).total).toBe(2);

    FIXTURES[BROKEN_ID] = anymdMarkdown(BROKEN_ID, 'Recovered', ['0:00 recovered transcript words']);
    try {
      // Swap the failing upstream for a working one and refetch.
      const recover = async (input: string, init?: RequestInit) =>
        input.startsWith('https://anymd.cc/') ? new Response(FIXTURES[BROKEN_ID], { status: 200 }) : fakeFetch(input, init);
      const again = await refetchTranscript({ db: d1, fetchImpl: recover }, BROKEN_ID);
      expect(again.transcript_status).toBe('ready');
    } finally {
      delete FIXTURES[BROKEN_ID];
    }
  });
});

// ---------- Search, grounding, related links ----------

describe('search, Zuey AI grounding and related links', () => {
  it('finds a term that only appears in a transcript (videos API, knowledge_search)', async () => {
    await addVideo(deps(), { url: VI_ID, locale: 'vi' });
    const hits = await searchVideos(d1, 'zebracornflake', { limit: 5, origin: ORIGIN, locale: 'vi' });
    expect(hits).toHaveLength(1);
    expect(hits[0].youtube_id).toBe(VI_ID);
    expect(hits[0].url).toBe(`${ORIGIN}/videos?v=${VI_ID}`);
    expect(hits[0].snippet).toContain('**zebracornflake**');

    // Diacritics-insensitive.
    expect((await searchVideos(d1, 'cau hinh reverse proxy', { limit: 5, origin: ORIGIN, locale: null })).length).toBe(1);

    const anon = await resolvePrincipal(new Request(`${ORIGIN}/`), { DB: d1 });
    const result = await searchKnowledge(anon, 'zebracornflake', 'vi', 10, { DB: d1, PUBLIC_SITE_URL: ORIGIN });
    expect(result.results).toHaveLength(0);
    expect(result.videos.map(v => v.youtube_id)).toEqual([VI_ID]);
  });

  it('lets Zuey AI cite a video when the answer is only in its transcript', async () => {
    await addVideo(deps(), { url: VI_ID, locale: 'vi' });
    insertArticle('khong-lien-quan', 'free', ['Một bài viết về nấu ăn.'], 'Nấu ăn');
    await reindexArticle(d1, 'art_khong-lien-quan');
    const anon = await resolvePrincipal(new Request(`${ORIGIN}/`), { DB: d1 });
    const sources = await retrieveContext(anon, 'zebracornflake là gì', 'vi', { d1, siteUrl: ORIGIN });
    const video = sources.find(s => s.kind === 'video');
    expect(video?.url).toBe(`${ORIGIN}/videos?v=${VI_ID}`);
    expect(video?.text).toContain('zebracornflake');
    expect(buildContextMessage(sources, 'zebracornflake là gì')).toContain('kind="video"');
  });

  it('links articles and videos both ways, using only public article text', async () => {
    await addVideo(deps(), { url: VI_ID, locale: 'vi' });
    insertArticle('n8n-docker', 'free', ['Hướng dẫn tự host n8n bằng Docker, reverse proxy Caddy trên VPS giá rẻ.'], 'Tự host n8n với Docker');
    insertArticle('meo', 'free', ['Mèo thích ngủ trong nắng sớm.'], 'Mèo và nắng');
    await reindexArticle(d1, 'art_n8n-docker');
    await reindexArticle(d1, 'art_meo');

    const video = await getVideo(d1, VI_ID);
    if (!video) throw new Error('missing video');
    const related = await relatedArticlesForVideo(d1, video, { origin: ORIGIN });
    expect(related.map(a => a.slug)).toEqual(['n8n-docker']);
    expect(related[0].url).toBe(`${ORIGIN}/articles/n8n-docker?lang=vi`);

    const back = await relatedVideosForArticle(d1, 'art_n8n-docker', 'vi', { origin: ORIGIN, limit: 3 });
    expect(back.map(v => v.youtube_id)).toEqual([VI_ID]);
    expect(await relatedVideosForArticle(d1, 'art_meo', 'vi', { origin: ORIGIN, limit: 3 })).toEqual([]);
  });
});

// ---------- REST, markdown, MCP, OpenAPI ----------

describe('public and admin surfaces', () => {
  const realFetch = globalThis.fetch;
  let adminCookie = '';
  beforeEach(async () => {
    adminCookie = `zuey_session=${await createSession('admin@zuey.me', d1)}`;
    globalThis.fetch = Object.assign((input: string | URL | Request, init?: RequestInit) => fakeFetch(String(input instanceof Request ? input.url : input), init), { preconnect: realFetch.preconnect });
  });
  afterEach(() => { globalThis.fetch = realFetch; });

  it('REST: public reads, admin-only writes', async () => {
    const denied = await payload(await call(addApi, { method: 'POST', body: { url: VI_ID, locale: 'vi' } }));
    expect(denied.status).toBe(401);

    const added = await payload(await call(addApi, { method: 'POST', headers: { cookie: adminCookie }, body: { url: VI_ID, locale: 'vi' } }));
    expect(added.status).toBe(201);
    expect(added.data.transcript_status).toBe('ready');
    const videoId = String(rec(added.data.video).id);

    const list = await payload(await call(listApi));
    expect(list.data.total).toBe(1);
    const search = await payload(await call(listApi, { query: '?q=zebracornflake' }));
    expect(JSON.stringify(search.data.results)).toContain(VI_ID);

    const detail = await payload(await call(getApi, { params: { id: VI_ID } }));
    expect(JSON.stringify(detail.data.video)).toContain('zebracornflake');
    expect(Array.isArray(detail.data.related_articles)).toBe(true);
    expect((await payload(await call(getApi, { params: { id: 'nope' } }))).status).toBe(404);

    expect((await payload(await call(patchApi, { method: 'PATCH', params: { id: videoId }, body: { featured: true } }))).status).toBe(401);
    const patched = await payload(await call(patchApi, { method: 'PATCH', params: { id: videoId }, headers: { cookie: adminCookie }, body: { featured: true } }));
    expect(patched.data.featured).toBe(true);

    const removed = await payload(await call(deleteApi, { method: 'DELETE', params: { id: videoId }, headers: { cookie: adminCookie } }));
    expect(removed.status).toBe(200);
    expect((await listVideos(d1)).total).toBe(0);
    expect(await searchVideos(d1, 'zebracornflake', { limit: 5, origin: ORIGIN, locale: null })).toEqual([]);
  });

  it('markdown lists videos for agents', async () => {
    await addVideo(deps(), { url: VI_ID, locale: 'vi' });
    const md = renderVideosMarkdown((await listVideos(d1)).items, ORIGIN);
    expect(md).toContain('Tự host n8n trên VPS');
    expect(md).toContain(`${ORIGIN}/videos?v=${VI_ID}`);
    const res = await call(videosMdApi);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(VI_ID);
  });

  it('MCP: list/get are public, writes need an admin', async () => {
    const anon = mcpCtx({});
    await expect(videosMcpModule.call('video_add', { url: VI_ID, locale: 'vi' }, anon)).rejects.toMatchObject({ status: 401 });
    const added = rec(await videosMcpModule.call('video_add', { url: VI_ID, locale: 'vi' }, mcpCtx({ cookie: adminCookie })));
    expect(added.transcript_status).toBe('ready');
    expect(JSON.stringify(await videosMcpModule.call('videos_list', {}, anon))).toContain(VI_ID);
    expect(JSON.stringify(await videosMcpModule.call('videos_list', { q: 'zebracornflake' }, anon))).toContain(VI_ID);
    expect(JSON.stringify(await videosMcpModule.call('video_get', { id: VI_ID }, anon))).toContain('zebracornflake');

    const names = allMcpTools().map(t => t.name);
    for (const n of ['videos_list', 'video_get', 'video_add', 'video_update', 'video_delete', 'video_refetch_transcript']) expect(names).toContain(n);
    expect(TOOL_ACCESS.videos_list).toEqual({ kind: 'public' });
    expect(TOOL_ACCESS.video_add).toEqual({ kind: 'admin' });
    const paths = OPENAPI_FRAGMENTS.flatMap(f => Object.keys(f.paths ?? {}));
    expect(paths).toContain('/api/v1/videos');
    expect(paths).toContain('/api/v1/videos/{id}');
  });
});
