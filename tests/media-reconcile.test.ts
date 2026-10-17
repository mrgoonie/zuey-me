import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { APIContext } from 'astro';
import { createTestD1 } from './helpers/d1';
import { createFakeR2 } from './helpers/r2';
import { PNG_BYTES } from './helpers/r2';
import { createApiKey } from '../src/db/store';
import type { RuntimeEnv } from '../src/env';
import { AppError } from '../src/lib/http';
import { MAX_IMAGE_BYTES, sha256Hex, storeImage } from '../src/lib/media/media-asset-store';
import type { ImageBytes } from '../src/lib/media/media-asset-store';
import { parseReconcileKey, reconcileMediaObject } from '../src/lib/media/media-reconcile';
import { membersRuntime } from '../src/lib/members/runtime';
import { POST as mcpApi } from '../src/pages/api/mcp';
import { POST as reconcileApi } from '../src/pages/api/v1/admin/media/reconcile';

const ORIGIN = 'https://zuey.test';
const T0 = Date.parse('2026-10-17T07:00:00.000Z');
const KEY = 'blog/2026/10/cover.webp';

type TestDb = ReturnType<typeof createTestD1>;
let d1: TestDb;
let bucket: ReturnType<typeof createFakeR2>;
const originalNow = membersRuntime.now;
const env = (): RuntimeEnv => ({ DB: d1, MEDIA: bucket, PUBLIC_SITE_URL: ORIGIN });

/** A WebP header that declares exactly 1672×941, padded like a file. */
function webp1672x941(salt = 0): ImageBytes {
  const ascii = (s: string) => Array.from(s, c => c.charCodeAt(0));
  const header = [...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WEBP'), ...ascii('VP8X'), 10, 0, 0, 0, 0, 0, 0, 0, 0x87, 0x06, 0x00, 0xac, 0x03, 0x00];
  return Uint8Array.from([...header, ...new Array<number>(64).fill(salt)]);
}

async function putObject(key: string, bytes: Uint8Array, contentType = 'image/webp') {
  await bucket.put(key, bytes, { httpMetadata: { contentType } });
}

async function failure(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof AppError) return err;
    throw err;
  }
  throw new Error('expected an AppError');
}

const reconcile = (input: Record<string, unknown>) => reconcileMediaObject(d1, env(), input, 'api_key:ops');
const assetRows = async () => (await d1.prepare('SELECT * FROM media_assets').all()).results ?? [];

beforeEach(() => {
  d1 = createTestD1();
  bucket = createFakeR2();
  membersRuntime.now = () => T0;
});

afterEach(() => {
  membersRuntime.now = originalNow;
});

