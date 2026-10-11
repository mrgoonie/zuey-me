import type { APIRoute } from 'astro';
import { errorResponse, jsonOk } from '../../../../lib/http';
import { requireMembersDb } from '../../../../lib/members/runtime';
import { resolveMemberSession } from '../../../../lib/members/session';

/**
 * Analytics identity for this browser: the signed-in member's opaque id, or null when signed out.
 * Only the session cookie counts (API keys are ignored), and no email, name or plan is returned.
 */
export const GET: APIRoute = async ({ request, locals }) => {
  try {
    const d1 = requireMembersDb(locals.runtime?.env ?? {});
    const current = await resolveMemberSession(request, d1);
    return jsonOk({ member_id: current ? current.user.id : null }, 200, { 'Cache-Control': 'private, no-store' });
  } catch (err) {
    return errorResponse(err);
  }
};
