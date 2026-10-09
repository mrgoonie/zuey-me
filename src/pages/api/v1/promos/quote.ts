import type { APIRoute } from 'astro';
import { AppError, errorResponse, jsonOk } from '../../../../lib/http';
import { NO_STORE } from '../../../../lib/members/account';
import { requireMembersDb } from '../../../../lib/members/runtime';
import { promoQuote } from '../../../../lib/promos/promo-redemptions';

/**
 * Public promo code lookup for the "Mã ưu đãi" field: `?code=` → percent and restrictions when the code is
 * live, 404 `promo_code_not_found` when no such promo exists (the field then tries it as a referral code),
 * 400 `promo_code_invalid` with the reason otherwise. Display only: checkout re-validates and reserves.
 */
export const GET: APIRoute = async context => {
  try {
    const d1 = requireMembersDb(context.locals.runtime?.env ?? {});
    const quote = await promoQuote(d1, new URL(context.request.url).searchParams.get('code'));
    if (!quote) throw new AppError(404, 'promo_code_not_found', 'No promo code with this name');
    return jsonOk(quote, 200, NO_STORE);
  } catch (err) {
    return errorResponse(err);
  }
};
