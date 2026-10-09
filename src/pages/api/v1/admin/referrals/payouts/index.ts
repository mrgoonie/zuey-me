import { jsonOk } from '../../../../../../lib/http';
import { ADMIN_NO_STORE, referralAdminRoute } from '../../../../../../lib/referrals/admin-route';
import { listPayouts, parsePayoutStatus, parsePeriod } from '../../../../../../lib/referrals/payouts';

/** Admin: payouts of a period (`?period=YYYY-MM`) and/or status, with the payee's bank or PayPal details. */
export const GET = referralAdminRoute(async (context, { d1 }) => {
  const params = new URL(context.request.url).searchParams;
  const payouts = await listPayouts(d1, { period: parsePeriod(params.get('period')), status: parsePayoutStatus(params.get('status')) });
  return jsonOk({ payouts }, 200, ADMIN_NO_STORE);
});
