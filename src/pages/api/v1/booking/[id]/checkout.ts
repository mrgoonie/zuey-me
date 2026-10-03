import type { APIRoute } from 'astro';
import { errorResponse, getString, jsonOk, readJsonObject } from '../../../../../lib/http';
import { requireDb, startCheckout } from '../../../../../lib/booking/store';

/** Guest: start payment for an active hold (PayPal approval link or SePay VietQR instructions). */
export const POST: APIRoute = async ({ request, params, locals }) => {
  try {
    const env = locals.runtime?.env ?? {};
    const d1 = requireDb(env);
    const body = (await readJsonObject(request)) ?? {};
    const token = getString(body, 'token') ?? new URL(request.url).searchParams.get('token');
    return jsonOk(await startCheckout(d1, env, params.id ?? '', token));
  } catch (err) {
    return errorResponse(err);
  }
};
