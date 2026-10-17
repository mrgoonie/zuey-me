import { jsonOk, readJsonObject } from '../../../../../lib/http';
import { NO_STORE, memberRoute } from '../../../../../lib/members/account';
import { requireCan } from '../../../../../lib/members/policy';
import { principalActor } from '../../../../../lib/taxonomy/admin';
import { reconcileMediaObject } from '../../../../../lib/media/media-reconcile';

/**
 * Admin: register an image already in the media bucket as a managed asset after checking its bytes.
 * Body: JSON `{ object_key | url, sha256, width?, height?, alt? }`. 201 when a record was created, else 200.
 */
export const POST = memberRoute(async ({ request }, { d1, env, principal }) => {
  requireCan(principal, 'admin');
  const body = (await readJsonObject(request)) ?? {};
  const result = await reconcileMediaObject(d1, env, body, principalActor(principal));
  return jsonOk(result, result.reconciled ? 201 : 200, NO_STORE);
});
