import { jsonOk } from '../../../../../lib/http';
import { getReferralSettings } from '../../../../../lib/referrals/config';
import { adminUpdateSettings } from '../../../../../lib/referrals/admin-api';
import { ADMIN_NO_STORE, referralAdminRoute } from '../../../../../lib/referrals/admin-route';
import { requireJsonBody } from '../../../../../lib/members/account';

/** Admin: program settings (tiers, hold, booking rate, payout threshold, deductions, cookie days). */
export const GET = referralAdminRoute(async (_context, { d1 }) => jsonOk(await getReferralSettings(d1), 200, ADMIN_NO_STORE));

/** Admin: partial update; unknown keys and out-of-range values are rejected. */
export const PATCH = referralAdminRoute(async (context, { d1, actor }) =>
  jsonOk(await adminUpdateSettings(d1, await requireJsonBody(context.request), actor), 200, ADMIN_NO_STORE));
