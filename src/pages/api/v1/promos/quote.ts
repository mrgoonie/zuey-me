import type { APIRoute } from 'astro';
import { AppError, errorResponse, jsonOk } from '../../../../lib/http';
import { consumeRateLimit, requestIpHash } from '../../../../lib/courses/course-abuse-guards';
import { NO_STORE } from '../../../../lib/members/account';
import { requireMembersDb } from '../../../../lib/members/runtime';
import { promoQuote } from '../../../../lib/promos/promo-redemptions';

/**
 * Public promo code lookup for the "Mã ưu đãi" field: `?code=` → percent and restrictions when the code is
 * live, 404 `promo_code_not_found` when no such promo exists (the field then tries it as a referral code),
 * 400 `promo_code_invalid` with the reason otherwise. Display only: checkout re-validates and reserves.
 * Rate-limited per network (429 `rate_limited`) so codes cannot be guessed in bulk.
 */
export const GET: APIRoute = async context => {
  try {
    const env = context.locals.runtime?.env ?? {};
    const d1 = requireMembersDb(env);
    await consumeRateLimit(d1, 'promoQuote', (await requestIpHash(env, context.request)) ?? 'unknown');
    const quote = await promoQuote(d1, new URL(context.request.url).searchParams.get('code'));
    if (!quote) throw new AppError(404, 'promo_code_not_found', 'No promo code with this name');
    return jsonOk(quote, 200, NO_STORE);
  } catch (err) {
    return errorResponse(err);
  }
};
