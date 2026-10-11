import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import type { APIRoute } from 'astro';
import { createTestD1 } from './helpers/d1';
import { createSession } from '../src/db/store';
import type { RuntimeEnv } from '../src/env';
import { createArticle, getArticle, publishArticle } from '../src/lib/blocks/articles';
import { articlesMcpModule } from '../src/lib/blocks/mcp';
import type { McpContext } from '../src/lib/mcp/types';
import { requireCan, resolvePrincipal } from '../src/lib/members/policy';
import { GET as getApi } from '../src/pages/api/v1/articles/[slug]';

// The admin draft read tells editors when the stored draft had to be recovered, so a save that
// sends the whole document never silently makes the loss permanent.

const YT = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const LOSSY = JSON.stringify({
  version: 1,
  blocks: [
    { id: 'p1', type: 'paragraph', text: 'Giữ lại' },
    { id: 'e1', type: 'embed', url: YT, provider: 'vimeo' },
    { id: 'h1', type: 'heading', level: 9, text: 'Bad level' },
  ],
});
const ALL_INVALID = JSON.stringify({ version: 1, blocks: [{ id: 'z', type: 'unknown' }] });

const d1 = createTestD1();
let adminCookie = '';
const originalWarn = console.warn;

async function seed(slug: string, draftJson: string | null): Promise<void> {
  const rec = await createArticle(d1, { slug, title: slug, document: { version: 1, blocks: [{ id: 'p0', type: 'paragraph', text: 'Ban đầu' }] } });
  if (draftJson === null) return;
  // Published first, so readers keep a valid public version while the draft breaks.
  await publishArticle(d1, slug, rec.revision, true);
  d1.raw.query('UPDATE article_editions SET draft_json = ? WHERE article_id = ?').run(draftJson, rec.id);
}

async function restGet(slug: string, query: string, cookie?: string): Promise<{ status: number; data: Record<string, unknown> }> {
  const request = new Request(`https://zuey.test/api/v1/articles/${slug}${query}`, { headers: cookie ? { cookie } : {} });
  const context = { request, params: { slug }, url: new URL(request.url), locals: { runtime: { env: { DB: d1 } } } };
  const res = await getApi(context as unknown as Parameters<APIRoute>[0]);
  const body = (await res.json()) as { data?: Record<string, unknown> };
  return { status: res.status, data: body.data ?? {} };
}

function mcpCtx(cookie?: string): McpContext {
  const request = new Request('https://zuey.test/api/mcp', { headers: cookie ? { cookie } : {} });
  const env: RuntimeEnv = { DB: d1 };
  const principal = () => resolvePrincipal(request, env);
  return {
    request, env, d1, principal,
    async isAdmin() { return (await principal()).kind === 'admin'; },
    async requireAdmin() { requireCan(await principal(), 'admin'); },
  };
}

async function mcpGet(args: Record<string, unknown>, cookie?: string): Promise<Record<string, unknown>> {
  const out = await articlesMcpModule.call('article_get', args, mcpCtx(cookie));
  if (typeof out !== 'object' || out === null) throw new Error('expected an object');
  return { ...out };
}

beforeAll(async () => {
  console.warn = () => {};
  adminCookie = `zuey_session=${await createSession('admin@zuey.me', d1)}`;
  await seed('clean', null);
  await seed('lossy', LOSSY);
  await seed('broken-json', '{not json');
  await seed('all-invalid', ALL_INVALID);
});
afterAll(() => { console.warn = originalWarn; });

describe('admin draft read reports recovery', () => {
  it('is null for a draft that passes validation', async () => {
    expect((await getArticle(d1, 'clean'))?.draft_recovery).toBeNull();
    const rest = await restGet('clean', '?draft=1', adminCookie);
    expect(rest.status).toBe(200);
    expect(rest.data.recovery).toBeNull();
  });

  it('counts dropped blocks and degraded embeds of a lossy draft (REST and MCP)', async () => {
    const expected = { dropped_blocks: 1, degraded_embeds: 1, unreadable: false };
    const rest = await restGet('lossy', '?draft=1', adminCookie);
    expect(rest.data.recovery).toEqual(expected);
    expect((rest.data.document as { blocks: Array<{ id: string }> }).blocks.map(b => b.id)).toEqual(['p1', 'e1']);
    const mcp = await mcpGet({ slug: 'lossy', draft: true }, adminCookie);
    expect(mcp.recovery).toEqual(expected);
    const md = await mcpGet({ slug: 'lossy', draft: true, format: 'markdown' }, adminCookie);
    expect(md.recovery).toEqual(expected);
  });

  it('flags an unreadable draft (bad JSON or every block invalid) shown as empty', async () => {
    for (const slug of ['broken-json', 'all-invalid']) {
      const rest = await restGet(slug, '?draft=1', adminCookie);
      expect(rest.data.recovery).toMatchObject({ unreadable: true });
      expect(rest.data.document).toEqual({ version: 1, blocks: [] });
    }
    expect((await restGet('all-invalid', '?draft=1', adminCookie)).data.recovery).toEqual({ dropped_blocks: 1, degraded_embeds: 0, unreadable: true });
    expect((await restGet('broken-json', '?draft=1', adminCookie)).data.recovery).toEqual({ dropped_blocks: 0, degraded_embeds: 0, unreadable: true });
  });

  it('is never part of reader views', async () => {
    const reader = await restGet('lossy', '');
    expect(reader.status).toBe(200);
    expect('recovery' in reader.data).toBe(false);
    const adminPublished = await restGet('lossy', '', adminCookie);
    expect('recovery' in adminPublished.data).toBe(false);
    const mcp = await mcpGet({ slug: 'lossy' });
    expect('recovery' in mcp).toBe(false);
  });

  it('documents the field in the MCP tool description', () => {
    const tool = articlesMcpModule.tools.find(t => t.name === 'article_get');
    expect(tool?.description).toContain('recovery');
    expect(tool?.description).toContain('dropped_blocks');
  });
});
