import type { APIRoute } from 'astro';
import { handleReferralLink } from '../../lib/referrals/attribution';

/**
 * Referral link `https://zuey.me/r/{code}`: a no-store 302 that sets the `zr_ref` attribution cookie for an
 * active referrer's code. The only place that cookie is written (cacheable pages must never Set-Cookie).
 */
export const GET: APIRoute = async ({ request, params, locals }) => {
  return handleReferralLink(locals.runtime?.env?.DB, request, params.code);
};
