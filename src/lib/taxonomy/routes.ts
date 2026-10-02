import type { APIRoute } from 'astro';
import type { RuntimeEnv } from '../../env';
import { errorResponse, jsonError, jsonOk, readJsonObject } from '../http';
import { requireAdminActor } from './admin';

export interface AdminRouteContext {
  request: Request;
  url: URL;
  env: RuntimeEnv;
  actor: string;
  params: Record<string, string | undefined>;
  /** Parsed JSON object body for POST/PUT/PATCH/DELETE with a body; empty object when absent. */
  body: Record<string, unknown>;
}

const BODY_METHODS = ['POST', 'PUT', 'PATCH'];

/**
 * Wraps an admin-only taxonomy endpoint: central admin check, JSON body parsing, AppError envelope.
 * The handler returns data (sent as 200 JSON) or a ready Response.
 */
export function adminRoute(handler: (ctx: AdminRouteContext) => Promise<unknown>, status = 200): APIRoute {
  return async ({ request, locals, params }) => {
    const env = locals.runtime?.env ?? {};
    try {
      const { actor } = await requireAdminActor(request, env);
      let body: Record<string, unknown> = {};
      if (BODY_METHODS.includes(request.method) || request.method === 'DELETE') {
        // An absent body is an empty object (action endpoints such as run/cancel take none,
        // DELETE may carry expected_revision in the query string); a present body must be a JSON object.
        const raw = await request.clone().text();
        if (raw.trim()) {
          const parsed = await readJsonObject(request);
          if (!parsed) return jsonError(400, 'invalid_json', 'Body must be a JSON object');
          body = parsed;
        }
      }
      const result = await handler({ request, url: new URL(request.url), env, actor, params, body });
      return result instanceof Response ? result : jsonOk(result, status, { 'Cache-Control': 'private, no-store' });
    } catch (err) {
      return errorResponse(err);
    }
  };
}

/** Expected revision from the body or, for DELETE without a body, from `?expected_revision=`. */
export function expectedRevisionOf(ctx: AdminRouteContext): unknown {
  if (ctx.body.expected_revision !== undefined) return ctx.body.expected_revision;
  const raw = ctx.url.searchParams.get('expected_revision');
  return raw === null ? undefined : Number(raw);
}