describe('media_reconcile', () => {
  it('registers a pre-existing 1672×941 WebP with its origin and actor', async () => {
    const bytes = webp1672x941();
    await putObject(KEY, bytes);
    const hash = await sha256Hex(bytes);

    const result = await reconcile({ object_key: KEY, sha256: hash, width: 1672, height: 941, alt: 'Ảnh bìa' });

    expect(result).toMatchObject({ reconciled: true, duplicate_of_existing: false, repaired: [] });
    expect(result.asset).toMatchObject({ object_key: KEY, url: `https://media.zuey.me/${KEY}`, sha256: hash, mime: 'image/webp', width: 1672, height: 941, origin: 'reconcile' });
    const [row] = await assetRows();
    expect(row).toMatchObject({ object_key: KEY, origin: 'reconcile', created_by: 'api_key:ops', source_url: null, size_bytes: bytes.length });
  });

  it('accepts the public URL form and is idempotent', async () => {
    const bytes = webp1672x941();
    await putObject(KEY, bytes);
    const hash = await sha256Hex(bytes);

    const first = await reconcile({ url: `https://media.zuey.me/${KEY}`, sha256: hash });
    const again = await reconcile({ object_key: KEY, sha256: hash.toUpperCase() });

    expect(first.reconciled).toBe(true);
    expect(again).toMatchObject({ reconciled: false, duplicate_of_existing: false });
    expect(again.asset.id).toBe(first.asset.id);
    expect(await assetRows()).toHaveLength(1);
  });

  it('refuses a sha256 or dimension mismatch and registers nothing', async () => {
    const bytes = webp1672x941();
    await putObject(KEY, bytes);
    const hash = await sha256Hex(bytes);

    const wrongHash = await failure(reconcile({ object_key: KEY, sha256: 'a'.repeat(64) }));
    expect([wrongHash.status, wrongHash.code]).toEqual([422, 'sha256_mismatch']);
    const wrongSize = await failure(reconcile({ object_key: KEY, sha256: hash, width: 1200, height: 630 }));
    expect([wrongSize.status, wrongSize.code]).toEqual([422, 'dimension_mismatch']);
    expect(await assetRows()).toHaveLength(0);
  });

  it('reports a missing object without listing the bucket', async () => {
    const err = await failure(reconcile({ object_key: 'blog/none.webp', sha256: 'a'.repeat(64) }));
    expect([err.status, err.code]).toEqual([404, 'object_not_found']);
  });

  it('refuses keys and URLs that are not plain media-origin objects', async () => {
    const hash = 'a'.repeat(64);
    const bad: Array<Record<string, unknown>> = [
      { object_key: '../secret.png' },
      { object_key: 'blog/../secret.png' },
      { object_key: '/blog/a.png' },
      { object_key: 'blog//a.png' },
      { object_key: 'blog/%2e%2e/a.png' },
      { object_key: 'Blog/a b.png' },
      { object_key: 'x'.repeat(201) },
      { object_key: 7 },
      { object_key: KEY, url: `https://media.zuey.me/${KEY}` },
      {},
      { url: `http://media.zuey.me/${KEY}` },
      { url: `https://evil.example/${KEY}` },
      { url: `https://media.zuey.me.evil.example/${KEY}` },
      { url: `https://media.zuey.me:8443/${KEY}` },
      { url: `https://user:pw@media.zuey.me/${KEY}` },
      { url: `https://media.zuey.me/${KEY}?x=1` },
      { url: `https://media.zuey.me/${KEY}#frag` },
      { url: 'https://media.zuey.me/' },
      { url: 'not a url' },
    ];
    for (const input of bad) {
      const err = await failure(reconcile({ ...input, sha256: hash }));
      expect([err.status, err.code, JSON.stringify(input).slice(0, 60)]).toEqual([400, 'invalid_field', JSON.stringify(input).slice(0, 60)]);
    }
    expect(parseReconcileKey({ url: `https://media.zuey.me/${KEY}` })).toBe(KEY);
  });

  it('validates sha256, width and height inputs', async () => {
    await putObject(KEY, webp1672x941());
    for (const input of [{ sha256: 'xyz' }, { sha256: undefined }, { sha256: 'a'.repeat(64), width: 0 }, { sha256: 'a'.repeat(64), height: 1.5 }]) {
      const err = await failure(reconcile({ object_key: KEY, ...input }));
      expect([err.status, err.code]).toEqual([400, 'invalid_field']);
    }
  });

  it('refuses a key registered with other bytes', async () => {
    const stored = (await storeImage(d1, env(), webp1672x941(1), { actor: 'test' })).asset;
    const err = await failure(reconcile({ object_key: stored.object_key, sha256: await sha256Hex(webp1672x941(2)) }));
    expect([err.status, err.code, err.extra]).toEqual([409, 'media_key_conflict', { asset_id: stored.id }]);
  });

  it('returns the existing asset when the same bytes are managed under another key', async () => {
    const bytes = webp1672x941(3);
    const stored = (await storeImage(d1, env(), bytes, { actor: 'test' })).asset;
    await putObject(KEY, bytes);

    const result = await reconcile({ object_key: KEY, sha256: await sha256Hex(bytes) });

    expect(result).toMatchObject({ reconciled: false, duplicate_of_existing: true });
    expect(result.asset.id).toBe(stored.id);
    expect(await assetRows()).toHaveLength(1);
  });

  it('rewrites a wrong content type on the same bytes and key', async () => {
    const bytes = webp1672x941();
    await putObject(KEY, bytes, 'application/octet-stream');

    const result = await reconcile({ object_key: KEY, sha256: await sha256Hex(bytes) });

    expect(result).toMatchObject({ reconciled: true, repaired: ['content_type'] });
    expect(bucket.objects.get(KEY)?.contentType).toBe('image/webp');
    expect(bucket.objects.get(KEY)?.bytes).toEqual(bytes);
  });

  it('refuses non-images, SVG and objects over the size cap', async () => {
    await putObject('blog/a.svg', new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), 'image/svg+xml');
    const svg = await failure(reconcile({ object_key: 'blog/a.svg', sha256: 'a'.repeat(64) }));
    expect(svg.status).toBe(415);

    await putObject('blog/a.txt', new TextEncoder().encode('hello'), 'text/plain');
    const text = await failure(reconcile({ object_key: 'blog/a.txt', sha256: 'a'.repeat(64) }));
    expect(text.status).toBe(415);

    const big = new Uint8Array(MAX_IMAGE_BYTES + 1);
    big.set(PNG_BYTES);
    await putObject('blog/big.png', big, 'image/png');
    const large = await failure(reconcile({ object_key: 'blog/big.png', sha256: 'a'.repeat(64) }));
    expect([large.status, large.code]).toEqual([413, 'file_too_large']);
    expect(await assetRows()).toHaveLength(0);
  });

  it('is unavailable without a media bucket', async () => {
    const err = await failure(reconcileMediaObject(d1, { DB: d1, PUBLIC_SITE_URL: ORIGIN }, { object_key: KEY, sha256: 'a'.repeat(64) }, 'x'));
    expect(err.status).toBe(503);
  });
});

