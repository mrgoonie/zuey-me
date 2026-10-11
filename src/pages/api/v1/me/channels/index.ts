import { listChannelIdentities } from '../../../../../lib/channel-access/identities';
import { jsonOk } from '../../../../../lib/http';
import { NO_STORE, memberRoute, requireUser } from '../../../../../lib/members/account';
import { requireCan } from '../../../../../lib/members/policy';

/** Your linked chat accounts (Telegram ids used by the Zuey AI agent gate). */
export const GET = memberRoute(async (_ctx, { d1, principal }) => {
  requireCan(principal, 'account:read');
  const user = requireUser(principal);
  const identities = await listChannelIdentities(d1, user.id);
  return jsonOk(identities.map(i => ({ provider: i.provider, external_id: i.external_id, linked_at: i.linked_at, source: i.source })), 200, NO_STORE);
});
