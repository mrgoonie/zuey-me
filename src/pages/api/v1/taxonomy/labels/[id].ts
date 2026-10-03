import { AppError } from '../../../../../lib/http';
import { deleteLabel, getLabel, parseLabelInput, updateLabel } from '../../../../../lib/taxonomy/labels';
import { adminRoute, expectedRevisionOf } from '../../../../../lib/taxonomy/routes';

/** `id` is a label id or `<kind>:<slug>` (URL-encoded). */
export const GET = adminRoute(async ({ env, params }) => {
  const label = await getLabel(env.DB, decodeURIComponent(params.id ?? ''));
  if (!label) throw new AppError(404, 'not_found', 'Label not found');
  return label;
});

/** Admin: edit names/description/version, or approve an extension (approve: true). Body: { expected_revision, ... }. */
export const PUT = adminRoute(async ({ env, params, body, actor }) =>
  updateLabel(env.DB, decodeURIComponent(params.id ?? ''), parseLabelInput(body, 'update'), body.expected_revision, actor));

/** Admin: delete an unused, non-built-in label. */
export const DELETE = adminRoute(async (ctx) => {
  await deleteLabel(ctx.env.DB, decodeURIComponent(ctx.params.id ?? ''), expectedRevisionOf(ctx), ctx.actor);
  return { deleted: true };
});
