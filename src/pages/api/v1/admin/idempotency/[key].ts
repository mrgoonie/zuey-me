import { AppError, jsonOk } from '../../../../../lib/http';
import { lookupIdempotencyKey } from '../../../../../lib/idempotency/store';
import { NO_STORE, memberRoute } from '../../../../../lib/members/account';
import { requireCan } from '../../../../../lib/members/policy';
import { principalActor } from '../../../../../lib/taxonomy/admin';

/** Admin: what a request sent with this idempotency key did (24 hours), so a lost response can be recovered. */
export const GET = memberRoute(async ({ params }, { d1, principal }) => {
  requireCan(principal, 'admin');
  const record = await lookupIdempotencyKey(d1, principalActor(principal), params.key);
  if (!record) throw new AppError(404, 'not_found', 'No request is recorded for this key (unknown or expired)');
  return jsonOk(record, 200, NO_STORE);
});
