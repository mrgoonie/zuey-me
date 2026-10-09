import { beforeEach, describe, expect, it } from 'bun:test';
import type { APIContext } from 'astro';
import { createTestD1 } from './helpers/d1';
import { createApiKey, createSession } from '../src/db/store';
import type { RuntimeEnv } from '../src/env';
import { AppError } from '../src/lib/http';
import type { McpContext } from '../src/lib/mcp/types';
import { membersMcpModule } from '../src/lib/members/mcp';
import { resolvePrincipal } from '../src/lib/members/policy';
import { membersRuntime } from '../src/lib/members/runtime';
import { createMemberSession } from '../src/lib/members/session';
import { resolveStudioAccess } from '../src/lib/members/studio-access';
import { addMonths } from '../src/lib/members/subscriptions';
import { findOrCreateVerifiedUser } from '../src/lib/members/users';
import { OPENAPI_FRAGMENTS } from '../src/lib/openapi/registry';
import { TOOL_ACCESS } from '../src/lib/oauth/tool-access';
import { GET as attentionApi } from '../src/pages/api/v1/admin/billing/attention';
import { POST as resolveApi } from '../src/pages/api/v1/admin/billing/orders/[code]/resolve';
import { GET as adminMembersApi } from '../src/pages/api/v1/admin/members';
import { POST as ordersApi } from '../src/pages/api/v1/billing/orders/index';
import { GET as subscriptionApi } from '../src/pages/api/v1/billing/subscription';
import { POST as sepayWebhook } from '../src/pages/api/webhooks/sepay';

const T0 = Date.parse('2026-10-05T00:00:00.000Z');
const ORIGIN = 'https://zuey.test';
const HOUR = 60 * 60 * 1000;

type TestDb = ReturnType<typeof createTestD1>;
let d1: TestDb;
let now: number;
let emails: string[];
let txId = 9000;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function field(v: unknown, ...path: string[]): unknown {
  let cur = v;
  for (const k of path) cur = isRecord(cur) ? cur[k] : undefined;
  return cur;
}

const env = (): RuntimeEnv => ({
  DB: d1,
  PUBLIC_SITE_URL: ORIGIN,
  RESEND_API_KEY: 're_test',
  ADMIN_EMAILS: 'boss@example.com',
  USD_VND_RATE: '26350',
  SEPAY_WEBHOOK_API_KEY: 'sepay-key',
  SEPAY_BANK_ACCOUNT: '0123456789',
  SEPAY_BANK_CODE: 'MBBank',
});

interface CtxOpts { method?: string; body?: unknown; headers?: Record<string, string>; params?: Record<string, string> }

