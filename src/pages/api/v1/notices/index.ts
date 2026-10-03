import { jsonOk } from '../../../../lib/http';
import { NO_STORE, memberRoute, requireJsonBody } from '../../../../lib/members/account';
import { requireCan } from '../../../../lib/members/policy';
import { createNotice, listNotices, parseNoticeInput, principalLabel } from '../../../../lib/experience/notices';

/** Admin: list notices (?include_expired=1, ?limit=1..200). */
export const GET = memberRoute(async ({ request }, { d1, principal }) => {
  requireCan(principal, 'admin');
  const sp = new URL(request.url).searchParams;
  const notices = await listNotices(d1, { includeExpired: sp.get('include_expired') === '1', limit: Number(sp.get('limit') ?? 50) || 50 });
  return jsonOk({ notices }, 200, NO_STORE);
});

/** Admin: send a visitor notice shown in the mascot bubble labelled "Duy". */
export const POST = memberRoute(async ({ request }, { d1, principal }) => {
  requireCan(principal, 'admin');
  const input = parseNoticeInput(await requireJsonBody(request));
  return jsonOk(await createNotice(d1, input, principalLabel(principal)), 201, NO_STORE);
});
