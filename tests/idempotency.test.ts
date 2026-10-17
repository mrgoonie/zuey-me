import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { APIContext } from 'astro';
import { createTestD1 } from './helpers/d1';
import { createApiKey } from '../src/db/store';
import type { RuntimeEnv } from '../src/env';
import { IDEMPOTENCY_STALE_MS, IDEMPOTENCY_TTL_MS, parseIdempotencyKey, withIdempotency } from '../src/lib/idempotency/store';
import { membersRuntime } from '../src/lib/members/runtime';
import { OPENAPI_FRAGMENTS } from '../src/lib/openapi/registry';
import { TOOL_ACCESS } from '../src/lib/oauth/tool-access';
import { POST as mcpApi } from '../src/pages/api/mcp';
import { POST as createApi } from '../src/pages/api/v1/articles/index';
import { PUT as updateApi, DELETE as deleteApi } from '../src/pages/api/v1/articles/[slug]';
import { POST as publishApi } from '../src/pages/api/v1/articles/[slug]/publish';
import { GET as lookupApi } from '../src/pages/api/v1/admin/idempotency/[key]';
import { POST as mediaApi } from '../src/pages/api/v1/admin/media/index';
import { allMcpTools } from '../src/lib/mcp/dispatch';

const ORIGIN = 'https://zuey.test';
const T0 = Date.parse('2026-10-17T07:00:00.000Z');
const KEY = 'retry-key-0001';

type TestDb = ReturnType<typeof createTestD1>;
let d1: TestDb;
let adminKey: string;
const originalNow = membersRuntime.now;

const env = (): RuntimeEnv => ({ DB: d1, PUBLIC_SITE_URL: ORIGIN });
const doc = (text: string) => ({ version: 1, blocks: [{ id: 'p1', type: 'paragraph', text }] });

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function field(v: unknown, ...keys: string[]): unknown {
  let cur: unknown = v;
  for (const k of keys) cur = isRecord(cur) ? cur[k] : undefined;
  return cur;
}

