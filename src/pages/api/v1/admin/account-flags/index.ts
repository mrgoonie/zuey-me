import { jsonOk } from '../../../../../lib/http';
import { NO_STORE, memberRoute } from '../../../../../lib/members/account';
import { requireCan } from '../../../../../lib/members/policy';
import type { AccountFlagStatus } from '../../../../../lib/members/account-flags';
import { listAccountFlags, listCourseLocks } from '../../../../../lib/members/account-flags';

const STATUSES: Array<AccountFlagStatus | 'all'> = ['open', 'dismissed', 'locked', 'all'];

/** Admin: anti-abuse review queue (`?status=open` default) plus current course-access locks. */
export const GET = memberRoute(async ({ request }, { d1, principal }) => {
  requireCan(principal, 'admin');
  const raw = new URL(request.url).searchParams.get('status');
  const status = STATUSES.find(s => s === raw) ?? 'open';
  const [flags, locks] = await Promise.all([listAccountFlags(d1, status), listCourseLocks(d1)]);
  return jsonOk({ flags, locks }, 200, NO_STORE);
});
