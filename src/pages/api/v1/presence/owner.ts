import type { APIRoute } from 'astro';
import { errorResponse, jsonOk, readJsonObject } from '../../../../lib/http';
import { resolvePrincipal } from '../../../../lib/members/policy';
import { getOwnerStatus, parseOwnerStatusUpdate, setOwnerStatus } from '../../../../lib/presence/presence-owner-client';
import { requirePresenceOwner } from '../../../../lib/presence/presence-owner-identity';

export const prerender = false;

const NO_STORE = { 'Cache-Control': 'no-store' };

function failed(err: unknown): Response {
  const res = errorResponse(err);
  res.headers.set('Cache-Control', 'no-store');
  return res;
}

/**
 * Owner presence status. Owner only: a member session, `zk_` key or OAuth token whose member id is in
 * PRESENCE_OWNER_MEMBER_IDS (the admin role alone is refused with 403 `not_owner`).
 */
export const GET: APIRoute = async ({ request, locals }) => {
  try {
    const env = locals.runtime?.env ?? {};
    requirePresenceOwner(await resolvePrincipal(request, env), env, 'read');
    return jsonOk(await getOwnerStatus(env), 200, NO_STORE);
  } catch (err) {
    return failed(err);
  }
};

/** Body `{ mode, text? }`; omitted, null or empty `text` clears it. Needs `account:write` on scoped credentials. */
export const PUT: APIRoute = async ({ request, locals }) => {
  try {
    const env = locals.runtime?.env ?? {};
    requirePresenceOwner(await resolvePrincipal(request, env), env, 'write');
    const update = parseOwnerStatusUpdate(await readJsonObject(request));
    return jsonOk(await setOwnerStatus(env, update), 200, NO_STORE);
  } catch (err) {
    return failed(err);
  }
};