describe('media_reconcile API', () => {
  async function rest(key: string | null, body: unknown) {
    const headers = new Headers({ 'Content-Type': 'application/json' });
    if (key) headers.set('Authorization', `Bearer ${key}`);
    const request = new Request(`${ORIGIN}/api/v1/admin/media/reconcile`, { method: 'POST', headers, body: JSON.stringify(body) });
    const res = await reconcileApi({ request, url: new URL(request.url), params: {}, locals: { runtime: { env: env() } } } as unknown as APIContext);
    return { status: res.status, body: await res.json() as { data?: { reconciled: boolean; asset: { origin: string } }; error?: { code: string } } };
  }

  async function mcp(key: string | null, args: Record<string, unknown>) {
    const headers = new Headers({ 'Content-Type': 'application/json' });
    if (key) headers.set('Authorization', `Bearer ${key}`);
    const request = new Request(`${ORIGIN}/api/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'media_reconcile', arguments: args } }) });
    const res = await mcpApi({ request, url: new URL(request.url), params: {}, locals: { runtime: { env: env() } } } as unknown as APIContext);
    return { status: res.status, body: await res.text() };
  }

  it('registers over REST for admins only: 201 then 200', async () => {
    const bytes = webp1672x941();
    await putObject(KEY, bytes);
    const body = { object_key: KEY, sha256: await sha256Hex(bytes), width: 1672, height: 941 };
    const admin = (await createApiKey('ops', 'admin', d1)).key;
    const reader = (await createApiKey('viewer', 'read', d1)).key;

    expect((await rest(null, body)).status).toBe(401);
    expect((await rest(reader, body)).status).toBe(403);
    expect(await assetRows()).toHaveLength(0);

    const created = await rest(admin, body);
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ reconciled: true, asset: { origin: 'reconcile' } });
    expect((await rest(admin, body)).status).toBe(200);
  });

  it('exposes the MCP tool to admins only', async () => {
    const bytes = webp1672x941();
    await putObject(KEY, bytes);
    const args = { object_key: KEY, sha256: await sha256Hex(bytes) };
    const admin = (await createApiKey('ops', 'admin', d1)).key;
    const reader = (await createApiKey('viewer', 'read', d1)).key;

    expect((await mcp(reader, args)).status).toBe(403);
    expect(await assetRows()).toHaveLength(0);
    const ok = await mcp(admin, args);
    expect(ok.status).toBe(200);
    expect(ok.body).toContain('reconcile');
    expect(await assetRows()).toHaveLength(1);
  });
});
