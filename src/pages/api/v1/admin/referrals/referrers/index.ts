import { jsonOk } from '../../../../../../lib/http';
import { searchReferrers } from '../../../../../../lib/referrals/admin-api';
import { ADMIN_NO_STORE, referralAdminRoute } from '../../../../../../lib/referrals/admin-route';

/** Admin: referrers by email, name or code (`?q=`), with rate, tier, lock state and balances. */
export const GET = referralAdminRoute(async (context, { d1 }) => {
  const params = new URL(context.request.url).searchParams;
  const referrers = await searchReferrers(d1, { q: params.get('q'), limit: params.get('limit') ?? undefined });
  return jsonOk({ referrers }, 200, ADMIN_NO_STORE);
});
