import { idempotentJson } from '../../../../../lib/idempotency/rest';
import { principalActor } from '../../../../../lib/taxonomy/admin';
import { NO_STORE, memberRoute } from '../../../../../lib/members/account';
import { requireCan } from '../../../../../lib/members/policy';
import { deleteMediaAsset } from '../../../../../lib/media/media-asset-store';

/** Admin: delete an image; 409 `media_in_use` while a current article or lesson document uses it. */
export const DELETE = memberRoute(async ({ params, request }, { d1, env, principal }) => {
  requireCan(principal, 'admin');
  return idempotentJson({ request, d1, actor: principalActor(principal), operation: 'media_delete', params: { id: params.id }, headers: NO_STORE }, () => deleteMediaAsset(d1, env, params.id ?? ''));
});
