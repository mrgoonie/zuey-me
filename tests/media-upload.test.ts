import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { APIContext } from 'astro';
import { createTestD1 } from './helpers/d1';
import { createApiKey } from '../src/db/store';
import type { R2BucketLike, RuntimeEnv } from '../src/env';
import { createArticle } from '../src/lib/blocks/articles';
import { isForbiddenCrossSiteSubmission } from '../src/lib/csrf-origin-check';
import { sniffImage } from '../src/lib/media/image-sniff';
import { mediaOpenApi } from '../src/lib/media/media-openapi';
import { membersRuntime } from '../src/lib/members/runtime';
import { POST as mcpApi } from '../src/pages/api/mcp';
import { GET as listApi, POST as createApi } from '../src/pages/api/v1/admin/media/index';
import { DELETE as deleteApi } from '../src/pages/api/v1/admin/media/[id]';
import { PUT as uploadApi } from '../src/pages/api/v1/media/uploads/[token]';

const ORIGIN = 'https://zuey.test';
const T0 = Date.parse('2026-10-12T07:00:00.000Z');

type TestDb = ReturnType<typeof createTestD1>;
let d1: TestDb;
let bucket: FakeBucket;
let adminKey: string;
let readKey: string;
const originalFetch = membersRuntime.fetch;
const originalNow = membersRuntime.now;

