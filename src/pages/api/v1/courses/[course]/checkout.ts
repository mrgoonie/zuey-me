import { jsonOk } from '../../../../../lib/http';
import { NO_STORE, memberRoute, requireJsonBody } from '../../../../../lib/members/account';
import { requireUserId } from '../../../../../lib/members/policy';
import { createCourseCheckout } from '../../../../../lib/courses/course-orders';
import { analyticsEnvFrom } from '../../../../../lib/analytics/destinations/posthog';
import { rememberGa4Client } from '../../../../../lib/analytics/ga4-attribution';

/**
 * Buy a course. Body: { provider?: 'sepay'|'dodo', accept_terms: true, referral_code? }. SePay returns a
 * VietQR transfer for a ZSC order; Dodo returns `checkout_url` for a one-time card payment.
 */
export const POST = memberRoute(async ({ request, params }, { d1, env, principal }) => {
  const userId = requireUserId(principal, 'checkout:write');
  const body = await requireJsonBody(request);
  const checkout = await createCourseCheckout(d1, env, userId, { ...body, course: params.course ?? '' }, request);
  // The browser's GA ids (only present when GA4 ran with consent) attribute the later server purchase.
  await rememberGa4Client(d1, analyticsEnvFrom(env).PUBLIC_GA4_MEASUREMENT_ID, userId, request);
  return jsonOk(checkout, 201, NO_STORE);
});
