import { AppError } from '../../../../../lib/http';
import { deleteCategory, getCategory, parseCategoryInput, updateCategory } from '../../../../../lib/taxonomy/categories';
import { adminRoute, expectedRevisionOf } from '../../../../../lib/taxonomy/routes';

export const GET = adminRoute(async ({ env, params }) => {
  const cat = await getCategory(env.DB, params.id ?? '');
  if (!cat) throw new AppError(404, 'not_found', 'Category not found');
  return cat;
});

/** Admin: update a category. Body: { expected_revision, names?, slug?, position? }. */
export const PUT = adminRoute(async ({ env, params, body, actor }) =>
  updateCategory(env.DB, params.id ?? '', parseCategoryInput(body, 'update'), body.expected_revision, actor, env));

/** Admin: delete a category (articles become uncategorised). expected_revision in body or query. */
export const DELETE = adminRoute(async (ctx) => {
  await deleteCategory(ctx.env.DB, ctx.params.id ?? '', expectedRevisionOf(ctx), ctx.actor, ctx.env);
  return { deleted: true };
});