class FakeBucket implements R2BucketLike {
  objects = new Map<string, { bytes: Uint8Array; contentType?: string; cacheControl?: string }>();
  async get() { return null; }
  async put(key: string, value: ReadableStream | ArrayBuffer | Uint8Array | string, options?: { httpMetadata?: { contentType?: string; cacheControl?: string } }) {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array();
    this.objects.set(key, { bytes, ...options?.httpMetadata });
    return {};
  }
  async delete(keys: string | string[]) {
    for (const k of Array.isArray(keys) ? keys : [keys]) this.objects.delete(k);
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function field(v: unknown, ...keys: string[]): unknown {
  let cur: unknown = v;
  for (const k of keys) cur = isRecord(cur) ? cur[k] : undefined;
  return cur;
}

function bytes(...parts: (number[] | string)[]): Uint8Array<ArrayBuffer> {
  const out: number[] = [];
  for (const p of parts) out.push(...(typeof p === 'string' ? Array.from(p, c => c.charCodeAt(0)) : p));
  return Uint8Array.from(out);
}

const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const pad = (n: number) => new Array<number>(n).fill(0);

const png = (w: number, h: number, salt = 0) => bytes([0x89], 'PNG', [0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13], 'IHDR', be32(w), be32(h), [8, 6, 0, 0, 0, salt], pad(8));
const gif = bytes('GIF89a', [0x20, 0x03, 0x58, 0x02], pad(10));
const jpeg = bytes([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10], 'JFIF', pad(10), [0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80], pad(12));
const webp = bytes('RIFF', pad(4), 'WEBP', 'VP8X', [10, 0, 0, 0], pad(4), [0x7f, 0x07, 0x00, 0x37, 0x04, 0x00]);
const avif = bytes([0, 0, 0, 0x1c], 'ftyp', 'avif', pad(16), 'ispe', pad(4), be32(1920), be32(1080));
const svg = bytes('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));

const env = (extra: Partial<RuntimeEnv> = {}): RuntimeEnv => ({ DB: d1, MEDIA: bucket, PUBLIC_SITE_URL: ORIGIN, ...extra });

async function mcpCall(key: string | null, name: string, args: Record<string, unknown>, runtimeEnv = env()) {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (key) headers.set('Authorization', `Bearer ${key}`);
  const request = new Request(`${ORIGIN}/api/mcp`, {
    method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const res = await mcpApi({ request, url: new URL(request.url), params: {}, locals: { runtime: { env: runtimeEnv } } } as unknown as APIContext);
  const body: unknown = await res.json();
  const content = field(body, 'result', 'content');
  const text = field(Array.isArray(content) ? content[0] : undefined, 'text');
  return { status: res.status, result: typeof text === 'string' ? JSON.parse(text) as unknown : null, code: field(body, 'error', 'data', 'code') };
}

function routeCtx(path: string, init: RequestInit & { params?: Record<string, string> }): APIContext {
  const request = new Request(`${ORIGIN}${path}`, init);
  return { request, url: new URL(request.url), params: init.params ?? {}, locals: { runtime: { env: env() } } } as unknown as APIContext;
}

async function envelope(res: Response) {
  const body: unknown = await res.json();
  return { status: res.status, data: field(body, 'data'), code: field(body, 'error', 'code') };
}

beforeEach(async () => {
  d1 = createTestD1();
  bucket = new FakeBucket();
  membersRuntime.now = () => T0;
  adminKey = (await createApiKey('ops', 'admin', d1)).key;
  readKey = (await createApiKey('viewer', 'read', d1)).key;
});

afterEach(() => {
  membersRuntime.fetch = originalFetch;
  membersRuntime.now = originalNow;
});

describe('sniffImage', () => {
  it('detects supported formats and their size from the bytes', () => {
    expect(sniffImage(png(1200, 630))).toEqual({ mime: 'image/png', ext: 'png', width: 1200, height: 630 });
    expect(sniffImage(gif)).toEqual({ mime: 'image/gif', ext: 'gif', width: 800, height: 600 });
    expect(sniffImage(jpeg)).toEqual({ mime: 'image/jpeg', ext: 'jpg', width: 640, height: 480 });
    expect(sniffImage(webp)).toEqual({ mime: 'image/webp', ext: 'webp', width: 1920, height: 1080 });
    expect(sniffImage(avif)).toEqual({ mime: 'image/avif', ext: 'avif', width: 1920, height: 1080 });
  });

  it('reads AVIF listed as a compatible brand and keeps the largest ispe box', () => {
    const mif1 = bytes([0, 0, 0, 0x18], 'ftyp', 'mif1', pad(4), 'miaf', 'avif', 'ispe', pad(4), be32(320), be32(180), 'ispe', pad(4), be32(4000), be32(3000));
    expect(sniffImage(mif1)).toEqual({ mime: 'image/avif', ext: 'avif', width: 4000, height: 3000 });
  });

  it('drops sizes the image block would reject', () => {
    expect(sniffImage(png(4_000_000_000, 10))).toMatchObject({ mime: 'image/png', width: null, height: null });
  });

  it('refuses SVG and other bytes', () => {
    expect(sniffImage(svg)).toBeNull();
    expect(sniffImage(bytes('hello world, not an image'))).toBeNull();
  });
});

describe('media MCP tools', () => {
  it('stores an inline image once and returns a ready image block', async () => {
    const first = await mcpCall(adminKey, 'media_upload', { data_base64: `data:image/png;base64,${b64(png(1200, 630))}`, alt: 'Sơ đồ' });
    expect(first.status).toBe(200);
    const url = String(field(first.result, 'asset', 'url'));
    expect(url).toMatch(/^https:\/\/media\.zuey\.me\/articles\/2026\/10\/[0-9a-f]{16}\.png$/);
    expect(field(first.result, 'created')).toBe(true);
    expect(field(first.result, 'block')).toEqual({ type: 'image', url, alt: 'Sơ đồ', width: 1200, height: 630 });
    const key = url.replace('https://media.zuey.me/', '');
    expect(bucket.objects.get(key)).toMatchObject({ contentType: 'image/png', cacheControl: 'public, max-age=31536000, immutable' });

    const again = await mcpCall(adminKey, 'media_upload', { data_base64: b64(png(1200, 630)) });
    expect(field(again.result, 'created')).toBe(false);
    expect(field(again.result, 'asset', 'url')).toBe(url);
    expect(bucket.objects.size).toBe(1);
  });

  it('returns the stored asset when the same image is uploaded twice at once', async () => {
    const data = b64(png(640, 480, 7));
    const [a, b] = await Promise.all([mcpCall(adminKey, 'media_upload', { data_base64: data }), mcpCall(adminKey, 'media_upload', { data_base64: data })]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(field(a.result, 'asset', 'id')).toBe(String(field(b.result, 'asset', 'id')));
    expect([field(a.result, 'created'), field(b.result, 'created')].sort()).toEqual([false, true]);
    expect(bucket.objects.size).toBe(1);
  });

  it('is admin-only and never lets read-only keys write', async () => {
    expect((await mcpCall(null, 'media_upload', { data_base64: b64(png(10, 10)) })).status).toBe(401);
    expect((await mcpCall(readKey, 'media_upload', { data_base64: b64(png(10, 10)) })).status).toBe(403);
    expect((await mcpCall(readKey, 'media_list', {})).status).toBe(403);
    expect(bucket.objects.size).toBe(0);
  });

  it('refuses SVG and answers 503 without the MEDIA binding', async () => {
    expect((await mcpCall(adminKey, 'media_upload', { data_base64: b64(svg) })).code).toBe('unsupported_media_type');
    const missing = await mcpCall(adminKey, 'media_upload', { data_base64: b64(png(10, 10)) }, env({ MEDIA: undefined }));
    expect(missing.status).toBe(503);
    expect(missing.code).toBe('media_unconfigured');
  });

  it('imports a public https image without following redirects', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    membersRuntime.fetch = async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith('/moved.png')) return new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1/' } });
      return new Response(webp, { status: 200, headers: { 'Content-Type': 'image/webp' } });
    };
    const ok = await mcpCall(adminKey, 'media_import', { url: 'https://images.example.com/a.webp', alt: 'Ảnh' });
    expect(field(ok.result, 'asset', 'source_url')).toBe('https://images.example.com/a.webp');
    expect(field(ok.result, 'block', 'width')).toBe(1920);
    expect(calls[0].init?.redirect).toBe('manual');

    expect((await mcpCall(adminKey, 'media_import', { url: 'https://images.example.com/moved.png' })).code).toBe('media_fetch_failed');
    expect((await mcpCall(adminKey, 'media_import', { url: 'http://images.example.com/a.png' })).code).toBe('invalid_field');
  });

  it('issues a one-time upload URL that survives a wrong file and burns after success', async () => {
    const ticket = await mcpCall(adminKey, 'media_upload_url', { alt: 'Ảnh bìa' });
    const uploadUrl = String(field(ticket.result, 'upload_url'));
    expect(uploadUrl.startsWith(`${ORIGIN}/api/v1/media/uploads/`)).toBe(true);
    const token = uploadUrl.split('/').pop() ?? '';
    const put = (body: Uint8Array<ArrayBuffer>) => uploadApi(routeCtx(`/api/v1/media/uploads/${token}`, { method: 'PUT', body, params: { token } }));

    expect((await envelope(await put(svg))).code).toBe('unsupported_media_type');
    const stored = await envelope(await put(gif));
    expect(stored.status).toBe(201);
    expect(field(stored.data, 'block')).toMatchObject({ type: 'image', alt: 'Ảnh bìa', width: 800, height: 600 });
    expect(field(stored.data, 'asset', 'created_by')).toBe('admin-api-key');
    expect((await envelope(await put(png(5, 5)))).code).toBe('upload_url_invalid');

    const expired = await mcpCall(adminKey, 'media_upload_url', {});
    const t2 = String(field(expired.result, 'upload_url')).split('/').pop() ?? '';
    membersRuntime.now = () => T0 + 16 * 60 * 1000;
    const late = await envelope(await uploadApi(routeCtx(`/api/v1/media/uploads/${t2}`, { method: 'PUT', body: png(5, 5), params: { token: t2 } })));
    expect(late.status).toBe(404);
  });

  it('refuses to delete an image a current article uses', async () => {
    const up = await mcpCall(adminKey, 'media_upload', { data_base64: b64(png(300, 200)), alt: 'x' });
    const id = String(field(up.result, 'asset', 'id'));
    const url = String(field(up.result, 'asset', 'url'));
    await createArticle(d1, { slug: 'co-anh', title: 'Có ảnh', document: { version: 1, blocks: [{ id: 'i1', type: 'image', url, alt: 'x' }] } });
    const blocked = await mcpCall(adminKey, 'media_delete', { id });
    expect(blocked.status).toBe(409);
    expect(blocked.code).toBe('media_in_use');

    const cover = await mcpCall(adminKey, 'media_upload', { data_base64: b64(png(300, 200, 2)) });
    const coverUrl = String(field(cover.result, 'asset', 'url'));
    await d1.prepare("INSERT INTO courses (id, slug, title, cover_url, created_at, updated_at) VALUES ('crs_1', 'khoa-hoc', 'Khoá học', ?, ?, ?)")
      .bind(coverUrl, new Date(T0).toISOString(), new Date(T0).toISOString()).run();
    expect((await mcpCall(adminKey, 'media_delete', { id: String(field(cover.result, 'asset', 'id')) })).code).toBe('media_in_use');

    const other = await mcpCall(adminKey, 'media_upload', { data_base64: b64(png(300, 200, 1)) });
    const otherId = String(field(other.result, 'asset', 'id'));
    const done = await mcpCall(adminKey, 'media_delete', { id: otherId });
    expect(field(done.result, 'deleted')).toBe(true);
    expect(bucket.objects.size).toBe(2);
    const list = await mcpCall(adminKey, 'media_list', {});
    expect(field(list.result, 'total')).toBe(2);
  });
});

describe('media REST', () => {
  const auth = () => ({ Authorization: `Bearer ${adminKey}`, 'Content-Type': 'application/json' });

  it('uploads JSON base64, lists and deletes', async () => {
    const created = await envelope(await createApi(routeCtx('/api/v1/admin/media', {
      method: 'POST', headers: auth(), body: JSON.stringify({ data_base64: b64(jpeg), alt: 'JPEG' }),
    })));
    expect(created.status).toBe(201);
    const id = String(field(created.data, 'asset', 'id'));
    const listed = await envelope(await listApi(routeCtx('/api/v1/admin/media?q=jpeg', { method: 'GET', headers: auth() })));
    expect(field(listed.data, 'total')).toBe(1);
    const removed = await envelope(await deleteApi(routeCtx(`/api/v1/admin/media/${id}`, { method: 'DELETE', headers: auth(), params: { id } })));
    expect(field(removed.data, 'deleted')).toBe(true);
  });

  it('rejects read-only keys', async () => {
    const res = await envelope(await createApi(routeCtx('/api/v1/admin/media', {
      method: 'POST', headers: { Authorization: `Bearer ${readKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ data_base64: b64(gif) }),
    })));
    expect(res.status).toBe(403);
  });

  it('lets curl PUT to an upload URL without Origin or Content-Type', () => {
    const url = new URL(`${ORIGIN}/api/v1/media/uploads/abc`);
    expect(isForbiddenCrossSiteSubmission(new Request(url, { method: 'PUT', body: png(1, 1) }), url)).toBe(false);
    const admin = new URL(`${ORIGIN}/api/v1/admin/media`);
    expect(isForbiddenCrossSiteSubmission(new Request(admin, { method: 'POST', body: 'x' }), admin)).toBe(true);
  });

  it('documents every endpoint in OpenAPI', () => {
    expect(Object.keys(mediaOpenApi.paths).sort()).toEqual([
      '/api/v1/admin/media', '/api/v1/admin/media/reconcile', '/api/v1/admin/media/upload-url', '/api/v1/admin/media/{id}', '/api/v1/media/uploads/{token}',
    ]);
  });
});
