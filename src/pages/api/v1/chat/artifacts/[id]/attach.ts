import { attachArtifact } from '../../../../../../lib/ai/admin-chat';
import { jsonOk } from '../../../../../../lib/http';
import { NO_STORE, memberRoute, requireJsonBody } from '../../../../../../lib/members/account';

/**
 * Admin: append a chat artifact (interactive block) to an article draft.
 * Body: {article_slug, expected_revision, reason?, confirm_recovered_draft?} — reason is required for another
 * member's artifact; confirm_recovered_draft accepts saving a recovered draft (an unreadable one is never overwritten).
 * Publishing still goes through POST /api/v1/articles/{slug}/publish.
 */
export const POST = memberRoute(async ({ params, request }, { d1, principal }) => {
  const body = await requireJsonBody(request);
  return jsonOk(await attachArtifact(d1, principal, params.id ?? '', body), 200, NO_STORE);
});
