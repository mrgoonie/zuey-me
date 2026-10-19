import { AppError, jsonOk, readJsonObject } from '../../../../../lib/http';
import { NO_STORE, memberRoute } from '../../../../../lib/members/account';
import { requireCan } from '../../../../../lib/members/policy';
import { principalActor } from '../../../../../lib/taxonomy/admin';
import { imageBlock } from '../../../../../lib/media/media-asset-store';
import { reconcileMediaObject } from '../../../../../lib/media/media-reconcile';

/** Admin: register an image already in the media bucket as a managed asset (validated against its sha256). */
export const POST = memberRoute(async ({ request }, { d1, env, principal }) => {
  requireCan(principal, 'admin');
  const body = await readJsonObject(request);
  if (!body) throw new AppError(400, 'invalid_json', 'Body must be a JSON object');
  const { asset, ...rest } = await reconcileMediaObject(d1, env, body, principalActor(principal));
  return jsonOk({ asset, ...rest, block: imageBlock(asset) }, rest.created ? 201 : 200, NO_STORE);
});
