import type { APIRoute } from 'astro';
import { errorResponse, jsonOk } from '../../../lib/http';
import { runtimeWaitUntil } from '../../../lib/blocks/articles';
import { getLab200Snapshot } from '../../../lib/lab200/store';

/** Public 200lab course snapshot for the Zuey OS 200lab window; a stale snapshot is refreshed after the response. */
export const GET: APIRoute = async ({ locals }) => {
  try {
    const snapshot = await getLab200Snapshot(locals.runtime?.env?.DB, { waitUntil: runtimeWaitUntil(locals.runtime) });
    return jsonOk({ courses: snapshot.courses, synced_at: snapshot.syncedAt }, 200, { 'Cache-Control': 'public, max-age=60' });
  } catch (err) {
    return errorResponse(err);
  }
};
