import { describe, it, expect } from 'vitest';
import { decodeEntities, extractLinks, htmlToText } from './lib/extract';
import { checkExpectation, evidenceFromPages } from './lib/expect';
import { crawl, type PageFetcher } from './lib/crawl';
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
    return p ? { ok: true, contentType: p.type, body: p.body } : { ok: false, contentType: '', body: '' };
  };
  it('follows only links matching intent, within hop budget', async () => {
    const pages = await crawl('https://zuey.me', fetcher, { follow: 'pric', maxHops: 1 });
    const urls = pages.map((p) => p.url);
    expect(urls).toContain('https://zuey.me/pricing');
    expect(urls).not.toContain('https://zuey.me/pricing/plans');
    expect(urls).not.toContain('https://zuey.me/videos');
    const deeper = await crawl('https://zuey.me', fetcher, { follow: 'pric', maxHops: 2 });
    expect(deeper.map((p) => p.url)).toContain('https://zuey.me/pricing/plans');
    expect(checkExpectation({ matchers: [{ text: 'combo \\$19' }] }, evidenceFromPages(deeper)).passed).toBe(true);
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
    for (const t of MCP_TASKS) expect(READ_ONLY_TOOLS.has(t.tool)).toBe(true);
  });
});
