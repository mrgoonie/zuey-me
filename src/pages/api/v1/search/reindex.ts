import { reindexAll } from '../../../../lib/search';
import { requireDb } from '../../../../lib/taxonomy/common';
import { adminRoute } from '../../../../lib/taxonomy/routes';

/** Admin: rebuild the FTS5 index (and Vectorize vectors when bound) for every article. */
export const POST = adminRoute(async ({ env }) => reindexAll(requireDb(env.DB), env));
