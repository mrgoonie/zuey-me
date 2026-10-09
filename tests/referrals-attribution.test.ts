import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { APIContext } from 'astro';
import { createTestD1 } from './helpers/d1';
import { hashString } from '../src/db/store';
import type { RuntimeEnv } from '../src/env';
import { membersRuntime, safeNextPath } from '../src/lib/members/runtime';
import { deleteAccount, findOrCreateVerifiedUser, getUserById } from '../src/lib/members/users';
import { REF_COOKIE, bindReferrerByCode, bindReferrerOnSignup, readRefCookie } from '../src/lib/referrals/attribution';
import { ensureReferralProfile } from '../src/lib/referrals/codes';
import { isEligibleReferee } from '../src/lib/referrals/eligibility';
import { resolveReferralForCheckout } from '../src/lib/referrals/resolve-checkout-referral';
import { POST as verifyApi } from '../src/pages/api/members/auth/magic-link/verify';
import { GET as referralLinkRoute } from '../src/pages/r/[code]';

const ORIGIN = 'https://zuey.test';
const T0 = Date.parse('2026-10-09T03:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
let d1: ReturnType<typeof createTestD1>;
let env: RuntimeEnv;

beforeEach(() => {
  d1 = createTestD1();
  env = { DB: d1, MEMBER_HASH_SALT: 'salt' };
  membersRuntime.now = () => T0;
});

afterEach(() => {
  membersRuntime.now = () => Date.now();
});

function at(ms: number): string {
  return new Date(ms).toISOString();
}

async function member(email: string): Promise<string> {
  return (await findOrCreateVerifiedUser(d1, { email })).user.id;
}

/** A referrer with an active plan (until `days` from T0) and a known discount; returns id and code. */
async function referrer(email: string, discount = 10, days = 30): Promise<{ id: string; code: string }> {
  const id = await member(email);
  await d1.prepare("INSERT INTO subscriptions (id, user_id, plan, status, current_period_end, created_at, updated_at) VALUES (?, ?, 'combo', 'active', ?, ?, ?)")
    .bind(`sub_${id}`, id, at(T0 + days * DAY), at(T0), at(T0)).run();
  const { code } = await ensureReferralProfile(d1, id);
  await d1.prepare('UPDATE referral_profiles SET discount_percent = ? WHERE user_id = ?').bind(discount, id).run();
  return { id, code };
}

function request(path: string, cookie?: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  if (cookie) headers.set('Cookie', cookie);
  headers.set('cf-connecting-ip', '203.0.113.7');
  return new Request(`${ORIGIN}${path}`, { ...init, headers });
}

function ctx(req: Request, params: Record<string, string> = {}): APIContext {
  // Handlers only read request/params/locals; a full APIContext is not constructible in tests.
  const partial = { request: req, params, locals: { runtime: { env } }, url: new URL(req.url) };
  return partial as unknown as APIContext;
}

async function follow(code: string, cookie?: string, next = ''): Promise<Response> {
  return referralLinkRoute(ctx(request(`/r/${code}${next}`, cookie), { code }));
}

describe('referral link /r/{code}', () => {
  it('sets a 30-day first-touch cookie only for an active referrer', async () => {
    const { code } = await referrer('ref@example.com');
    const res = await follow(code.toUpperCase(), undefined, '?next=/pricing');
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/pricing');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const cookie = res.headers.get('Set-Cookie') ?? '';
    expect(cookie).toContain(`${REF_COOKIE}=${code}`);
    expect(cookie).toContain('Max-Age=2592000');
    expect(cookie).toContain('HttpOnly');

    const unknown = await follow('zzzzzzzz', undefined, '?next=//evil.test');
    expect(unknown.headers.get('Location')).toBe('/');
    expect(unknown.headers.get('Set-Cookie')).toBeNull();
  });

  it('ignores locked and lapsed referrers and keeps a valid earlier cookie', async () => {
    const first = await referrer('first@example.com');
    const second = await referrer('second@example.com');
    const keep = await follow(second.code, `${REF_COOKIE}=${first.code}`);
    expect(keep.headers.get('Set-Cookie')).toBeNull();

    await d1.prepare("UPDATE referral_profiles SET locked_at = ? WHERE user_id = ?").bind(at(T0), first.id).run();
    const replace = await follow(second.code, `${REF_COOKIE}=${first.code}`);
    expect(replace.headers.get('Set-Cookie')).toContain(second.code);
    expect((await follow(first.code)).headers.get('Set-Cookie')).toBeNull();

    membersRuntime.now = () => T0 + 31 * DAY;
    expect((await follow(second.code)).headers.get('Set-Cookie')).toBeNull();
  });
});

describe('binding on sign-up', () => {
  it('binds a newly created member from the magic-link verify route and clears the cookie', async () => {
    const { id: refId, code } = await referrer('ref@example.com');
    const token = 'tok_referral_magic_link_123456';
    await d1.prepare(
      `INSERT INTO login_tokens (id, token_hash, purpose, email, user_id, ip_hash, next_path, created_at, expires_at)
       VALUES ('lt_1', ?, 'magic_link', 'new@example.com', NULL, NULL, '/pricing', ?, ?)`
    ).bind(await hashString(token), at(T0), at(T0 + 10 * 60 * 1000)).run();
    const req = request('/api/members/auth/magic-link/verify', `${REF_COOKIE}=${code}`, {
      method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify({ token }),
    });
    const res = await verifyApi(ctx(req));
    expect(res.status).toBe(200);
    const cookies = res.headers.getSetCookie().join('\n');
    expect(cookies).toContain('zuey_member=');
    expect(cookies).toContain(`${REF_COOKIE}=; `);
    const row = d1.raw.query("SELECT referred_by_user_id, referral_signup_ip_hash FROM users WHERE email = 'new@example.com'").get();
    expect(row).toMatchObject({ referred_by_user_id: refId });
    expect(row && typeof row === 'object' && 'referral_signup_ip_hash' in row ? row.referral_signup_ip_hash : null).toMatch(/^[0-9a-f]{64}$/);
  });

  it('never rebinds and ignores the member’s own code', async () => {
    const a = await referrer('a@example.com');
    const b = await referrer('b@example.com');
    const user = (await findOrCreateVerifiedUser(d1, { email: 'x@example.com' })).user;
    await bindReferrerOnSignup(d1, user, request('/', `${REF_COOKIE}=${a.code}`), env);
    await bindReferrerOnSignup(d1, user, request('/', `${REF_COOKIE}=${b.code}`), env);
    expect(d1.raw.query('SELECT referred_by_user_id FROM users WHERE id = ?').get(user.id)).toMatchObject({ referred_by_user_id: a.id });
    expect(await bindReferrerByCode(d1, user.id, b.code)).toEqual({ bound: false, reason: 'already_bound' });

    const self = (await findOrCreateVerifiedUser(d1, { email: 'a+alt@example.com' })).user;
    expect(await bindReferrerOnSignup(d1, self, request('/', `${REF_COOKIE}=${a.code}`), env)).toContain('Max-Age=0');
    expect(d1.raw.query('SELECT referred_by_user_id FROM users WHERE id = ?').get(self.id)).toMatchObject({ referred_by_user_id: null });
    expect(await bindReferrerOnSignup(d1, self, request('/'), env)).toBeNull();
    expect(readRefCookie(request('/', `${REF_COOKIE}=bad!code`))).toBeNull();
  });

  it('binds by checkout code only for an unbound, never-paid member', async () => {
    const { id: refId, code } = await referrer('ref@example.com');
    const fresh = await member('fresh@example.com');
    expect(await bindReferrerByCode(d1, fresh, 'nope12')).toEqual({ bound: false, reason: 'invalid_code' });
    expect(await bindReferrerByCode(d1, refId, code)).toEqual({ bound: false, reason: 'self_referral' });
    expect(await bindReferrerByCode(d1, fresh, code)).toEqual({ bound: true, referrerUserId: refId });

    const paid = await member('paid@example.com');
    await d1.prepare(
      `INSERT INTO billing_orders (id, code, user_id, plan, months, amount_usd_cents, usd_vnd_rate, amount_vnd, status, expires_at, paid_at, created_at, updated_at)
       VALUES ('bo1', 'ZM1', ?, 'ai', 1, 1900, 26000, 494000, 'paid', ?, ?, ?, ?)`
    ).bind(paid, at(T0), at(T0), at(T0), at(T0)).run();
    expect(await bindReferrerByCode(d1, paid, code)).toEqual({ bound: false, reason: 'not_eligible' });
  });

  it('records the hashed client IP of a checkout-code binding for the shared-IP check', async () => {
    const { code } = await referrer('ref@example.com');
    const fresh = await member('fresh@example.com');
    await bindReferrerByCode(d1, fresh, code, 'iphash-1');
    const row = await d1.prepare('SELECT referral_signup_ip_hash FROM users WHERE id = ?').bind(fresh).first<{ referral_signup_ip_hash: string }>();
    expect(row?.referral_signup_ip_hash).toBe('iphash-1');
  });
});

describe('redirect target of /r/{code}', () => {
  it('only follows same-site paths', async () => {
    const { code } = await referrer('ref@example.com');
    for (const next of ['/%09/evil.com', '/%5Cevil.com', '//evil.com', '/\\evil.com', 'https://evil.com', '%2F%2Fevil.com']) {
      const res = await follow(code, undefined, `?next=${next}`);
      expect(res.headers.get('Location')).toBe('/');
    }
    expect((await follow(code, undefined, '?next=/pricing%3Fplan%3Dai')).headers.get('Location')).toBe('/pricing?plan=ai');
  });

  it('safeNextPath rejects control characters, whitespace, backslashes and other origins', () => {
    for (const bad of ['/\t/evil.com', '/\n/evil.com', '/ /evil.com', '/\\evil.com', '//evil.com', '///evil.com', 'evil.com', '', '/'.padEnd(301, 'a')]) {
      expect(safeNextPath(bad, '/fallback')).toBe('/fallback');
    }
    expect(safeNextPath(null)).toBe('/account');
    expect(safeNextPath('/%09/evil.com')).toBe('/%09/evil.com');
    expect(safeNextPath('  /account/billing?tab=1#top  ')).toBe('/account/billing?tab=1#top');
    expect(safeNextPath('/a/../b')).toBe('/b');
  });
});

describe('deleted accounts', () => {
  it('keeps a paying mailbox ineligible after the account is deleted and re-registered', async () => {
    const paid = await member('jane.doe@gmail.com');
    await d1.prepare(
      `INSERT INTO billing_orders (id, code, user_id, plan, months, amount_usd_cents, usd_vnd_rate, amount_vnd, status, expires_at, paid_at, created_at, updated_at)
       VALUES ('bo1', 'ZM1', ?, 'ai', 1, 1900, 26000, 494000, 'paid', ?, ?, ?, ?)`
    ).bind(paid, at(T0), at(T0), at(T0), at(T0)).run();
    const user = await getUserById(d1, paid);
    if (!user) throw new Error('user missing');
    await deleteAccount(d1, user, env);
    expect(await isEligibleReferee(d1, { email: 'jane.doe@gmail.com' })).toBe(false);
    const again = await member('janedoe+new@googlemail.com');
    expect(await isEligibleReferee(d1, { userId: again })).toBe(false);

    // A deleted account that never paid leaves no trace.
    const never = await member('never@example.com');
    const neverUser = await getUserById(d1, never);
    if (!neverUser) throw new Error('user missing');
    await deleteAccount(d1, neverUser, env);
    expect(await isEligibleReferee(d1, { userId: await member('never@example.com') })).toBe(true);
  });
});

describe('referee eligibility and checkout resolution', () => {
  async function confirmedBooking(email: string): Promise<void> {
    await d1.prepare(
      `INSERT INTO bookings (id, code, slot_start, slot_end, duration_min, status, hold_expires_at, guest_name, guest_email, payment_method, manage_token_hash, created_at, updated_at)
       VALUES ('bk1', 'BK1', ?, ?, 60, 'confirmed', ?, 'Guest', ?, 'paypal', 'h', ?, ?)`
    ).bind(at(T0 - DAY), at(T0 - DAY + 3600000), at(T0 - DAY), email, at(T0 - 2 * DAY), at(T0 - 2 * DAY)).run();
  }

  it('treats any earlier paid order on the same canonical mailbox as ineligible', async () => {
    expect(await isEligibleReferee(d1, { email: 'jane.doe@gmail.com' })).toBe(true);
    await confirmedBooking('JaneDoe+consult@googlemail.com');
    expect(await isEligibleReferee(d1, { email: 'jane.doe@gmail.com' })).toBe(false);
    const id = await member('j.a.n.e.doe@gmail.com');
    expect(await isEligibleReferee(d1, { userId: id })).toBe(false);
    await d1.prepare(
      "INSERT INTO card_subscriptions (id, provider, user_id, plan, status, customer_email, created_at, updated_at) VALUES ('cs1', 'dodo', NULL, NULL, 'cancelled', 'card@example.com', ?, ?)"
    ).bind(at(T0), at(T0)).run();
    expect(await isEligibleReferee(d1, { email: 'card@example.com' })).toBe(true);
    await d1.prepare("UPDATE card_subscriptions SET first_payment_id = 'pay_1' WHERE id = 'cs1'").run();
    expect(await isEligibleReferee(d1, { email: 'card@example.com' })).toBe(false);
  });

  it('resolves membership terms from the binding and ignores a typed code once bound', async () => {
    const a = await referrer('a@example.com', 15);
    const b = await referrer('b@example.com', 5);
    const user = await member('buyer@example.com');
    await bindReferrerByCode(d1, user, a.code);
    const terms = await resolveReferralForCheckout(d1, { userId: user, email: 'buyer@example.com', enteredCode: b.code, product: 'membership' });
    expect(terms).toEqual({ referrerUserId: a.id, code: a.code, rate: 20, discountPercent: 15, commissionPercent: 5, source: 'bound' });
  });

  it('returns null for a lapsed referrer, a self-referral or a previously paid payer', async () => {
    const a = await referrer('a@example.com', 10, 5);
    const user = await member('buyer@example.com');
    expect(await resolveReferralForCheckout(d1, { userId: user, email: 'buyer@example.com', cookieCode: a.code, product: 'membership' })).not.toBeNull();
    expect(await resolveReferralForCheckout(d1, { userId: a.id, email: 'a@example.com', cookieCode: a.code, product: 'membership' })).toBeNull();
    expect(await resolveReferralForCheckout(d1, { email: 'A+x@example.com', enteredCode: a.code, product: 'booking' })).toBeNull();
    membersRuntime.now = () => T0 + 6 * DAY;
    expect(await resolveReferralForCheckout(d1, { userId: user, email: 'buyer@example.com', cookieCode: a.code, product: 'membership' })).toBeNull();
  });

  it('resolves a booking guest by cookie or typed code plus email with the booking split', async () => {
    const a = await referrer('a@example.com', 10);
    const viaCookie = await resolveReferralForCheckout(d1, { email: 'guest@example.com', cookieCode: a.code, product: 'booking' });
    expect(viaCookie).toEqual({ referrerUserId: a.id, code: a.code, rate: 20, discountPercent: 5, commissionPercent: 5, source: 'cookie' });
    const typed = await resolveReferralForCheckout(d1, { email: 'guest@example.com', enteredCode: a.code.toUpperCase(), cookieCode: 'unknown1', product: 'booking' });
    expect(typed?.source).toBe('entered');
    await confirmedBooking('guest@example.com');
    expect(await resolveReferralForCheckout(d1, { email: 'guest@example.com', cookieCode: a.code, product: 'booking' })).toBeNull();
  });
});
