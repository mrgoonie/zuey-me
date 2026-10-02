import { AppError } from '../../../../../lib/http';
import { localeField } from '../../../../../lib/blocks/params';
import { requireArticleId } from '../../../../../lib/blocks/articles';
import { createProposal, listProposals, parseStatusFilter } from '../../../../../lib/taxonomy/proposals';
import { adminRoute } from '../../../../../lib/taxonomy/routes';

/** Admin: label proposals for review (?status=pending|deferred|applied|rejected|stale&article_id=&job_id=). */
export const GET = adminRoute(async ({ env, url }) => listProposals(env.DB, {
  status: parseStatusFilter(url.searchParams.get('status')),
  articleId: url.searchParams.get('article_id') ?? undefined,
  jobId: url.searchParams.get('job_id') ?? undefined,
}));

/**
 * Admin: file a manual proposal for one edition (reviewed like AI proposals).
 * Body: { article_slug, locale, assignments, rationale? }.
 */
export const POST = adminRoute(async ({ env, body, actor }) => {
  const slug = typeof body.article_slug === 'string' ? body.article_slug : '';
  const locale = localeField(body);
  if (!locale) throw new AppError(400, 'invalid_field', 'locale is required', { field: 'locale' });
  const articleId = await requireArticleId(env.DB, slug);
  return createProposal(env.DB, {
    articleId, locale, assignments: body.assignments, rationale: typeof body.rationale === 'string' ? body.rationale : '', actor,
  });
}, 201);
