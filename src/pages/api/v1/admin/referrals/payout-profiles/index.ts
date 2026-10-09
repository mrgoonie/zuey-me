import { jsonOk } from '../../../../../../lib/http';
import { ADMIN_NO_STORE, referralAdminRoute } from '../../../../../../lib/referrals/admin-route';
import { listPayoutProfiles, parseProfileStatus } from '../../../../../../lib/referrals/payout-profile-review';

/** Admin: payout profiles by status (default `submitted`, the review queue). Never includes images. */
export const GET = referralAdminRoute(async (context, { d1 }) => {
  const raw = new URL(context.request.url).searchParams.get('status');
  const status = raw === 'all' ? undefined : parseProfileStatus(raw ?? 'submitted');
  return jsonOk({ profiles: await listPayoutProfiles(d1, status) }, 200, ADMIN_NO_STORE);
});
