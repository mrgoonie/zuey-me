import { adminRoute } from '../../../../../lib/taxonomy/routes';
import { createTag, listTags, parseTagInput } from '../../../../../lib/taxonomy/tags';

/** Admin: every topic tag with localized names, aliases, revision and article count. */
export const GET = adminRoute(async ({ env }) => listTags(env.DB));

/** Admin: create a tag. Body: { names: { vi?, en?, ... }, slug?, aliases? }. Duplicates across slug/aliases/names are 409. */
export const POST = adminRoute(async ({ env, body, actor }) => createTag(env.DB, parseTagInput(body, 'create'), actor), 201);
