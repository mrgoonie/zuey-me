import type { APIContext, APIRoute } from 'astro';
import type { D1DatabaseLike } from '../../db/store';
import type { RuntimeEnv } from '../../env';
import { AppError, errorResponse } from '../http';
import { requireMembersDb } from '../members/runtime';
import { requireAdminActor } from '../taxonomy/admin';

export interface ReferralAdminRequest {
  env: RuntimeEnv;
  d1: D1DatabaseLike;
  /** Admin identity recorded on the audit trail (email, `admin-api-key` or `studio-session`). */
  actor: string;
}

/** Admin-only referral route: D1 + admin principal (session, Studio or admin key), errors as JSON envelope. */
export function referralAdminRoute(handler: (context: APIContext, a: ReferralAdminRequest) => Promise<Response>): APIRoute {
  return async context => {
    try {
      const env = context.locals.runtime?.env ?? {};
      const d1 = requireMembersDb(env);
      const { actor } = await requireAdminActor(context.request, env);
      return await handler(context, { env, d1, actor });
    } catch (err) {
      return errorResponse(err);
    }
  };
}

/** Optional JSON object body: empty → {}, anything else that is not an object → 400. */
export async function optionalJsonBody(request: Request): Promise<Record<string, unknown>> {
  const raw = await request.text();
  if (!raw.trim()) return {};
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    body = null;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AppError(400, 'invalid_json', 'Body must be a JSON object');
  return Object.fromEntries(Object.entries(body));
}

export const ADMIN_NO_STORE = { 'Cache-Control': 'no-store' };
