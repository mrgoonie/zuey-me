import { describe, it, expect } from 'bun:test';
import { decodeEntities, extractLinks, htmlToText } from './lib/extract';
import { checkExpectation, evidenceFromPages } from './lib/expect';
import { cachedFetcher, crawl, type PageFetcher } from './lib/crawl';
import { findUnexpectedTools, hasMutatingSuffix, parseToolNames, parseToolText } from './lib/rpc';
import { parseArgs, passRate } from './lib/cli';
import { FETCH_TASKS } from './tasks-fetch';
import { MCP_TASKS, READ_ONLY_TOOLS } from './tasks-mcp';
import { BROWSER_TASKS } from './tasks-browser';

const HOME = `<html><head><script>var a="/hidden";</script></head><body>
<a href="/pricing" class="x">Pricing &amp; plans</a><a href='/videos'>Zueytube</a>
<a href="mailto:hi@zuey.me">mail</a><a href="https://other.example/x">ext</a><!-- <a href="/commented">no</a> --></body></html>`;
const LLMS = `# Site\n- [Courses](https://zuey.me/courses.md) — catalog\n- MCP Server: https://zuey.me/mcp (Streamable HTTP); legacy: https://zuey.me/api/mcp.\n`;

describe('extract', () => {
  it('decodes entities', () => expect(decodeEntities('a &amp; b &#65; &#x42;')).toBe('a & b A B'));
  it('extracts html anchors with resolved urls and skips mailto/comments', () => {
    const links = extractLinks(HOME, 'https://zuey.me/');
    expect(links.map((l) => l.href)).toEqual(['https://zuey.me/pricing', 'https://zuey.me/videos', 'https://other.example/x']);
    expect(links[0].text).toBe('Pricing & plans');
  });
  it('extracts markdown links and bare urls', () => {
    const hrefs = extractLinks(LLMS, 'https://zuey.me/llms.txt').map((l) => l.href);
    expect(hrefs).toContain('https://zuey.me/courses.md');
    expect(hrefs).toContain('https://zuey.me/mcp');
    expect(hrefs).toContain('https://zuey.me/api/mcp');
  });
  it('strips scripts and comments from text', () => {
    const t = htmlToText(HOME);
    expect(t).toContain('Pricing & plans');
    expect(t).not.toContain('hidden');
    expect(t).not.toContain('commented');
  });
});

describe('expectation matching', () => {
  const ev = { text: 'Hello Zueytube', hrefs: ['https://zuey.me/pricing'] };
  it('passes when all matchers hold', () => {
    expect(checkExpectation({ matchers: [{ link: '/pricing$' }, { text: 'zueytube' }] }, ev).passed).toBe(true);
  });
  it('reports the missing matcher', () => {
    const r = checkExpectation({ matchers: [{ link: '/videos' }] }, ev);
    expect(r.passed).toBe(false);
    expect(r.reason).toContain('/videos');
  });
  it('honours min and notText', () => {
    expect(checkExpectation({ matchers: [{ text: 'nope' }, { text: 'hello' }], min: 1 }, ev).passed).toBe(true);
    expect(checkExpectation({ matchers: [{ notText: 'hello' }] }, ev).passed).toBe(false);
  });
});

describe('crawl', () => {
  const site: Record<string, { type: string; body: string }> = {
    'https://zuey.me/': { type: 'text/html', body: HOME },
    'https://zuey.me/llms.txt': { type: 'text/plain', body: LLMS },
    'https://zuey.me/pricing': { type: 'text/html', body: '<a href="/pricing/plans">Plans</a> Combo $19' },
    'https://zuey.me/pricing/plans': { type: 'text/html', body: 'deep page' },
  };
  const fetcher: PageFetcher = async (u) => {
    const p = site[u];
    return p ? { status: 200, contentType: p.type, body: p.body } : { status: 404, contentType: '', body: '' };
  };
  it('follows only links matching intent, within hop budget', async () => {
    const { pages } = await crawl('https://zuey.me', fetcher, { follow: 'pric', maxHops: 1 });
    const urls = pages.map((p) => p.url);
    expect(urls).toContain('https://zuey.me/pricing');
    expect(urls).not.toContain('https://zuey.me/pricing/plans');
    expect(urls).not.toContain('https://zuey.me/videos');
    const { pages: deeper } = await crawl('https://zuey.me', fetcher, { follow: 'pric', maxHops: 2 });
    expect(deeper.map((p) => p.url)).toContain('https://zuey.me/pricing/plans');
    expect(checkExpectation({ matchers: [{ text: 'combo \\$19' }] }, evidenceFromPages(deeper)).passed).toBe(true);
  });
});

