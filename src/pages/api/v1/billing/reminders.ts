import { jsonOk } from '../../../../lib/http';
import { NO_STORE, memberRoute } from '../../../../lib/members/account';
import { sendRenewalReminders } from '../../../../lib/members/billing';
import { requireCan } from '../../../../lib/members/policy';

/** Admin/cron: email members whose plan ends within 7 days (once per plan period) and expire stale records. */
export const POST = memberRoute(async (_ctx, { d1, env, principal }) => {
  requireCan(principal, 'admin');
  return jsonOk(await sendRenewalReminders(d1, env), 200, NO_STORE);
});
