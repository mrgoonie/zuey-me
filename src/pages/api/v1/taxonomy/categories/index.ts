import { createCategory, listCategories, parseCategoryInput } from '../../../../../lib/taxonomy/categories';
import { adminRoute } from '../../../../../lib/taxonomy/routes';

/** Admin: every category with localized names, position, revision and article count. */
export const GET = adminRoute(async ({ env }) => listCategories(env.DB));

/** Admin: create a category. Body: { names, slug?, position? }. */
export const POST = adminRoute(async ({ env, body, actor }) => createCategory(env.DB, parseCategoryInput(body, 'create'), actor), 201);