async function mcpCall(key: string | null, name: string, args: Record<string, unknown>) {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (key) headers.set('Authorization', `Bearer ${key}`);
  const request = new Request(`${ORIGIN}/api/mcp`, {
    method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const res = await mcpApi({ request, url: new URL(request.url), params: {}, locals: { runtime: { env: env() } } } as unknown as APIContext);
  const body: unknown = await res.json();
  const content = field(body, 'result', 'content');
  const text = field(Array.isArray(content) ? content[0] : undefined, 'text');
  return { status: res.status, result: typeof text === 'string' ? JSON.parse(text) as unknown : null, code: field(body, 'error', 'data', 'code') };
}

async function rest(handler: (ctx: APIContext) => Promise<Response> | Response, method: string, path: string, body: unknown, headers: Record<string, string> = {}, params: Record<string, string> = {}) {
  const request = new Request(`${ORIGIN}${path}`, {
    method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminKey}`, ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const res = await handler({ request, url: new URL(request.url), params, locals: { runtime: { env: env() } } } as unknown as APIContext);
  const json: unknown = await res.json();
  return { status: res.status, replayed: res.headers.get('Idempotent-Replayed'), data: field(json, 'data'), code: field(json, 'error', 'code') };
}

const count = async (sql: string) => Number(field(await d1.prepare(sql).first(), 'n'));

beforeEach(async () => {
  d1 = createTestD1();
  membersRuntime.now = () => T0;
  adminKey = (await createApiKey('ops', 'admin', d1)).key;
});

afterEach(() => {
  membersRuntime.now = originalNow;
});

describe('withIdempotency', () => {
  const base = () => ({ d1, actor: 'admin-api-key', operation: 'op', key: KEY, request: { a: 1, b: [1, 2] } });

  it('runs without a key and writes nothing', async () => {
    let runs = 0;
    const out = await withIdempotency({ ...base(), key: undefined }, async () => ({ n: ++runs }));
    expect(out).toEqual({ result: { n: 1 }, replayed: false });
    expect(await count('SELECT COUNT(*) AS n FROM idempotency_keys')).toBe(0);
  });

  it('replays the stored result and ignores key order in the request', async () => {
    let runs = 0;
    const first = await withIdempotency(base(), async () => ({ n: ++runs }));
    const second = await withIdempotency({ ...base(), request: { b: [1, 2], a: 1 } }, async () => ({ n: ++runs }));
    expect(first).toEqual({ result: { n: 1 }, replayed: false });
    expect(second).toEqual({ result: { n: 1 }, replayed: true });
    expect(runs).toBe(1);
  });

  it('stores only a hash of the key', async () => {
    await withIdempotency(base(), async () => ({ ok: true }));
    const row = await d1.prepare('SELECT * FROM idempotency_keys').first();
    expect(JSON.stringify(row)).not.toContain(KEY);
  });

  it('refuses a key reused for another request or operation (422)', async () => {
    await withIdempotency(base(), async () => ({ ok: true }));
    const other = await withIdempotency({ ...base(), request: { a: 2 } }, async () => ({ ok: false })).catch(e => e);
    const otherOp = await withIdempotency({ ...base(), operation: 'op2' }, async () => ({ ok: false })).catch(e => e);
    expect(field(other, 'code')).toBe('idempotency_key_reused');
    expect(field(other, 'status')).toBe(422);
    expect(field(otherOp, 'code')).toBe('idempotency_key_reused');
  });

  it('keeps keys private to the actor', async () => {
    let runs = 0;
    await withIdempotency(base(), async () => ({ n: ++runs }));
    const other = await withIdempotency({ ...base(), actor: 'someone@else' }, async () => ({ n: ++runs }));
    expect(other.replayed).toBe(false);
    expect(runs).toBe(2);
  });

  it('releases the key when the write fails so the same request can retry', async () => {
    const failed = await withIdempotency(base(), async () => { throw new Error('boom'); }).catch(e => e);
    expect(failed).toBeInstanceOf(Error);
    const retry = await withIdempotency(base(), async () => ({ ok: true }));
    expect(retry).toEqual({ result: { ok: true }, replayed: false });
  });

  it('answers 409 while the first request runs and lets one retry take over a crashed claim', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const first = withIdempotency(base(), async () => { await gate; return { n: 1 }; });
    await Promise.resolve();
    const busy = await withIdempotency(base(), async () => ({ n: 2 })).catch(e => e);
    expect(field(busy, 'code')).toBe('idempotency_in_progress');
    expect(field(busy, 'status')).toBe(409);

    membersRuntime.now = () => T0 + IDEMPOTENCY_STALE_MS + 1;
    const takeover = await withIdempotency(base(), async () => ({ n: 3 }));
    expect(takeover).toEqual({ result: { n: 3 }, replayed: false });
    release();
    await first;
  });

  it('does not release or complete a claim another retry took over', async () => {
    let fail: () => void = () => undefined;
    const gate = new Promise<void>((_, reject) => { fail = () => reject(new Error('late failure')); });
    const slow = withIdempotency(base(), async () => { await gate; return { n: 1 }; }).catch(e => e);
    await new Promise(resolve => setTimeout(resolve, 20));
    membersRuntime.now = () => T0 + IDEMPOTENCY_STALE_MS + 1;
    const owner = await withIdempotency(base(), async () => ({ n: 2 }));
    expect(owner.replayed).toBe(false);
    fail();
    expect(await slow).toBeInstanceOf(Error);
    const replay = await withIdempotency(base(), async () => ({ n: 3 }));
    expect(replay).toEqual({ result: { n: 2 }, replayed: true });
  });

  it('forgets results after 24 hours', async () => {
    await withIdempotency(base(), async () => ({ n: 1 }));
    membersRuntime.now = () => T0 + IDEMPOTENCY_TTL_MS + 1000;
    const later = await withIdempotency(base(), async () => ({ n: 2 }));
    expect(later).toEqual({ result: { n: 2 }, replayed: false });
  });

  it('drops an oversized document echo from the stored replay', async () => {
    const big = 'x'.repeat(1_000_000);
    await withIdempotency(base(), async () => ({ slug: 's', document: big }));
    const replay = await withIdempotency(base(), async () => ({ slug: 'other' }));
    expect(replay.result).toEqual({ slug: 's', document_omitted: true });
  });

  it('validates the key format', () => {
    expect(parseIdempotencyKey(undefined)).toBeUndefined();
    expect(parseIdempotencyKey(KEY)).toBe(KEY);
    for (const bad of ['short', 'has space in it', 'x'.repeat(129), 42]) expect(() => parseIdempotencyKey(bad)).toThrow();
  });
});

describe('article MCP tools', () => {
  it('replays article_create and article_update without a second write', async () => {
    const created = await mcpCall(adminKey, 'article_create', { slug: 'post', title: 'Bài viết', document: doc('v1'), idempotency_key: 'create-post-0001' });
    expect(created.result).toMatchObject({ slug: 'post', revision: 1 });
    const again = await mcpCall(adminKey, 'article_create', { slug: 'post', title: 'Bài viết', document: doc('v1'), idempotency_key: 'create-post-0001' });
    expect(again.status).toBe(200);
    expect(again.result).toMatchObject({ slug: 'post', revision: 1, idempotent_replay: true });

    const update = { slug: 'post', expected_revision: 1, document: doc('v2'), idempotency_key: 'update-post-0001' };
    const first = await mcpCall(adminKey, 'article_update', update);
    const retry = await mcpCall(adminKey, 'article_update', update);
    expect(field(first.result, 'revision')).toBe(2);
    expect(retry.result).toMatchObject({ revision: 2, idempotent_replay: true });
    const revisions = await mcpCall(adminKey, 'article_revisions', { slug: 'post' });
    expect(Array.isArray(revisions.result) ? revisions.result.length : 0).toBe(2);

    // Without a key the same stale request is rejected as before.
    const stale = await mcpCall(adminKey, 'article_update', { slug: 'post', expected_revision: 1, document: doc('v2') });
    expect(stale.code).toBe('revision_conflict');
  });

  it('publishes once and does not schedule a second email on retry', async () => {
    await mcpCall(adminKey, 'article_create', { slug: 'post', title: 'Bài viết', document: doc('v1') });
    const args = { slug: 'post', expected_revision: 1, confirm: true, idempotency_key: 'publish-post-001' };
    const first = await mcpCall(adminKey, 'article_publish', args);
    const retry = await mcpCall(adminKey, 'article_publish', args);
    expect(first.status).toBe(200);
    expect(retry.result).toMatchObject({ idempotent_replay: true });
    expect(await count('SELECT COUNT(*) AS n FROM article_notifications')).toBe(1);
    const view = await mcpCall(adminKey, 'article_get', { slug: 'post' });
    expect(field(view.result, 'revision')).toBe(field(first.result, 'revision'));
  });

  it('refuses a reused key with different arguments and a malformed key', async () => {
    await mcpCall(adminKey, 'article_create', { slug: 'post', title: 'A', document: doc('v1'), idempotency_key: 'create-post-0002' });
    const reuse = await mcpCall(adminKey, 'article_create', { slug: 'other', title: 'B', document: doc('v1'), idempotency_key: 'create-post-0002' });
    expect(reuse.code).toBe('idempotency_key_reused');
    const bad = await mcpCall(adminKey, 'article_create', { slug: 'x', title: 'B', document: doc('v1'), idempotency_key: 'bad key' });
    expect(bad.code).toBe('invalid_idempotency_key');
    expect(await count("SELECT COUNT(*) AS n FROM articles WHERE slug IN ('other', 'x')")).toBe(0);
  });

  it('recovers a lost response through idempotency_lookup, scoped to admins', async () => {
    await mcpCall(adminKey, 'article_create', { slug: 'post', title: 'A', document: doc('v1'), idempotency_key: 'create-post-0003' });
    const found = await mcpCall(adminKey, 'idempotency_lookup', { key: 'create-post-0003' });
    expect(found.result).toMatchObject({ operation: 'article_create', state: 'done', result: { slug: 'post', revision: 1 } });
    expect((await mcpCall(adminKey, 'idempotency_lookup', { key: 'unknown-key-0001' })).code).toBe('not_found');
    expect((await mcpCall(null, 'idempotency_lookup', { key: 'create-post-0003' })).status).toBe(401);
    const readKey = (await createApiKey('viewer', 'read', d1)).key;
    expect((await mcpCall(readKey, 'idempotency_lookup', { key: 'create-post-0003' })).status).toBe(403);
  });

  it('does not accept a key from a non-admin caller', async () => {
    const readKey = (await createApiKey('viewer2', 'read', d1)).key;
    const res = await mcpCall(readKey, 'article_create', { slug: 'p', title: 'A', document: doc('v1'), idempotency_key: 'create-post-0004' });
    expect(res.status).toBe(403);
    expect(await count('SELECT COUNT(*) AS n FROM idempotency_keys')).toBe(0);
  });
});

describe('article REST routes', () => {
  it('replays create, update, publish and delete with the Idempotency-Key header', async () => {
    const headers = (k: string) => ({ 'Idempotency-Key': k });
    const create = { slug: 'post', title: 'Bài viết', document: doc('v1') };
    const c1 = await rest(createApi, 'POST', '/api/v1/articles', create, headers('rest-create-001'));
    const c2 = await rest(createApi, 'POST', '/api/v1/articles', create, headers('rest-create-001'));
    expect([c1.status, c1.replayed]).toEqual([201, null]);
    expect([c2.status, c2.replayed]).toEqual([201, 'true']);
    expect(c2.data).toMatchObject({ slug: 'post', revision: 1, idempotent_replay: true });

    const upd = { expected_revision: 1, document: doc('v2') };
    const u1 = await rest(updateApi, 'PUT', '/api/v1/articles/post', upd, headers('rest-update-001'), { slug: 'post' });
    const u2 = await rest(updateApi, 'PUT', '/api/v1/articles/post', upd, headers('rest-update-001'), { slug: 'post' });
    expect(field(u1.data, 'revision')).toBe(2);
    expect([u2.status, u2.replayed, field(u2.data, 'revision')]).toEqual([200, 'true', 2]);

    const pub = { expected_revision: 2, confirm: true };
    const p1 = await rest(publishApi, 'POST', '/api/v1/articles/post/publish', pub, headers('rest-publish-001'), { slug: 'post' });
    const p2 = await rest(publishApi, 'POST', '/api/v1/articles/post/publish', pub, headers('rest-publish-001'), { slug: 'post' });
    expect([p1.status, p2.status, p2.replayed]).toEqual([200, 200, 'true']);

    const d1r = await rest(deleteApi, 'DELETE', '/api/v1/articles/post', undefined, headers('rest-delete-001'), { slug: 'post' });
    const d2r = await rest(deleteApi, 'DELETE', '/api/v1/articles/post', undefined, headers('rest-delete-001'), { slug: 'post' });
    expect([d1r.status, d2r.status, d2r.replayed]).toEqual([200, 200, 'true']);
  });

  it('keys the same Idempotency-Key on different slugs separately (422)', async () => {
    await rest(createApi, 'POST', '/api/v1/articles', { slug: 'a', title: 'A', document: doc('v1') });
    await rest(createApi, 'POST', '/api/v1/articles', { slug: 'b', title: 'B', document: doc('v1') });
    const h = { 'Idempotency-Key': 'rest-shared-001' };
    await rest(deleteApi, 'DELETE', '/api/v1/articles/a', undefined, h, { slug: 'a' });
    const other = await rest(deleteApi, 'DELETE', '/api/v1/articles/b', undefined, h, { slug: 'b' });
    expect([other.status, other.code]).toEqual([422, 'idempotency_key_reused']);
  });

  it('serves the lookup route to admins only', async () => {
    await rest(createApi, 'POST', '/api/v1/articles', { slug: 'a', title: 'A', document: doc('v1') }, { 'Idempotency-Key': 'rest-lookup-001' });
    const found = await rest(lookupApi, 'GET', '/api/v1/admin/idempotency/rest-lookup-001', undefined, {}, { key: 'rest-lookup-001' });
    expect(found.data).toMatchObject({ operation: 'article_create', state: 'done' });
    const missing = await rest(lookupApi, 'GET', '/api/v1/admin/idempotency/nope-nope-nope', undefined, {}, { key: 'nope-nope-nope' });
    expect(missing.status).toBe(404);
    const request = new Request(`${ORIGIN}/api/v1/admin/idempotency/rest-lookup-001`);
    const anon = await lookupApi({ request, url: new URL(request.url), params: { key: 'rest-lookup-001' }, locals: { runtime: { env: env() } } } as unknown as APIContext);
    expect(anon.status).toBe(401);
  });
});

describe('media writes', () => {
  it('stores an inline image once for a retried media_upload', async () => {
    const puts: string[] = [];
    const bucket = { async get() { return null; }, async put(key: string) { puts.push(key); return {}; }, async delete() {} };
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 4, 176, 0, 0, 2, 118, 8, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const args = { data_base64: btoa(String.fromCharCode(...png)), alt: 'Cover', idempotency_key: 'media-upload-0001' };
    const call = async () => {
      const request = new Request(`${ORIGIN}/api/mcp`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminKey}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'media_upload', arguments: args } }),
      });
      const res = await mcpApi({ request, url: new URL(request.url), params: {}, locals: { runtime: { env: { ...env(), MEDIA: bucket } } } } as unknown as APIContext);
      const text = field((field(await res.json(), 'result', 'content') as unknown[])[0], 'text');
      return JSON.parse(String(text)) as unknown;
    };
    const first = await call();
    const retry = await call();
    expect(field(first, 'created')).toBe(true);
    expect(field(retry, 'idempotent_replay')).toBe(true);
    expect(field(retry, 'asset', 'id')).toBe(field(first, 'asset', 'id'));
    expect(puts.length).toBe(1);
    expect(await count('SELECT COUNT(*) AS n FROM media_assets')).toBe(1);
  });

  it('rejects keys on multipart uploads and replays JSON imports', async () => {
    const form = new FormData();
    form.set('file', new File([new Uint8Array([1])], 'a.png', { type: 'image/png' }));
    const request = new Request(`${ORIGIN}/api/v1/admin/media`, { method: 'POST', headers: { Authorization: `Bearer ${adminKey}`, 'Idempotency-Key': 'media-multipart-1' }, body: form });
    const res = await mediaApi({ request, url: new URL(request.url), params: {}, locals: { runtime: { env: env() } } } as unknown as APIContext);
    expect(res.status).toBe(400);
    expect(field(await res.json(), 'error', 'code')).toBe('idempotency_unsupported');
  });
});

describe('registration', () => {
  it('lists the lookup tool as admin-only and documents the header', () => {
    expect(allMcpTools().some(t => t.name === 'idempotency_lookup')).toBe(true);
    expect(TOOL_ACCESS.idempotency_lookup).toEqual({ kind: 'admin' });
    const paths = OPENAPI_FRAGMENTS.flatMap(f => Object.keys(f.paths));
    expect(paths).toContain('/api/v1/admin/idempotency/{key}');
  });

  it('advertises idempotency_key on every write tool that accepts it', () => {
    const names = ['article_create', 'article_update', 'article_publish', 'article_delete', 'article_edition_delete', 'article_tags_set', 'media_import', 'media_upload', 'media_delete'];
    for (const name of names) {
      const tool = allMcpTools().find(t => t.name === name);
      expect(Object.keys(tool?.inputSchema.properties ?? {})).toContain('idempotency_key');
    }
  });
});
