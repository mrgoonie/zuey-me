import { AppError, jsonOk } from '../../../../../lib/http';
import { NO_STORE, memberRoute } from '../../../../../lib/members/account';
import { requireCan } from '../../../../../lib/members/policy';
import { expireNotice } from '../../../../../lib/experience/notices';

/** Admin: end a notice now (idempotent). */
export const POST = memberRoute(async ({ params }, { d1, principal }) => {
  requireCan(principal, 'admin');
  const id = params.id;
  if (!id) throw new AppError(400, 'invalid_field', 'id is required', { field: 'id' });
  return jsonOk(await expireNotice(d1, id), 200, NO_STORE);
});
