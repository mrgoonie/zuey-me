import { jsonOk } from '../../../../../lib/http';
import { NO_STORE, memberRoute, requireJsonBody } from '../../../../../lib/members/account';
import { requireUserId } from '../../../../../lib/members/policy';
import { createCourseCheckout } from '../../../../../lib/courses/course-orders';

/**
 * Buy a course. Body: { provider?: 'sepay'|'dodo', accept_terms: true, referral_code? }. SePay returns a
 * VietQR transfer for a ZSC order; Dodo returns `checkout_url` for a one-time card payment.
 */
export const POST = memberRoute(async ({ request, params }, { d1, env, principal }) => {
  const userId = requireUserId(principal, 'checkout:write');
  const body = await requireJsonBody(request);
  return jsonOk(await createCourseCheckout(d1, env, userId, { ...body, course: params.course ?? '' }, request), 201, NO_STORE);
});
