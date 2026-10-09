import type { D1DatabaseLike } from '../../db/store';
import type { RuntimeEnv } from '../../env';
import { ipHash } from '../members/login-tokens';
import type { Row } from '../members/runtime';
import { nowIso, safeNextPath, strOrNull } from '../members/runtime';
import { readCookie } from '../members/session';
import { getReferralProfileByCode, normalizeReferralCode } from './codes';
import type { ReferralProfile } from './codes';
import { getReferralSettings } from './config';
import { isActiveReferrer, isEligibleReferee, isSelfReferral } from './eligibility';
import { logReferralEvent } from './ledger';

/**
 * Attribution: `/r/{code}` (no-store redirect) drops a first-touch `zr_ref` cookie; the referrer is bound
 * permanently when the visitor's member account is created, or by entering a code at checkout while unbound.
 * Cacheable pages never set this cookie: a cached Set-Cookie would attribute everyone to one referrer.
 */
export const REF_COOKIE = 'zr_ref';

/** The normalized code in the attribution cookie, or null when absent or malformed. */
export function readRefCookie(request: Request): string | null {
  return normalizeReferralCode(readCookie(request, REF_COOKIE));
}

export function refCookieHeader(code: string, days: number): string {
  return `${REF_COOKIE}=${encodeURIComponent(code)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.max(Math.trunc(days), 1) * 86400}`;
}

export function clearRefCookieHeader(): string {
  return `${REF_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

/** Profile behind a code only while it can refer: known, not locked, owner admin-enabled or on an active plan. */
export async function activeReferrerByCode(d1: D1DatabaseLike, code: unknown): Promise<ReferralProfile | null> {
  const profile = await getReferralProfileByCode(d1, code);
  if (!profile || profile.locked_at) return null;
  return (await isActiveReferrer(d1, profile.user_id)) ? profile : null;
}

/**
 * GET /r/{code}: 302 to `next` (same-site path, default `/`) with `Cache-Control: no-store`. Sets the cookie
 * only for an active referrer's code and never replaces a still-valid earlier cookie (first touch wins).
 */
export async function handleReferralLink(d1: D1DatabaseLike | undefined, request: Request, rawCode: unknown): Promise<Response> {
  const next = safeNextPath(new URL(request.url).searchParams.get('next'), '/');
  const headers = new Headers({ Location: next, 'Cache-Control': 'no-store' });
  if (d1) {
    try {
      const profile = await activeReferrerByCode(d1, rawCode);
      const current = readRefCookie(request);
      const keep = current !== null && current !== profile?.code && (await activeReferrerByCode(d1, current)) !== null;
      if (profile && !keep) {
        const { cookie_days } = await getReferralSettings(d1);
        headers.append('Set-Cookie', refCookieHeader(profile.code, cookie_days));
      }
    } catch (err) {
      // A broken referral lookup must never break the visitor's navigation.
      console.error('referral link lookup failed:', err instanceof Error ? err.message : 'unknown');
    }
  }
  return new Response(null, { status: 302, headers });
}

async function bindReferrer(
  d1: D1DatabaseLike, userId: string, referrerUserId: string, signupIpHash: string | null, via: 'signup' | 'checkout_code',
): Promise<boolean> {
  const now = nowIso();
  const res = await d1.prepare(
    `UPDATE users SET referred_by_user_id = ?, referred_at = ?, referral_signup_ip_hash = COALESCE(?, referral_signup_ip_hash), updated_at = ?
     WHERE id = ? AND deleted_at IS NULL AND referred_by_user_id IS NULL`
  ).bind(referrerUserId, now, signupIpHash, now, userId).run();
  const bound = res.meta?.changes === 1;
  if (bound) await logReferralEvent(d1, { actor: `user:${userId}`, action: 'referral.bound', subjectUserId: referrerUserId, detail: { referee_user_id: userId, via } });
  return bound;
}

/**
 * Call right after a member account is CREATED (magic link or OAuth). Binds the cookie's referrer when it is
 * active and not the new member themselves, stores the hashed signup IP for fraud review, and returns the
 * Set-Cookie value that clears the attribution cookie (null when there was none). Never throws.
 */
export async function bindReferrerOnSignup(
  d1: D1DatabaseLike, user: { id: string; email: string }, request: Request, env: RuntimeEnv,
): Promise<string | null> {
  const code = readRefCookie(request);
  if (!code) return null;
  try {
    const profile = await activeReferrerByCode(d1, code);
    if (profile && !(await isSelfReferral(d1, profile.user_id, { userId: user.id, email: user.email }))) {
      await bindReferrer(d1, user.id, profile.user_id, await ipHash(env, request), 'signup');
    }
  } catch (err) {
    // Attribution is best-effort: sign-up must succeed even if the referral write fails.
    console.error('referral binding failed:', err instanceof Error ? err.message : 'unknown');
  }
  return clearRefCookieHeader();
}

export type BindByCodeResult =
  | { bound: true; referrerUserId: string }
  | { bound: false; reason: 'already_bound' | 'invalid_code' | 'self_referral' | 'not_eligible' };

/**
 * Checkout or Referral-app code entry: binds only an unbound, never-paid member to an active referrer that is
 * not themselves. `ipHash` (salted, see `ipHash`) is stored like a signup IP for the shared-IP fraud check.
 */
export async function bindReferrerByCode(d1: D1DatabaseLike, userId: string, code: unknown, ipHash: string | null = null): Promise<BindByCodeResult> {
  const user = await d1.prepare('SELECT email, referred_by_user_id FROM users WHERE id = ? AND deleted_at IS NULL').bind(userId).first<Row>();
  if (!user) return { bound: false, reason: 'not_eligible' };
  if (strOrNull(user, 'referred_by_user_id')) return { bound: false, reason: 'already_bound' };
  const profile = await activeReferrerByCode(d1, code);
  if (!profile) return { bound: false, reason: 'invalid_code' };
  if (await isSelfReferral(d1, profile.user_id, { userId })) return { bound: false, reason: 'self_referral' };
  if (!(await isEligibleReferee(d1, { userId }))) return { bound: false, reason: 'not_eligible' };
  if (!(await bindReferrer(d1, userId, profile.user_id, ipHash, 'checkout_code'))) return { bound: false, reason: 'already_bound' };
  return { bound: true, referrerUserId: profile.user_id };
}
