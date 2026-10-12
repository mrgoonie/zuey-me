import { jsonOk } from '../../../../../lib/http';
import { NO_STORE, memberRoute } from '../../../../../lib/members/account';
import { requireCan } from '../../../../../lib/members/policy';
import { deleteMediaAsset } from '../../../../../lib/media/media-asset-store';

/** Admin: delete an image; 409 `media_in_use` while a current article or lesson document uses it. */
export const DELETE = memberRoute(async ({ params }, { d1, env, principal }) => {
  requireCan(principal, 'admin');
  return jsonOk(await deleteMediaAsset(d1, env, params.id ?? ''), 200, NO_STORE);
});
