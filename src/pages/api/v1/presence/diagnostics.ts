import type { APIRoute } from 'astro';
import { errorResponse, jsonOk } from '../../../../lib/http';
import { resolvePrincipal } from '../../../../lib/members/policy';
import { requirePresenceDiagnosticsReader } from '../../../../lib/presence/presence-diagnostics-access';
import { getPresenceDiagnostics } from '../../../../lib/presence/presence-internal-client';

export const prerender = false;

const NO_STORE = { 'Cache-Control': 'no-store' };

/**
 * Admin, read-only: presence Worker counters (sockets, limits, counters, alarm, history storage). Counts and
 * timings only. 503 `presence_unavailable` when the Worker is unreachable or answers badly.
 */
export const GET: APIRoute = async ({ request, locals }) => {
  try {
    const env = locals.runtime?.env ?? {};
    requirePresenceDiagnosticsReader(await resolvePrincipal(request, env));
    return jsonOk(await getPresenceDiagnostics(env), 200, NO_STORE);
  } catch (err) {
    const res = errorResponse(err);
    res.headers.set('Cache-Control', 'no-store');
    return res;
  }
};
