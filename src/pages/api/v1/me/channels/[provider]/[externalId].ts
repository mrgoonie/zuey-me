import { runtimeWaitUntil } from '../../../../../../lib/blocks/articles';
import { unlinkChannelIdentity } from '../../../../../../lib/channel-access/identities';
import { deferChannelAccessPush, invalidateSenders } from '../../../../../../lib/channel-access/invalidate';
import { AppError, jsonOk } from '../../../../../../lib/http';
import { NO_STORE, memberRoute, requireUser } from '../../../../../../lib/members/account';
import { requireCan } from '../../../../../../lib/members/policy';
import { logActivity } from '../../../../../../lib/members/users';

/** Unlinks one of your chat accounts (browser session only); dewee is told to re-check that sender at once. */
export const DELETE = memberRoute(async ({ params, request, locals }, { d1, env, principal }) => {
  requireCan(principal, 'account:security');
  const user = requireUser(principal);
  const provider = params.provider ?? '';
  const externalId = params.externalId ?? '';
  if (!(await unlinkChannelIdentity(d1, user.id, provider, externalId))) {
    throw new AppError(404, 'not_found', 'Linked chat account not found');
  }
  await logActivity(d1, user.id, 'channel.unlinked', { provider, external_id: externalId }, request);
  await deferChannelAccessPush(invalidateSenders(env, [externalId]), runtimeWaitUntil(locals.runtime));
  return jsonOk({ unlinked: true }, 200, NO_STORE);
});
