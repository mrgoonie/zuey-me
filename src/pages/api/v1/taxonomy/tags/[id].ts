import { AppError } from '../../../../../lib/http';
import { adminRoute, expectedRevisionOf } from '../../../../../lib/taxonomy/routes';
import { deleteTag, getTag, parseTagInput, updateTag } from '../../../../../lib/taxonomy/tags';

export const GET = adminRoute(async ({ env, params }) => {
  const tag = await getTag(env.DB, params.id ?? '');
  if (!tag) throw new AppError(404, 'not_found', 'Tag not found');
  return tag;
});

/** Admin: rename/re-alias a tag (stable id). Body: { expected_revision, names?, slug?, aliases? }. Reindexes tagged articles. */
export const PUT = adminRoute(async ({ env, params, body, actor }) =>
  updateTag(env.DB, params.id ?? '', parseTagInput(body, 'update'), body.expected_revision, actor, env));

/** Admin: delete a tag and detach it from articles. expected_revision in body or query. */
export const DELETE = adminRoute(async (ctx) => {
  await deleteTag(ctx.env.DB, ctx.params.id ?? '', expectedRevisionOf(ctx), ctx.actor, ctx.env);
  return { deleted: true };
});
