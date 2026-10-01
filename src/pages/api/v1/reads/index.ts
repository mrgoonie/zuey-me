import type { APIRoute } from 'astro';
import { authenticateAdmin } from '../../../../lib/auth';
import { errorResponse, jsonError, jsonOk } from '../../../../lib/http';
import { getLastSyncedAt, listReads, listReadSources } from '../../../../lib/reads/store';

function intParam(params: URLSearchParams, key: string): number | undefined {
  const raw = params.get(key);
  if (raw === null || raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** Public list of visible reads. `include_hidden=1` (admin only) also returns hidden rows for Studio. */
export const GET: APIRoute = async ({ request, locals }) => {
  const d1 = locals.runtime?.env?.DB;
  try {
    const params = new URL(request.url).searchParams;
    const includeHidden = params.get('include_hidden') === '1';
    if (includeHidden) {
      const auth = await authenticateAdmin(request, d1);
      if (!auth.authenticated) return jsonError(auth.role ? 403 : 401, auth.role ? 'forbidden' : 'unauthorized', auth.error ?? 'Unauthorized');
    }
    const { items, total } = await listReads(d1, {
      q: params.get('q') ?? undefined,
      source: params.get('source') ?? undefined,
      limit: intParam(params, 'limit'),
      offset: intParam(params, 'offset'),
      includeHidden,
    });
    return jsonOk(
      { items, total, sources: await listReadSources(d1), last_synced_at: await getLastSyncedAt(d1) },
      200,
      includeHidden ? { 'Cache-Control': 'no-store' } : { 'Cache-Control': 'public, max-age=60' },
    );
  } catch (err) {
    return errorResponse(err);
  }
};
