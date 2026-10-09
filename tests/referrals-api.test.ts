import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { APIContext, APIRoute } from 'astro';
import { createTestD1 } from './helpers/d1';
import { JPEG_BYTES, PNG_BYTES, createFakeR2 } from './helpers/r2';
import { createApiKey } from '../src/db/store';
import type { RuntimeEnv } from '../src/env';
import { AppError } from '../src/lib/http';
import { MCP_FEATURE_MODULES } from '../src/lib/mcp/registry';
import type { McpContext } from '../src/lib/mcp/types';
import { createUserKey } from '../src/lib/members/api-keys';
import { resolvePrincipal } from '../src/lib/members/policy';
import { membersRuntime } from '../src/lib/members/runtime';
import { createMemberSession } from '../src/lib/members/session';
import { findOrCreateVerifiedUser } from '../src/lib/members/users';
import { TOOL_ACCESS } from '../src/lib/oauth/tool-access';
import { OPENAPI_FRAGMENTS } from '../src/lib/openapi/registry';
import { ensureReferralProfile } from '../src/lib/referrals/codes';
import { maskDisplayName } from '../src/lib/referrals/leaderboard';
import { referralsMcpModule } from '../src/lib/referrals/mcp';
import { closePayoutPeriod, creditApprovedCommissions } from '../src/lib/referrals/jobs';
import { maskEmail } from '../src/lib/referrals/member-api';
import { POST as bindApi } from '../src/pages/api/v1/referrals/bind';
import { GET as leaderboardApi } from '../src/pages/api/v1/referrals/leaderboard';
import { GET as meGet, PATCH as mePatch } from '../src/pages/api/v1/referrals/me';
import { GET as profileGet, PUT as profilePut } from '../src/pages/api/v1/referrals/payout-profile/index';
import { PUT as imagePut } from '../src/pages/api/v1/referrals/payout-profile/id-images/[side]';
import { GET as settingsGet, PATCH as settingsPatch } from '../src/pages/api/v1/admin/referrals/settings';
import { GET as referrersGet } from '../src/pages/api/v1/admin/referrals/referrers/index';
import { PATCH as referrerPatch } from '../src/pages/api/v1/admin/referrals/referrers/[email]';
import { GET as commissionsGet } from '../src/pages/api/v1/admin/referrals/commissions/index';
import { POST as commissionAction } from '../src/pages/api/v1/admin/referrals/commissions/[id]/[action]';
import { GET as profilesGet } from '../src/pages/api/v1/admin/referrals/payout-profiles/index';
import { POST as profileAction } from '../src/pages/api/v1/admin/referrals/payout-profiles/[userId]/[action]';
import { GET as imageGet } from '../src/pages/api/v1/admin/referrals/payout-profiles/[userId]/id-images/[side]';
import { GET as payoutsGet } from '../src/pages/api/v1/admin/referrals/payouts/index';
import { GET as payoutsCsvGet } from '../src/pages/api/v1/admin/referrals/payouts.csv';
import { POST as payoutAction } from '../src/pages/api/v1/admin/referrals/payouts/[id]/[action]';