function ctx(opts: CtxOpts = {}): APIContext {
  const headers = new Headers(opts.headers ?? {});
  if (opts.body !== undefined) headers.set('Content-Type', 'application/json');
  const request = new Request(`${ORIGIN}/api/test`, { method: opts.method ?? 'GET', headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  // Handlers only read request/params/locals; a full APIContext is not constructible in tests.
  const partial = { request, params: opts.params ?? {}, url: new URL(request.url), locals: { runtime: { env: env() } } };
  return partial as unknown as APIContext;
}

async function read(res: Response): Promise<{ status: number; data: unknown; code: string | null }> {
  const body: unknown = await res.json();
  return { status: res.status, data: field(body, 'data'), code: typeof field(body, 'error', 'code') === 'string' ? String(field(body, 'error', 'code')) : null };
}

interface Member { userId: string; cookie: string; browser: Record<string, string> }

async function member(email: string): Promise<Member> {
  const { user } = await findOrCreateVerifiedUser(d1, { email });
  const { token } = await createMemberSession(d1, user.id);
  const cookie = `zuey_member=${token}`;
  return { userId: user.id, cookie, browser: { cookie, Origin: ORIGIN } };
}

/** SePay bank time (`YYYY-MM-DD HH:mm:ss`, Vietnam time) for an epoch-ms instant. */
function sepayTime(ms: number): string {
  return new Date(ms + 7 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

/** A real order flagged by the real webhook path (underpaid or late). */
async function flaggedOrder(m: Member, kind: 'underpaid' | 'late', plan = 'knowledges', months = 3): Promise<string> {
  const created = await read(await ordersApi(ctx({ method: 'POST', body: { plan, months }, headers: m.browser })));
  expect(created.status).toBe(201);
  const code = String(field(created.data, 'code'));
  const amount = Number(field(created.data, 'amount_vnd'));
  if (kind === 'late') now += 2 * HOUR;
  const id = ++txId;
  const res = await sepayWebhook(ctx({
    method: 'POST',
    headers: { Authorization: 'Apikey sepay-key' },
    body: { id, gateway: 'MBBank', transactionDate: sepayTime(now), accountNumber: '0123456789', content: code, transferType: 'in', transferAmount: kind === 'underpaid' ? amount - 1000 : amount, referenceCode: `FT${id}` },
  }));
  expect(field(await read(res), 'data')).toMatchObject({ outcome: 'needs_attention' });
  return code;
}

function resolve(code: string, body: unknown, headers: Record<string, string>) {
  return resolveApi(ctx({ method: 'POST', body, headers, params: { code } }));
}

async function entitlements(m: Member): Promise<unknown> {
  return field((await read(await subscriptionApi(ctx({ headers: { cookie: m.cookie } })))).data, 'entitlements');
}

async function activity(userId: string, action: string): Promise<Record<string, unknown>[]> {
  const { results } = await d1.prepare('SELECT detail FROM user_activity WHERE user_id = ? AND action = ? ORDER BY id').bind(userId, action).all<{ detail: string }>();
  return (results ?? []).map(r => {
    const parsed: unknown = JSON.parse(r.detail);
    return isRecord(parsed) ? parsed : {};
  });
}

beforeEach(() => {
  d1 = createTestD1();
  now = T0;
  emails = [];
  txId = 9000;
  membersRuntime.now = () => now;
  membersRuntime.fetch = async (input: string, init?: RequestInit) => {
    if (input === 'https://api.resend.com/emails') {
      const body: unknown = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
      emails.push(String(field(body, 'subject')));
      return new Response(JSON.stringify({ id: `email_${emails.length}` }), { headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('unexpected', { status: 500 });
  };
});

describe('admin attention queue', () => {
  it('requires an admin: 401 anonymous, 403 member, 200 admin member and admin key', async () => {
    const lan = await member('lan@example.com');
    const boss = await member('boss@example.com');
    const adminKey = (await createApiKey('ops', 'admin', d1)).key;
    const readKey = (await createApiKey('viewer', 'read', d1)).key;

    expect((await read(await attentionApi(ctx()))).status).toBe(401);
    expect((await read(await attentionApi(ctx({ headers: { cookie: lan.cookie } })))).code).toBe('forbidden');
    expect((await read(await attentionApi(ctx({ headers: { Authorization: `Bearer ${readKey}` } })))).status).toBe(403);
    expect((await read(await attentionApi(ctx({ headers: { cookie: boss.cookie } })))).status).toBe(200);
    expect((await read(await attentionApi(ctx({ headers: { Authorization: `Bearer ${adminKey}` } })))).status).toBe(200);

    const code = await flaggedOrder(lan, 'underpaid');
    expect((await read(await resolve(code, { action: 'activate' }, {}))).status).toBe(401);
    expect((await read(await resolve(code, { action: 'activate' }, lan.browser))).status).toBe(403);
    expect((await read(await resolve(code, { action: 'activate' }, { Authorization: `Bearer ${readKey}` }))).status).toBe(403);
    expect(await entitlements(lan)).toEqual([]);
  });

  it('lists flagged SePay orders with reason, amounts and member email, and card rows read-only', async () => {
    const lan = await member('lan@example.com');
    const under = await flaggedOrder(lan, 'underpaid');
    const late = await flaggedOrder(lan, 'late', 'ai', 1);
    await d1.prepare(
      `INSERT INTO card_subscriptions (id, provider, provider_subscription_id, user_id, plan, status, customer_email, attention_reason, created_at, updated_at)
       VALUES ('csub_x', 'dodo', 'sub_1', NULL, 'combo', 'needs_attention', 'stranger@example.com', 'metadata_missing', ?, ?)`
    ).bind(new Date(now).toISOString(), new Date(now).toISOString()).run();

    const boss = await member('boss@example.com');
    const { data } = await read(await attentionApi(ctx({ headers: { cookie: boss.cookie } })));
    const orders = field(data, 'orders');
    expect(Array.isArray(orders) ? orders.map(o => [field(o, 'code'), field(o, 'attention_reason'), field(o, 'member_email')]) : null).toEqual([
      [under, 'underpaid', 'lan@example.com'],
      [late, 'late_payment', 'lan@example.com'],
    ]);
    const first = Array.isArray(orders) ? orders[0] : null;
    expect(Number(field(first, 'amount_paid'))).toBe(Number(field(first, 'amount_vnd')) - 1000);
    expect(field(first, 'plan_name')).toBeTruthy();
    expect(typeof field(first, 'created_at')).toBe('string');

    const cards = field(data, 'card_subscriptions');
    expect(Array.isArray(cards) ? cards.map(c => [field(c, 'id'), field(c, 'member_email'), field(c, 'attention_reason')]) : null)
      .toEqual([['csub_x', 'stranger@example.com', 'metadata_missing']]);
    expect(String(field(data, 'card_note'))).toContain('Dodo');
  });
});

describe('resolving a flagged order', () => {
  it('activate grants the plan once like a paid order and is idempotent', async () => {
    const lan = await member('lan@example.com');
    const code = await flaggedOrder(lan, 'late');
    const boss = await member('boss@example.com');
    now += HOUR;
    const activatedAt = now;

    const first = await read(await resolve(code.toLowerCase(), { action: 'activate', note: '  paid late, confirmed by bank  ' }, boss.browser));
    expect(first.status).toBe(200);
    expect(field(first.data, 'outcome')).toBe('activated');
    expect(field(first.data, 'order', 'status')).toBe('paid');
    const end = new Date(addMonths(activatedAt, 3)).toISOString();
    expect(field(first.data, 'subscription', 'current_period_end')).toBe(end);
    expect(await entitlements(lan)).toEqual(['read_full']);
    expect(emails).toHaveLength(1);

    now += HOUR;
    const again = await read(await resolve(code, { action: 'activate' }, boss.browser));
    expect(field(again.data, 'outcome')).toBe('already_activated');
    const sub = await read(await subscriptionApi(ctx({ headers: { cookie: lan.cookie } })));
    const subs = field(sub.data, 'subscriptions');
    expect(Array.isArray(subs) ? field(subs[0], 'current_period_end') : null).toBe(end);
    expect(emails).toHaveLength(1);
    expect(await activity(lan.userId, 'billing.paid')).toHaveLength(1);

    const audit = await activity(lan.userId, 'billing.attention_resolved');
    expect(audit).toEqual([expect.objectContaining({ code, action: 'activate', reason: 'late_payment', note: 'paid late, confirmed by bank', admin: 'boss@example.com' })]);

    // A paid order can no longer be dismissed, and it left the queue.
    expect((await read(await resolve(code, { action: 'dismiss' }, boss.browser))).code).toBe('not_in_attention');
    const queue = (await read(await attentionApi(ctx({ headers: { cookie: boss.cookie } })))).data;
    expect(field(queue, 'orders')).toEqual([]);
  });

  it('dismiss closes the order without access, is idempotent, and can still be activated later', async () => {
    const lan = await member('lan@example.com');
    const code = await flaggedOrder(lan, 'underpaid', 'combo', 1);
    const adminKey = (await createApiKey('ops', 'admin', d1)).key;
    const auth = { Authorization: `Bearer ${adminKey}` };

    const dismissed = await read(await resolve(code, { action: 'dismiss', note: 'refunded' }, auth));
    expect(field(dismissed.data, 'outcome')).toBe('dismissed');
    expect(field(dismissed.data, 'order', 'status')).toBe('expired');
    expect(field(dismissed.data, 'order', 'attention_reason')).toBe('underpaid');
    expect(field(dismissed.data, 'subscription')).toBeNull();
    expect(await entitlements(lan)).toEqual([]);
    expect(field(await read(await resolve(code, { action: 'dismiss' }, auth)), 'data', 'outcome')).toBe('already_dismissed');
    expect(await activity(lan.userId, 'billing.attention_resolved')).toEqual([
      expect.objectContaining({ action: 'dismiss', note: 'refunded', admin: 'admin_api_key' }),
    ]);
    expect(emails).toHaveLength(0);

    const queue = (await read(await attentionApi(ctx({ headers: auth })))).data;
    expect(field(queue, 'orders')).toEqual([]);

    const reopened = await read(await resolve(code, { action: 'activate' }, auth));
    expect(field(reopened.data, 'outcome')).toBe('activated');
    expect(await entitlements(lan)).toEqual(['read_full', 'ai_chat']);
  });

  it('validates the body, rejects unknown and non-flagged orders, and enforces CSRF for member admins', async () => {
    const lan = await member('lan@example.com');
    const boss = await member('boss@example.com');
    const code = await flaggedOrder(lan, 'underpaid');
    expect((await read(await resolve(code, { action: 'refund' }, boss.browser))).code).toBe('invalid_field');
    expect((await read(await resolve(code, { action: 'activate', note: 42 }, boss.browser))).code).toBe('invalid_field');
    expect((await read(await resolve(code, { action: 'activate', note: 'x'.repeat(501) }, boss.browser))).code).toBe('invalid_field');
    expect((await read(await resolve('ZSBNOTEXIST', { action: 'activate' }, boss.browser))).status).toBe(404);

    const pending = await read(await ordersApi(ctx({ method: 'POST', body: { plan: 'ai', months: 1 }, headers: lan.browser })));
    expect((await read(await resolve(String(field(pending.data, 'code')), { action: 'activate' }, boss.browser))).status).toBe(409);

    // The session cookie alone (no Origin) cannot mutate.
    const csrf = await read(await resolve(code, { action: 'activate' }, { cookie: boss.cookie }));
    expect(csrf.code).toBe('csrf_rejected');
    expect(await entitlements(lan)).toEqual([]);
  });
});

describe('MCP admin billing tools', () => {
  function mcpCtx(key: string | null): McpContext {
    const request = new Request(`${ORIGIN}/api/mcp`, { method: 'POST', headers: key ? { Authorization: `Bearer ${key}` } : {} });
    const e = env();
    return {
      request, env: e, d1,
      async requireAdmin() { throw new AppError(401, 'unauthorized', 'Unauthorized'); },
      async isAdmin() { return false; },
      principal: () => resolvePrincipal(request, e),
    };
  }

  it('lists and resolves with an admin credential only, and is registered everywhere', async () => {
    const lan = await member('lan@example.com');
    const code = await flaggedOrder(lan, 'underpaid');
    const adminKey = (await createApiKey('ops', 'admin', d1)).key;

    const failure = async (name: string, args: Record<string, unknown>, key: string | null): Promise<number | null> => {
      try {
        await membersMcpModule.call(name, args, mcpCtx(key));
        return null;
      } catch (err) {
        return err instanceof AppError ? err.status : -1;
      }
    };
    expect(await failure('billing_attention_list', {}, null)).toBe(401);
    expect(await failure('billing_order_resolve', { code, action: 'activate' }, null)).toBe(401);

    const list = await membersMcpModule.call('billing_attention_list', {}, mcpCtx(adminKey));
    expect(JSON.stringify(list)).toContain(code);
    expect(await failure('billing_order_resolve', { code }, adminKey)).toBe(400);
    const resolved = await membersMcpModule.call('billing_order_resolve', { code, action: 'activate' }, mcpCtx(adminKey));
    expect(field(resolved, 'outcome')).toBe('activated');
    expect(await entitlements(lan)).toEqual(['read_full']);

    expect(TOOL_ACCESS.billing_attention_list).toEqual({ kind: 'admin' });
    expect(TOOL_ACCESS.billing_order_resolve).toEqual({ kind: 'admin' });
    const paths = Object.assign({}, ...OPENAPI_FRAGMENTS.map(f => f.paths));
    expect(paths['/api/v1/admin/billing/attention']).toBeDefined();
    expect(paths['/api/v1/admin/billing/orders/{code}/resolve']).toBeDefined();
  });
});

describe('Studio access for member admins', () => {
  const page = (headers: Record<string, string> = {}) => new Request(`${ORIGIN}/studio`, { headers });

  it('opens Studio for the owner session and admin members, not for other members or keys', async () => {
    const boss = await member('boss@example.com');
    const lan = await member('lan@example.com');
    const adminKey = (await createApiKey('ops', 'admin', d1)).key;
    const studioToken = await createSession('owner@zuey.me', d1);

    expect(await resolveStudioAccess(page({ cookie: boss.cookie }), env()))
      .toEqual({ authenticated: true, via: 'member_session', email: 'boss@example.com', deniedEmail: null });
    expect(await resolveStudioAccess(page({ cookie: `zuey_session=${studioToken}` }), env()))
      .toMatchObject({ authenticated: true, via: 'studio_session' });
    expect(await resolveStudioAccess(page({ cookie: lan.cookie }), env()))
      .toEqual({ authenticated: false, via: null, email: null, deniedEmail: 'lan@example.com' });
    expect((await resolveStudioAccess(page(), env())).authenticated).toBe(false);
    // Studio is a browser surface: an admin key header does not open the page.
    expect((await resolveStudioAccess(page({ Authorization: `Bearer ${adminKey}` }), env())).authenticated).toBe(false);

    // An unverified allowlisted email is not an admin.
    const { user } = await findOrCreateVerifiedUser(d1, { email: 'boss2@example.com' });
    await d1.prepare('UPDATE users SET email_verified_at = NULL WHERE id = ?').bind(user.id).run();
    const { token } = await createMemberSession(d1, user.id);
    const e = { ...env(), ADMIN_EMAILS: 'boss@example.com,boss2@example.com' };
    expect((await resolveStudioAccess(page({ cookie: `zuey_member=${token}` }), e)).authenticated).toBe(false);
  });

  it('lets an admin member call the admin APIs Studio uses; a regular member gets 403', async () => {
    const boss = await member('boss@example.com');
    const lan = await member('lan@example.com');
    expect((await read(await adminMembersApi(ctx({ headers: { cookie: boss.cookie } })))).status).toBe(200);
    expect((await read(await adminMembersApi(ctx({ headers: { cookie: lan.cookie } })))).status).toBe(403);
    expect((await read(await attentionApi(ctx({ headers: boss.browser })))).status).toBe(200);
  });
});
