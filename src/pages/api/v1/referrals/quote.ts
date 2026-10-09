import type { APIRoute } from 'astro';
import { errorResponse, jsonOk } from '../../../../lib/http';
import { NO_STORE, memberRequest } from '../../../../lib/members/account';
import { normalizeReferralCode } from '../../../../lib/referrals/codes';
import { referralQuote } from '../../../../lib/referrals/checkout';

/**
 * Public referral price quote for `/pricing` and the booking widget: SePay prepay totals, the card first
 * month and the consultation, with the visitor's referral discount (from `?code=`, the account binding or
 * the `zr_ref` cookie). Personal, so never cached. Display only: checkout recomputes every amount.
 */
export const GET: APIRoute = async context => {
  try {
    const { d1, env, principal } = await memberRequest(context);
    const enteredCode = normalizeReferralCode(new URL(context.request.url).searchParams.get('code'));
    const quote = await referralQuote(d1, env, { userId: principal.user?.id, enteredCode, request: context.request });
    return jsonOk(quote, 200, NO_STORE);
  } catch (err) {
    return errorResponse(err);
  }
};
