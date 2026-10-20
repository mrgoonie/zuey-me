import type { APIRoute } from 'astro';
import { DeweeIdentityError, createConnectRedirect, readConnectRequest } from '@dewee/identity';
import { requireDeweeIdentityConfig } from '../../lib/channel-access/dewee-identity';
import { AppError, errorResponse } from '../../lib/http';
import { requireMembersDb, safeNextPath } from '../../lib/members/runtime';
import { resolveMemberSession } from '../../lib/members/session';

const HANDOFF_HEADERS = { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow' };

/**
 * Dewee Connect start URL: Dewee sends the member here with `dewee_txn` and `return_to`. The signed-in member
 * gets an auto-submitting form that posts a handoff assertion (subject = member id, nonce = dewee_txn) back to
 * Dewee's own `/connect/return`; any other `return_to` is refused. Dewee then shows consent and the chat proof.
 */
export const GET: APIRoute = async ({ request, locals, url }) => {
  try {
    const env = locals.runtime?.env ?? {};
    const cfg = requireDeweeIdentityConfig(env);
    const connect = readConnectRequest(url, { connectBaseUrl: cfg.connectBaseUrl });
    const current = await resolveMemberSession(request, requireMembersDb(env));
    if (!current) {
      const next = safeNextPath(`${url.pathname}${url.search}`, url.pathname);
      return new Response(null, { status: 302, headers: { Location: `/login?next=${encodeURIComponent(next)}`, ...HANDOFF_HEADERS } });
    }
    const redirect = await createConnectRedirect({ signer: cfg.signer, subject: current.user.id, connectBaseUrl: cfg.connectBaseUrl, ...connect });
    return new Response(redirect.html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', ...HANDOFF_HEADERS } });
  } catch (err) {
    // The SDK refuses a malformed dewee_txn or a foreign return_to before anything is signed.
    if (err instanceof DeweeIdentityError && err.code === 'INVALID_ARGUMENT') {
      return errorResponse(new AppError(400, 'invalid_connect_request', 'This Dewee link is invalid; ask the bot for a new one'));
    }
    return errorResponse(err);
  }
};
