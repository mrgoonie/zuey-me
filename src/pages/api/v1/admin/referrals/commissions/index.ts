import { jsonOk } from '../../../../../../lib/http';
import { listCommissions, parseCommissionStatus } from '../../../../../../lib/referrals/admin-api';
import { ADMIN_NO_STORE, referralAdminRoute } from '../../../../../../lib/referrals/admin-route';

/** Admin: commissions by status (e.g. `?status=review` for the fraud review queue). */
export const GET = referralAdminRoute(async (context, { d1 }) => {
  const params = new URL(context.request.url).searchParams;
  const commissions = await listCommissions(d1, { status: parseCommissionStatus(params.get('status')), limit: params.get('limit') ?? undefined });
  return jsonOk({ commissions }, 200, ADMIN_NO_STORE);
});
