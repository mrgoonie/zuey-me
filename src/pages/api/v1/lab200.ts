import type { APIRoute } from 'astro';
import { errorResponse, jsonOk } from '../../../lib/http';
import { runtimeWaitUntil } from '../../../lib/blocks/articles';
import { getLab200Catalog } from '../../../lib/lab200/store';

/** Public 200lab catalogs (courses and learning paths) for the Zuey OS 200lab window; stale feeds refresh after the response. */
export const GET: APIRoute = async ({ locals }) => {
  try {
    const { courses, learningPaths } = await getLab200Catalog(locals.runtime?.env?.DB, { waitUntil: runtimeWaitUntil(locals.runtime) });
    return jsonOk({
      courses: courses.items,
      synced_at: courses.syncedAt,
      courses_locale: courses.locale,
      learning_paths: learningPaths.items,
      learning_paths_synced_at: learningPaths.syncedAt,
      learning_paths_locale: learningPaths.locale,
    }, 200, { 'Cache-Control': 'public, max-age=60' });
  } catch (err) {
    return errorResponse(err);
  }
};
