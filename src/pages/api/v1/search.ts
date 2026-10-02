import type { APIRoute } from 'astro';
import { AppError, errorResponse, jsonError, jsonOk } from '../../../lib/http';
import { localeParam } from '../../../lib/blocks/params';
import { resolvePrincipal } from '../../../lib/members/policy';
import { searchKnowledge } from '../../../lib/search';

/**
 * Knowledge search: GET /api/v1/search?q=&locale=&limit=. Authorization happens before ranking:
 * readers without read_full only search free text and paid previews, so snippets never quote paid text.
 * `semantic: false` means BM25 only (no Vectorize binding or embedding failure).
 */
export const GET: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime?.env ?? {};
  try {
    const url = new URL(request.url);
    const q = url.searchParams.get('q') ?? '';
    if (!q.trim()) throw new AppError(400, 'invalid_field', 'q is required', { field: 'q' });
    if (q.length > 200) throw new AppError(400, 'invalid_field', 'q must be at most 200 characters', { field: 'q' });
    const limit = Number(url.searchParams.get('limit') ?? '10');
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new AppError(400, 'invalid_field', 'limit must be an integer 1–50', { field: 'limit' });
    const principal = await resolvePrincipal(request, env);
    if (principal.credentialError) {
      return jsonError(principal.credentialError.status, principal.credentialError.code, principal.credentialError.message);
    }
    const locale = localeParam(url, 'locale') ?? localeParam(url, 'lang') ?? null;
    const result = await searchKnowledge(principal, q, locale, limit, env);
    return jsonOk(result, 200, { 'Cache-Control': 'private, no-store', Vary: 'Cookie, Authorization' });
  } catch (err) {
    return errorResponse(err);
  }
};
