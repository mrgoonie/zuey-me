import { AppError, jsonOk } from '../../../../../../../lib/http';
import { ADMIN_NO_STORE, optionalJsonBody, referralAdminRoute } from '../../../../../../../lib/referrals/admin-route';
import { cancelPayout, markPayoutPaid } from '../../../../../../../lib/referrals/payouts';

/** Admin: `paid` (with `transaction_ref`; emails the referrer) or `cancel` (returns the gross to the balance). */
export const POST = referralAdminRoute(async (context, { d1, env, actor }) => {
  const id = context.params.id ?? '';
  const body = await optionalJsonBody(context.request);
  if (context.params.action === 'paid') return jsonOk(await markPayoutPaid(d1, env, id, body.transaction_ref, actor), 200, ADMIN_NO_STORE);
  if (context.params.action === 'cancel') {
    const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 500) || null : null;
    return jsonOk(await cancelPayout(d1, id, actor, reason), 200, ADMIN_NO_STORE);
  }
  throw new AppError(404, 'not_found', 'Unknown action');
});