describe('crawl errors', () => {
  const home = { status: 200, contentType: 'text/html', body: '<a href="/pricing">Pricing</a>' };
  it('records transport failures and 5xx as errors but not 404s', async () => {
    const f: PageFetcher = async (u) => {
      if (u.endsWith('/llms.txt')) throw new Error('ECONNRESET');
      if (u.endsWith('/index.md')) return { status: 404, contentType: 'text/html', body: '' };
      if (u.endsWith('/pricing')) return { status: 503, contentType: 'text/html', body: '' };
      return home;
    };
    const { pages, errors } = await crawl('https://zuey.me', f, { follow: 'pric', maxHops: 1 });
    expect(pages.map((p) => p.url)).toEqual(['https://zuey.me/']);
    expect(errors).toHaveLength(2);
    expect(errors.join('|')).toContain('ECONNRESET');
    expect(errors.join('|')).toContain('HTTP 503');
  });
  it('follows nothing without a follow pattern, and caches per url', async () => {
    let calls = 0;
    const f = cachedFetcher(async () => { calls++; return home; });
    const { pages } = await crawl('https://zuey.me', f, { maxHops: 2 });
    expect(pages.map((p) => p.url)).toEqual(['https://zuey.me/', 'https://zuey.me/llms.txt', 'https://zuey.me/index.md']);
    await crawl('https://zuey.me', f, { maxHops: 0 });
    expect(calls).toBe(3);
  });
});

describe('mcp response parsing', () => {
  const ok = { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '[1]' }] } };
  it('extracts text and rejects malformed, rpc-error and tool-error responses', () => {
    expect(parseToolText(ok)).toEqual({ ok: true, text: '[1]' });
    expect(parseToolText('x').ok).toBe(false);
    expect(parseToolText({ error: { message: 'boom' } })).toEqual({ ok: false, error: 'rpc error: boom' });
    expect(parseToolText({ result: { isError: true, content: [{ text: 'bad' }] } }).ok).toBe(false);
    expect(parseToolText({ result: {} }).ok).toBe(false);
  });
  it('reads tool names', () => {
    expect(parseToolNames({ result: { tools: [{ name: 'a' }, { name: 'b' }] } })).toEqual(['a', 'b']);
    expect(parseToolNames({ result: { tools: [{}] } })).toBeNull();
    expect(parseToolNames(null)).toBeNull();
  });
  it('flags unknown or mutating tool names (resource_verb convention)', () => {
    for (const n of ['article_create', 'media_delete', 'course_upsert', 'notice_send', 'reads_sync', 'promo_code_create', 'referral_payout_mark_paid']) {
      expect(hasMutatingSuffix(n)).toBe(true);
    }
    expect(findUnexpectedTools(['get_profile', 'article_create', 'brand_new_tool'], READ_ONLY_TOOLS)).toEqual(['article_create', 'brand_new_tool']);
  });
  it('no read-only allowlist entry looks mutating', () => {
    for (const n of READ_ONLY_TOOLS) expect(hasMutatingSuffix(n)).toBe(false);
  });
});

describe('placeholders and whitespace', () => {
  it('anchors {base} patterns to the origin', () => {
    const m = { matchers: [{ text: '{base}/(api/)?mcp\\b' }] };
    expect(checkExpectation(m, { text: 'see https://zuey.me/mcp', hrefs: [], base: 'https://zuey.me' }).passed).toBe(true);
    expect(checkExpectation(m, { text: 'see https://evil.example/mcp', hrefs: [], base: 'https://zuey.me' }).passed).toBe(false);
  });
  it('normalizes whitespace in collected evidence', () => {
    const ev = evidenceFromPages([{ url: 'u', text: 'Hello\n   big   world', links: [] }]);
    expect(checkExpectation({ matchers: [{ text: 'hello big world' }] }, ev).passed).toBe(true);
  });
});

describe('cli + task definitions', () => {
  it('parses args and normalises base', () => {
    expect(parseArgs([])).toEqual({ base: 'https://zuey.me' });
    expect(parseArgs(['--base', 'http://localhost:4321/x', '--json', 'o.json'])).toEqual({ base: 'http://localhost:4321', json: 'o.json' });
  });
  it('computes pass rate', () => {
    expect(passRate([{ id: 'a', lane: 'mcp', passed: true, reason: '' }, { id: 'b', lane: 'mcp', passed: false, reason: '' }])).toEqual({ passed: 1, total: 2, pct: 50 });
  });
  it('has at least 10 uniquely identified tasks per lane', () => {
    for (const tasks of [FETCH_TASKS, MCP_TASKS, BROWSER_TASKS]) {
      expect(tasks.length).toBeGreaterThanOrEqual(10);
      expect(new Set(tasks.map((t) => t.id)).size).toBe(tasks.length);
    }
  });
  it('mcp tasks only use read-only tools', () => {
    for (const t of MCP_TASKS) expect(t.tool === 'tools/list' || READ_ONLY_TOOLS.has(t.tool)).toBe(true);
  });
});
