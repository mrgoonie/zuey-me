import { jsonOk } from '../../../../../../lib/http';
import { getPromoWithStats, listPromoRedemptions } from '../../../../../../lib/promos/promo-redemptions';
import { ADMIN_NO_STORE, referralAdminRoute } from '../../../../../../lib/referrals/admin-route';

/** Admin: orders that used (or currently hold) the code, newest first. */
export const GET = referralAdminRoute(async (context, { d1 }) => {
  const promo = await getPromoWithStats(d1, context.params.id ?? '');
  const limitRaw = new URL(context.request.url).searchParams.get('limit');
  const limit = limitRaw && /^\d+$/.test(limitRaw) ? Math.min(Math.max(Number(limitRaw), 1), 1000) : 200;
  return jsonOk({ promo_code: promo, redemptions: await listPromoRedemptions(d1, promo.id, limit) }, 200, ADMIN_NO_STORE);
});
