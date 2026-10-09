import { jsonOk } from '../../../../../../lib/http';
import { requireJsonBody } from '../../../../../../lib/members/account';
import { updatePromo } from '../../../../../../lib/promos/promo-codes';
import { getPromoWithStats } from '../../../../../../lib/promos/promo-redemptions';
import { ADMIN_NO_STORE, referralAdminRoute } from '../../../../../../lib/referrals/admin-route';

/** Admin: one promo code with uses and revenue. */
export const GET = referralAdminRoute(async (context, { d1 }) => jsonOk(await getPromoWithStats(d1, context.params.id ?? ''), 200, ADMIN_NO_STORE));

/** Admin: partial update (status, percent, window, limits, label/note). A used code cannot be renamed. */
export const PATCH = referralAdminRoute(async (context, { d1 }) => {
  const promo = await updatePromo(d1, context.params.id ?? '', await requireJsonBody(context.request));
  return jsonOk(await getPromoWithStats(d1, promo.id), 200, ADMIN_NO_STORE);
});
