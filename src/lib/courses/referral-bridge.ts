/**
 * The single seam between course orders and the referral program (src/lib/referrals).
 *
 * Contract once the referral module is present:
 * - `resolveCourseReferral` → `resolveCheckoutReferral(d1, { userId, email, enteredCode, request, product })`
 *   gives the referee discount `d` and the referrer; the order snapshots both.
 * - `onCourseOrderPaid` → `captureReferralCommission(d1, env, { kind: 'course_order', id: order.id })`
 *   for every course a referred member buys (commission base = amount actually collected, USD cents).
 * - `onCourseOrderReversed` → `reverseCommission(d1, { sourceKind: 'course_order', sourceId: order.id }, reason)`
 *   on refund, chargeback or dispute.
 *
 * Until that module ships, no referral applies: a typed code is rejected like any code that cannot apply,
 * and the hooks do nothing. Course orders already store `referrer_user_id`, `referral_code` and
 * `referral_pct`, so wiring needs no schema change.
 */
import type { D1DatabaseLike } from '../../db/store';
import type { RuntimeEnv } from '../../env';
import { AppError } from '../http';

export interface CourseReferral {
  /** Referee discount percent offered by the referral (0 when none). */
  pct: number;
  referrerUserId: string | null;
  code: string | null;
  commissionPercent: number | null;
}

export const NO_REFERRAL: CourseReferral = { pct: 0, referrerUserId: null, code: null, commissionPercent: null };

export interface CourseOrderRef { id: string; code: string; user_id: string; amount_usd_cents: number; referrer_user_id: string | null }

export async function resolveCourseReferral(
  _d1: D1DatabaseLike, _env: RuntimeEnv, _userId: string, body: Record<string, unknown>, _request?: Request,
): Promise<CourseReferral> {
  const entered = body.referral_code;
  if (entered !== undefined && entered !== null && entered !== '') {
    throw new AppError(400, 'referral_code_invalid', 'This referral code cannot be applied to your purchase', { field: 'referral_code' });
  }
  return NO_REFERRAL;
}

/** Called after a course order is paid; must never throw into the payment path. */
export async function onCourseOrderPaid(_d1: D1DatabaseLike, _env: RuntimeEnv, _order: CourseOrderRef): Promise<void> {
  // No referral program on this deployment yet.
}

/** Called after a paid course order is refunded, charged back or disputed. */
export async function onCourseOrderReversed(_d1: D1DatabaseLike, _order: CourseOrderRef, _reason: string): Promise<void> {
  // No referral program on this deployment yet.
}

export async function bindCourseReferral(_d1: D1DatabaseLike, _env: RuntimeEnv, _userId: string, _referral: CourseReferral, _request?: Request): Promise<void> {}