const ORIGIN = 'https://zuey.test';
const T0 = Date.parse('2026-10-05T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

let d1: ReturnType<typeof createTestD1>;
let r2: ReturnType<typeof createFakeR2>;
let now: number;
let seq = 0;

function env(): RuntimeEnv {
  return { DB: d1, REFERRAL_KYC: r2, PUBLIC_SITE_URL: ORIGIN, ADMIN_EMAILS: 'boss@example.com', USD_VND_RATE: '26350' };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function field(v: unknown, ...path: (string | number)[]): unknown {
  let cur = v;
  for (const k of path) cur = Array.isArray(cur) && typeof k === 'number' ? cur[k] : isRecord(cur) ? cur[String(k)] : undefined;
  return cur;
}

interface CtxOpts { method?: string; body?: unknown; raw?: Uint8Array; type?: string; headers?: Record<string, string>; params?: Record<string, string>; query?: string }

function ctx(opts: CtxOpts = {}): APIContext {
  const headers = new Headers(opts.headers ?? {});
  let body: BodyInit | undefined;
  if (opts.raw) {
    body = new Blob([opts.raw.slice()]);
    headers.set('Content-Type', opts.type ?? 'application/octet-stream');
  } else if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    headers.set('Content-Type', 'application/json');
  }
  const request = new Request(`${ORIGIN}/api/test${opts.query ?? ''}`, { method: opts.method ?? 'GET', headers, body });
  // Handlers only read request/params/locals; a full APIContext is not constructible in tests.
  const partial = { request, params: opts.params ?? {}, url: new URL(request.url), locals: { runtime: { env: env() } } };
  return partial as unknown as APIContext;
}

async function call(route: APIRoute, opts: CtxOpts = {}): Promise<{ status: number; data: unknown; code: string | null; res: Response }> {
  const res = await route(ctx(opts));
  const type = res.headers.get('content-type') ?? '';
  if (!type.includes('application/json')) return { status: res.status, data: null, code: null, res };
  const body: unknown = await res.clone().json();
  const code = field(body, 'error', 'code');
  return { status: res.status, data: field(body, 'data'), code: typeof code === 'string' ? code : null, res };
}

interface Member { userId: string; email: string; browser: Record<string, string> }

async function member(email: string, name?: string): Promise<Member> {
  const { user } = await findOrCreateVerifiedUser(d1, { email, name });
  const { token } = await createMemberSession(d1, user.id);
  return { userId: user.id, email, browser: { cookie: `zuey_member=${token}`, Origin: ORIGIN } };
}

async function referrerMember(email: string, name?: string): Promise<Member & { code: string }> {
  const m = await member(email, name);
  const { code } = await ensureReferralProfile(d1, m.userId);
  await d1.prepare('UPDATE referral_profiles SET admin_enabled = 1 WHERE user_id = ?').bind(m.userId).run();
  return { ...m, code };
}

async function commission(referrerId: string, opts: { status?: string; paidAt?: number; cents?: number } = {}): Promise<string> {
  const id = `rcm_api_${++seq}`;
  const paidAt = new Date(opts.paidAt ?? T0).toISOString();
  await d1.prepare(
    `INSERT INTO referral_commissions (id, source_kind, source_id, referrer_user_id, referee_email, base_amount_cents, commission_percent,
       commission_cents, status, hold_until, paid_at, created_at, updated_at)
     VALUES (?, 'billing_order', ?, ?, ?, 10000, 10, ?, ?, ?, ?, ?, ?)`
  ).bind(id, `ord_api_${seq}`, referrerId, `referee.person${seq}@example.com`, opts.cents ?? 1000, opts.status ?? 'pending',
    new Date(Date.parse(paidAt) + 30 * DAY).toISOString(), paidAt, paidAt, paidAt).run();
  return id;
}

let adminKey: string;
const admin = (): Record<string, string> => ({ Authorization: `Bearer ${adminKey}` });

beforeEach(async () => {
  d1 = createTestD1();
  r2 = createFakeR2();
  now = T0;
  membersRuntime.now = () => now;
  membersRuntime.fetch = async () => new Response(JSON.stringify({ id: 'email_1' }), { headers: { 'Content-Type': 'application/json' } });
  adminKey = (await createApiKey('ops', 'admin', d1)).key;
});

afterEach(() => {
  membersRuntime.now = () => Date.now();
});

describe('member referral endpoints', () => {
  it('GET me: 401 anonymous; a member without a plan is not eligible; a referrer gets link, rate, split and balances', async () => {
    expect((await call(meGet)).status).toBe(401);
    const plain = await member('plain@example.com');
    const notEligible = await call(meGet, { headers: plain.browser });
    expect(notEligible.status).toBe(200);
    expect(notEligible.data).toMatchObject({ eligible: false, code: null, link: null, rate: 0 });

    const ref = await referrerMember('ref@example.com');
    await commission(ref.userId, { status: 'pending', cents: 1500 });
    const approved = await commission(ref.userId, { status: 'approved', cents: 2500 });
    await creditApprovedCommissions(d1, now, approved);
    const me = await call(meGet, { headers: ref.browser });
    expect(me.res.headers.get('cache-control')).toBe('private, no-store');
    expect(me.data).toMatchObject({
      eligible: true, locked: false, code: ref.code, link: `${ORIGIN}/r/${ref.code}`, rate: 20,
      tier: { count_90d: 0, rate: 20, window_days: 90, next: { min: 3, rate: 25, remaining: 3 } },
      discount_percent: 0, membership_split: { discount_percent: 0, commission_percent: 20 }, booking_split: { discount_percent: 0, commission_percent: 10 },
      balance: { pending_cents: 1500, approved_cents: 2500, processing_cents: 0, paid_cents: 0 },
      payout_profile: null, next_close_date: '2026-11-01',
    });
    expect(field(me.data, 'commissions', 0, 'referee')).toMatch(/^re\*\*\*@example\.com$/);
    expect(JSON.stringify(me.data)).not.toContain('referee.person');
  });

  it('PATCH me validates discount ≤ R and the opt-out; unknown fields are rejected', async () => {
    const ref = await referrerMember('ref@example.com');
    const tooHigh = await call(mePatch, { method: 'PATCH', body: { discount_percent: 21 }, headers: ref.browser });
    expect(tooHigh.status).toBe(400);
    expect(tooHigh.code).toBe('invalid_field');
    expect((await call(mePatch, { method: 'PATCH', body: { discount_percent: 2.5 }, headers: ref.browser })).status).toBe(400);
    expect((await call(mePatch, { method: 'PATCH', body: { leaderboard_opt_out: 'yes' }, headers: ref.browser })).status).toBe(400);
    expect((await call(mePatch, { method: 'PATCH', body: { code: 'mine' }, headers: ref.browser })).status).toBe(400);
    expect((await call(mePatch, { method: 'PATCH', body: { discount_percent: 5 }, headers: { cookie: ref.browser.cookie } })).code).toBe('csrf_rejected');

    const ok = await call(mePatch, { method: 'PATCH', body: { discount_percent: 15, leaderboard_opt_out: true }, headers: ref.browser });
    expect(ok.status).toBe(200);
    expect(ok.data).toMatchObject({ discount_percent: 15, leaderboard_opt_out: true, membership_split: { discount_percent: 15, commission_percent: 5 }, booking_split: { discount_percent: 8, commission_percent: 2 } });

    const plain = await member('plain@example.com');
    expect((await call(mePatch, { method: 'PATCH', body: { discount_percent: 0 }, headers: plain.browser })).code).toBe('referrer_not_eligible');
  });

  it('POST bind binds an unbound, never-paid account once', async () => {
    const ref = await referrerMember('ref@example.com');
    const lan = await member('lan@example.com');
    expect((await call(bindApi, { method: 'POST', body: { code: 'zzzzzzzz' }, headers: lan.browser })).code).toBe('referral_code_invalid');
    expect((await call(bindApi, { method: 'POST', body: { code: ref.code }, headers: ref.browser })).code).toBe('referral_code_invalid');
    const bound = await call(bindApi, { method: 'POST', body: { code: ref.code.toUpperCase() }, headers: lan.browser });
    expect(bound).toMatchObject({ status: 200, data: { bound: true, code: ref.code } });
    expect((await call(bindApi, { method: 'POST', body: { code: ref.code }, headers: lan.browser })).code).toBe('referral_already_bound');
  });

  it('payout profile writes need the browser session; API keys may read', async () => {
    const ref = await referrerMember('ref@example.com');
    const details = { method: 'vn_bank', full_name: 'Nguyen Van A', bank_name: 'VCB', bank_account: '0011223344', national_id: '001234567890', address: '1 Le Loi, Q1' };
    const { secret } = await createUserKey(d1, ref.userId, { name: 'k', scopes: ['account:read', 'account:write'], expires_in_days: 30 });
    const bearer = { Authorization: `Bearer ${secret}` };
    expect((await call(profilePut, { method: 'PUT', body: details, headers: bearer })).code).toBe('session_required');
    expect((await call(profileGet, { headers: bearer })).data).toEqual({ profile: null });

    expect((await call(profilePut, { method: 'PUT', body: details, headers: ref.browser })).status).toBe(200);
    expect((await call(imagePut, { method: 'PUT', raw: JPEG_BYTES, type: 'image/jpeg', headers: bearer, params: { side: 'front' } })).code).toBe('session_required');
    expect((await call(imagePut, { method: 'PUT', raw: JPEG_BYTES, type: 'image/jpeg', headers: ref.browser, params: { side: 'left' } })).code).toBe('invalid_side');
    await call(imagePut, { method: 'PUT', raw: JPEG_BYTES, type: 'image/jpeg', headers: ref.browser, params: { side: 'front' } });
    const both = await call(imagePut, { method: 'PUT', raw: PNG_BYTES, type: 'image/png', headers: ref.browser, params: { side: 'back' } });
    expect(both.data).toMatchObject({ profile: { status: 'submitted', has_id_front: true, has_id_back: true } });
    expect((await call(meGet, { headers: ref.browser })).data).toMatchObject({ payout_profile: { status: 'submitted', method: 'vn_bank' } });
  });
});

describe('public leaderboard', () => {
  it('ranks the month by paid referred orders: top 10, masked names, opt-out and reversed/blocked excluded', async () => {
    const duy = await referrerMember('duy@example.com', 'Duy Nguyen');
    const lan = await referrerMember('lan@example.com', 'Tran Thi Lan');
    const hidden = await referrerMember('hidden@example.com', 'Hidden Person');
    const noName = await referrerMember('minh@example.com');
    const oct = Date.parse('2026-10-10T00:00:00.000Z');
    for (let i = 0; i < 3; i++) await commission(duy.userId, { status: i === 0 ? 'approved' : 'pending', paidAt: oct + i });
    await commission(duy.userId, { status: 'reversed', paidAt: oct });
    await commission(duy.userId, { status: 'blocked', paidAt: oct });
    await commission(lan.userId, { status: 'review', paidAt: oct });
    await commission(lan.userId, { status: 'pending', paidAt: oct + 10 });
    await commission(lan.userId, { status: 'pending', paidAt: Date.parse('2026-09-30T16:59:59.000Z') }); // 23:59 Sep 30 local
    for (let i = 0; i < 5; i++) await commission(hidden.userId, { paidAt: oct });
    await d1.prepare('UPDATE referral_profiles SET leaderboard_opt_out = 1 WHERE user_id = ?').bind(hidden.userId).run();
    await commission(noName.userId, { paidAt: Date.parse('2026-09-30T17:00:00.000Z') }); // 00:00 Oct 1 local
    await commission(noName.userId, { paidAt: oct + 20 });
    for (let i = 0; i < 11; i++) {
      const extra = await referrerMember(`extra${i}@example.com`, `Extra ${i}`);
      await commission(extra.userId, { paidAt: oct + 100 + i });
    }

    const res = await call(leaderboardApi, { query: '?month=2026-10' });
    expect(res.status).toBe(200);
    expect(res.res.headers.get('cache-control')).toContain('public');
    const entries = field(res.data, 'entries');
    expect(Array.isArray(entries) && entries.length).toBe(10);
    expect(field(res.data, 'month')).toBe('2026-10');
    expect(field(entries, 0)).toEqual({ rank: 1, name: 'Duy N.', referrals: 3 });
    expect(field(entries, 1)).toEqual({ rank: 2, name: 'Tran L.', referrals: 2 });
    expect(field(entries, 2)).toEqual({ rank: 2, name: 'M***', referrals: 2 });
    expect(field(entries, 3)).toEqual({ rank: 4, name: 'Extra 0.', referrals: 1 });
    expect(JSON.stringify(res.data)).not.toContain('Hidden');
    expect(JSON.stringify(res.data)).not.toContain('@');

    expect((await call(leaderboardApi, { query: '?month=2026-13' })).code).toBe('invalid_month');
    now = Date.parse('2026-10-20T00:00:00.000Z');
    expect(field((await call(leaderboardApi)).data, 'month')).toBe('2026-10');
  });

  it('masks names and emails', () => {
    expect(maskDisplayName('Duy Nguyen', 'x@y.z')).toBe('Duy N.');
    expect(maskDisplayName('Nguyễn Văn Đức', null)).toBe('Nguyễn Đ.');
    expect(maskDisplayName('  ', 'an@example.com')).toBe('A***');
    expect(maskEmail('lan.nguyen@gmail.com')).toBe('la***@gmail.com');
    expect(maskEmail('a@b.co')).toBe('a***@b.co');
  });
});

describe('admin referral endpoints', () => {
  it('require an admin: 401 anonymous, 403 member, 200 admin key and admin member', async () => {
    const plain = await member('plain@example.com');
    const boss = await member('boss@example.com');
    const routes: [APIRoute, CtxOpts][] = [
      [settingsGet, {}], [referrersGet, {}], [commissionsGet, {}], [profilesGet, {}], [payoutsGet, {}],
    ];
    for (const [route, opts] of routes) {
      expect((await call(route, opts)).status).toBe(401);
      expect((await call(route, { ...opts, headers: plain.browser })).status).toBe(403);
      expect((await call(route, { ...opts, headers: admin() })).status).toBe(200);
      expect((await call(route, { ...opts, headers: boss.browser })).status).toBe(200);
    }
    expect((await call(settingsPatch, { method: 'PATCH', body: { hold_days: 10 }, headers: plain.browser })).status).toBe(403);
  });

  it('settings and referrer updates validate input (override ≤ 50, lock needs a reason)', async () => {
    const ref = await referrerMember('ref@example.com');
    expect((await call(settingsPatch, { method: 'PATCH', body: { vn_deduction_bp: 20000 }, headers: admin() })).code).toBe('invalid_field');
    expect((await call(settingsPatch, { method: 'PATCH', body: { payout_threshold_cents: 4000 }, headers: admin() })).data).toMatchObject({ payout_threshold_cents: 4000 });

    const patch = (body: Record<string, unknown>, email = 'ref@example.com') =>
      call(referrerPatch, { method: 'PATCH', body, headers: admin(), params: { email: encodeURIComponent(email) } });
    expect((await patch({ admin_rate_override: 51 })).code).toBe('invalid_field');
    expect((await patch({ admin_rate_override: -1 })).code).toBe('invalid_field');
    expect((await patch({ locked: true })).code).toBe('invalid_field');
    expect((await patch({ nickname: 'x' })).code).toBe('invalid_field');
    expect((await patch({ admin_enabled: true }, 'nobody@example.com')).status).toBe(404);
    expect((await patch({ admin_rate_override: 40 })).data).toMatchObject({ email: 'ref@example.com', rate: 40, admin_rate_override: 40 });
    expect((await patch({ locked: true, lock_reason: 'self-dealing' })).data).toMatchObject({ lock_reason: 'self-dealing' });
    expect((await call(meGet, { headers: ref.browser })).data).toMatchObject({ eligible: false, locked: true, rate: 40 });
    expect((await patch({ locked: false, admin_rate_override: null })).data).toMatchObject({ locked_at: null, rate: 20 });

    const search = await call(referrersGet, { headers: admin(), query: `?q=${ref.code}` });
    expect(field(search.data, 'referrers', 0, 'email')).toBe('ref@example.com');
    expect((await call(referrersGet, { headers: admin(), query: '?limit=0' })).status).toBe(400);
  });

  it('works the commission review queue: approve after the hold credits, reject blocks, reverse is refund-style', async () => {
    const ref = await referrerMember('ref@example.com');
    const inHold = await commission(ref.userId, { status: 'review', paidAt: T0 });
    const matured = await commission(ref.userId, { status: 'review', paidAt: T0 - 40 * DAY, cents: 3000 });
    const fraud = await commission(ref.userId, { status: 'review', paidAt: T0 });
    const queue = await call(commissionsGet, { headers: admin(), query: '?status=review' });
    expect((field(queue.data, 'commissions') as unknown[]).length).toBe(3);
    expect((await call(commissionsGet, { headers: admin(), query: '?status=weird' })).code).toBe('invalid_status');

    const act = (id: string, action: string, body?: unknown) => call(commissionAction, { method: 'POST', body, headers: admin(), params: { id, action } });
    expect((await act(inHold, 'approve')).data).toMatchObject({ outcome: 'released_to_hold', commission: { status: 'pending' } });
    expect((await act(matured, 'approve')).data).toMatchObject({ outcome: 'approved', commission: { status: 'approved' } });
    expect((await act(fraud, 'reject', { note: 'same device' })).data).toMatchObject({ outcome: 'rejected', commission: { status: 'blocked' } });
    expect((await act(fraud, 'approve')).status).toBe(409);
    expect((await act(fraud, 'explode')).code).toBe('invalid_action');
    expect((await act('rcm_missing', 'approve')).status).toBe(404);
    expect(field((await call(meGet, { headers: ref.browser })).data, 'balance', 'approved_cents')).toBe(3000);
    expect((await act(matured, 'reverse')).data).toMatchObject({ outcome: 'reversed', commission: { status: 'reversed' } });
    expect(field((await call(meGet, { headers: ref.browser })).data, 'balance', 'approved_cents')).toBe(0);
  });

  it('reviews payout profiles through the image proxy, and approval empties the bucket', async () => {
    const ref = await referrerMember('ref@example.com');
    const details = { method: 'vn_bank', full_name: 'Nguyen Van A', bank_name: 'VCB', bank_account: '0011223344', national_id: '001234567890', address: '1 Le Loi, Q1' };
    await call(profilePut, { method: 'PUT', body: details, headers: ref.browser });
    await call(imagePut, { method: 'PUT', raw: JPEG_BYTES, type: 'image/jpeg', headers: ref.browser, params: { side: 'front' } });
    await call(imagePut, { method: 'PUT', raw: PNG_BYTES, type: 'image/png', headers: ref.browser, params: { side: 'back' } });

    const queue = await call(profilesGet, { headers: admin() });
    expect(field(queue.data, 'profiles', 0)).toMatchObject({ user_id: ref.userId, email: 'ref@example.com', status: 'submitted', has_id_front: true });
    expect(JSON.stringify(queue.data)).not.toContain('kyc/');

    expect((await call(imageGet, { params: { userId: ref.userId, side: 'front' } })).status).toBe(401);
    expect((await call(imageGet, { headers: ref.browser, params: { userId: ref.userId, side: 'front' } })).status).toBe(403);
    const image = await call(imageGet, { headers: admin(), params: { userId: ref.userId, side: 'front' } });
    expect(image.status).toBe(200);
    expect(image.res.headers.get('cache-control')).toBe('no-store');
    expect(image.res.headers.get('content-type')).toBe('image/jpeg');
    expect(new Uint8Array(await image.res.arrayBuffer())).toEqual(JPEG_BYTES);
    const audit = await d1.prepare("SELECT actor, subject_user_id FROM referral_events WHERE action = 'payout_profile.image_viewed'").first();
    expect(audit).toEqual({ actor: 'admin-api-key', subject_user_id: ref.userId });

    expect((await call(profileAction, { method: 'POST', headers: admin(), params: { userId: ref.userId, action: 'reject' } })).status).toBe(400);
    const approved = await call(profileAction, { method: 'POST', headers: admin(), params: { userId: ref.userId, action: 'approve' } });
    expect(approved.data).toMatchObject({ status: 'verified', has_id_front: false, has_id_back: false });
    expect(r2.objects.size).toBe(0);
    expect((await call(imageGet, { headers: admin(), params: { userId: ref.userId, side: 'front' } })).status).toBe(404);
  });

  it('lists, exports, pays and cancels payouts', async () => {
    const ref = await referrerMember('ref@example.com');
    await d1.prepare(
      `INSERT INTO referral_payout_profiles (user_id, method, paypal_email, status, created_at, updated_at) VALUES (?, 'paypal', 'pp@example.com', 'verified', ?, ?)`
    ).bind(ref.userId, new Date(T0).toISOString(), new Date(T0).toISOString()).run();
    const c = await commission(ref.userId, { status: 'approved', cents: 9000 });
    now = Date.parse('2026-10-31T18:00:00.000Z');
    await creditApprovedCommissions(d1, now, c);
    const [payout] = (await closePayoutPeriod(d1, env(), now)).created;

    const list = await call(payoutsGet, { headers: admin(), query: '?period=2026-10' });
    expect(field(list.data, 'payouts', 0)).toMatchObject({ id: payout.id, email: 'ref@example.com', net_cents: 7380, payee: { paypal_email: 'pp@example.com' } });
    expect((await call(payoutsGet, { headers: admin(), query: '?period=Oct' })).code).toBe('invalid_period');

    const csv = await call(payoutsCsvGet, { headers: admin(), query: '?period=2026-10' });
    expect(csv.status).toBe(200);
    expect(csv.res.headers.get('content-type')).toContain('text/csv');
    expect(csv.res.headers.get('content-disposition')).toContain('referral-payouts-2026-10.csv');
    expect(await csv.res.text()).toContain('"pp@example.com"');
    expect((await call(payoutsCsvGet, { headers: admin() })).code).toBe('invalid_period');

    const act = (action: string, body?: unknown) => call(payoutAction, { method: 'POST', body, headers: admin(), params: { id: payout.id, action } });
    expect((await act('paid', {})).code).toBe('invalid_field');
    expect((await act('refund')).status).toBe(404);
    expect((await act('paid', { transaction_ref: 'PP-1' })).data).toMatchObject({ outcome: 'paid', payout: { status: 'paid', transaction_ref: 'PP-1', paid_by: 'admin-api-key' } });
    expect((await act('cancel')).code).toBe('payout_paid');
    expect(field((await call(meGet, { headers: ref.browser })).data, 'balance')).toMatchObject({ paid_cents: 9000, approved_cents: 0, processing_cents: 0 });
  });
});

describe('OpenAPI and MCP registration', () => {
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

  it('documents every referral path', () => {
    const paths = Object.assign({}, ...OPENAPI_FRAGMENTS.map(f => f.paths));
    for (const p of [
      '/api/v1/referrals/me', '/api/v1/referrals/bind', '/api/v1/referrals/quote', '/api/v1/referrals/payout-profile',
      '/api/v1/referrals/payout-profile/id-images/{side}', '/api/v1/referrals/leaderboard', '/api/v1/referrals/jobs/run',
      '/api/v1/admin/referrals/settings', '/api/v1/admin/referrals/referrers', '/api/v1/admin/referrals/referrers/{email}',
      '/api/v1/admin/referrals/commissions', '/api/v1/admin/referrals/commissions/{id}/{action}', '/api/v1/admin/referrals/payout-profiles',
      '/api/v1/admin/referrals/payout-profiles/{userId}/id-images/{side}', '/api/v1/admin/referrals/payout-profiles/{userId}/{action}',
      '/api/v1/admin/referrals/payouts', '/api/v1/admin/referrals/payouts.csv', '/api/v1/admin/referrals/payouts/{id}/{action}',
    ]) expect(paths[p]).toBeDefined();
  });

  it('registers admin-only MCP tools that never return images', async () => {
    const names = referralsMcpModule.tools.map(t => t.name);
    expect(names).toEqual([
      'referral_settings_get', 'referral_settings_set', 'referral_referrer_update', 'referral_review_list',
      'referral_commission_decide', 'referral_payouts_list', 'referral_payout_mark_paid', 'referral_leaderboard',
    ]);
    expect(MCP_FEATURE_MODULES).toContain(referralsMcpModule);
    for (const n of names) expect(TOOL_ACCESS[n]).toEqual({ kind: 'admin' });

    const failure = async (name: string, args: Record<string, unknown>, key: string | null): Promise<number | null> => {
      try {
        await referralsMcpModule.call(name, args, mcpCtx(key));
        return null;
      } catch (err) {
        return err instanceof AppError ? err.status : -1;
      }
    };
    expect(await failure('referral_settings_get', {}, null)).toBe(401);
    const ref = await referrerMember('ref@example.com');
    const { secret } = await createUserKey(d1, ref.userId, { name: 'k', scopes: ['account:read'], expires_in_days: 30 });
    expect(await failure('referral_review_list', {}, secret)).toBe(403);

    await call(profilePut, { method: 'PUT', body: { method: 'vn_bank', full_name: 'Nguyen Van A', bank_name: 'VCB', bank_account: '0011223344', national_id: '001234567890', address: '1 Le Loi, Q1' }, headers: ref.browser });
    await call(imagePut, { method: 'PUT', raw: JPEG_BYTES, type: 'image/jpeg', headers: ref.browser, params: { side: 'front' } });
    const review = await referralsMcpModule.call('referral_review_list', {}, mcpCtx(adminKey));
    expect(field(review, 'payout_profiles')).toEqual([]); // draft until both sides are uploaded
    await call(imagePut, { method: 'PUT', raw: JPEG_BYTES, type: 'image/jpeg', headers: ref.browser, params: { side: 'back' } });
    const review2 = await referralsMcpModule.call('referral_review_list', {}, mcpCtx(adminKey));
    expect(field(review2, 'payout_profiles', 0, 'has_id_front')).toBe(true);
    expect(JSON.stringify(review2)).not.toContain('kyc/');

    const updated = await referralsMcpModule.call('referral_referrer_update', { email: 'ref@example.com', admin_rate_override: 30 }, mcpCtx(adminKey));
    expect(field(updated, 'rate')).toBe(30);
    expect(await failure('referral_referrer_update', { email: 'ref@example.com', admin_rate_override: 60 }, adminKey)).toBe(400);
    expect(field(await referralsMcpModule.call('referral_settings_set', { hold_days: 14 }, mcpCtx(adminKey)), 'hold_days')).toBe(14);
    expect(field(await referralsMcpModule.call('referral_leaderboard', {}, mcpCtx(adminKey)), 'month')).toBe('2026-10');
    expect(field(await referralsMcpModule.call('referral_payouts_list', { period: '2026-10' }, mcpCtx(adminKey)), 'payouts')).toEqual([]);
    expect(await failure('referral_payout_mark_paid', { id: 'rpo_missing', transaction_ref: 'x' }, adminKey)).toBe(404);
    expect(await failure('referral_commission_decide', { id: 'rcm_missing', action: 'approve' }, adminKey)).toBe(404);
  });
});
