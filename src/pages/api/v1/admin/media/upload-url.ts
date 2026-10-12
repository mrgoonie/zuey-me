import { jsonOk, readJsonObject } from '../../../../../lib/http';
import { NO_STORE, memberRoute } from '../../../../../lib/members/account';
import { requireCan } from '../../../../../lib/members/policy';
import { principalActor } from '../../../../../lib/taxonomy/admin';
import { createUploadTicket } from '../../../../../lib/media/media-upload-sources';

/** Admin: one-time `PUT` URL (15 minutes) for uploading an image file with curl. Body: JSON `{alt?}`. */
export const POST = memberRoute(async ({ request, url }, { d1, env, principal }) => {
  requireCan(principal, 'admin');
  const body = (await readJsonObject(request)) ?? {};
  const origin = (env.PUBLIC_SITE_URL || url.origin).replace(/\/$/, '');
  return jsonOk(await createUploadTicket(d1, env, origin, { alt: body.alt, actor: principalActor(principal) }), 201, NO_STORE);
});
