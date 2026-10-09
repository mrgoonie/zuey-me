import { jsonOk } from '../../../../../../lib/http';
import { requireJsonBody } from '../../../../../../lib/members/account';
import { updateReferrer } from '../../../../../../lib/referrals/admin-api';
import { ADMIN_NO_STORE, referralAdminRoute } from '../../../../../../lib/referrals/admin-route';

/** Astro decodes params with decodeURI, which leaves `%40` (@) encoded; malformed escapes fall back to raw. */
function emailParam(raw: string | undefined): string {
  try {
    return decodeURIComponent(raw ?? '');
  } catch {
    return raw ?? '';
  }
}

/** Admin: rate override (null | 0–50), admin_enabled, lock (locked + lock_reason) or unlock. */
export const PATCH = referralAdminRoute(async (context, { d1, actor }) => {
  const referrer = await updateReferrer(d1, emailParam(context.params.email), await requireJsonBody(context.request), actor);
  return jsonOk(referrer, 200, ADMIN_NO_STORE);
});
