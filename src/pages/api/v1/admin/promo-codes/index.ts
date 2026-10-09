import { jsonOk } from '../../../../../lib/http';
import { requireJsonBody } from '../../../../../lib/members/account';
import { createPromo } from '../../../../../lib/promos/promo-codes';
import { getPromoWithStats, listPromosWithStats } from '../../../../../lib/promos/promo-redemptions';
import { ADMIN_NO_STORE, referralAdminRoute } from '../../../../../lib/referrals/admin-route';

/** Admin: promo codes (newest first) with uses and revenue; `?q=` searches code/label, `?status=active|disabled`. */
export const GET = referralAdminRoute(async (context, { d1 }) => {
  const params = new URL(context.request.url).searchParams;
  const promo_codes = await listPromosWithStats(d1, { q: params.get('q'), status: params.get('status'), limit: params.get('limit') ?? undefined });
  return jsonOk({ promo_codes }, 200, ADMIN_NO_STORE);
});

/** Admin: creates a code. 409 `code_taken` when a promo or referral code already has the name. */
export const POST = referralAdminRoute(async (context, { d1, actor }) => {
  const promo = await createPromo(d1, await requireJsonBody(context.request), actor);
  return jsonOk(await getPromoWithStats(d1, promo.id), 201, ADMIN_NO_STORE);
});
