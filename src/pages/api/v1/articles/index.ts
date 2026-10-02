import type { APIRoute } from 'astro';
import { errorResponse, jsonError, jsonOk, readJsonObject } from '../../../../lib/http';
import { createArticle, listArticles, parseArticleInput, toSummary } from '../../../../lib/blocks/articles';
import { discoverArticles } from '../../../../lib/blocks/discovery';
import { parseDiscoveryQuery } from '../../../../lib/blocks/params';
import { resolvePrincipal } from '../../../../lib/members/policy';
import { requireAdminActor } from '../../../../lib/taxonomy/admin';

/**
 * Published articles with discovery filters (?q=&lang=&category=&tag=&label=&access=&sort=&limit=).
 * Admins may add ?include_drafts=1 (every edition, drafts included). Tags, category and labels are public metadata.
 */
export const GET: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime?.env ?? {};
  try {
    const url = new URL(request.url);
    const query = parseDiscoveryQuery(url);
    if (url.searchParams.get('include_drafts') === '1') {
      await requireAdminActor(request, env);
      const { q: _q, ...filters } = query;
      return jsonOk(await listArticles(env.DB, { ...filters, includeDrafts: true }), 200, { 'Cache-Control': 'private, no-store' });
    }
    const principal = await resolvePrincipal(request, env);
    if (principal.credentialError) {
      return jsonError(principal.credentialError.status, principal.credentialError.code, principal.credentialError.message);
    }
    const result = await discoverArticles(principal, env, query);
    return jsonOk(result.items, 200, {
      'Cache-Control': query.q ? 'private, no-store' : 'public, max-age=60',
      'X-Search-Semantic': result.semantic ? '1' : '0',
    });
  } catch (err) {
    return errorResponse(err);
  }
};

/** Admin: create a draft article (first edition in `locale`, default vi) with a validated block document. */
export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime?.env ?? {};
  try {
    const { actor } = await requireAdminActor(request, env);
    const body = await readJsonObject(request);
    if (!body) return jsonError(400, 'invalid_json', 'Body must be a JSON object');
    const rec = await createArticle(env.DB, parseArticleInput(body, 'create'), { actor, env });
    return jsonOk({ ...toSummary(rec), document: rec.draft }, 201);
  } catch (err) {
    return errorResponse(err);
  }
};
