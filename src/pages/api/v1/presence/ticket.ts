import type { APIRoute } from 'astro';
import { AppError, errorResponse, jsonOk, readJsonObject } from '../../../../lib/http';
import { membersRuntime } from '../../../../lib/members/runtime';
import {
  enforcePresenceTicketRateLimit, issuePresenceTicket, parsePresenceTicketRequest,
} from '../../../../lib/presence/presence-ticket-issuer';

export const prerender = false;

const NO_STORE = { 'Cache-Control': 'no-store' };

/**
 * Browser-only: a short-lived signed ticket for the presence Worker's WebSocket. Optional member
 * session cookie; API keys and bearer tokens are ignored. Body `{ count: boolean, browserId?: string }`.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const env = locals.runtime?.env ?? {};
    if (!env.PRESENCE_TICKET_SECRET) throw new AppError(503, 'presence_unavailable', 'Realtime presence is not configured');
    enforcePresenceTicketRateLimit(request, membersRuntime.now());
    const input = parsePresenceTicketRequest(await readJsonObject(request));
    return jsonOk(await issuePresenceTicket(request, env, input), 200, NO_STORE);
  } catch (err) {
    const res = errorResponse(err);
    res.headers.set('Cache-Control', 'no-store');
    if (err instanceof AppError && err.status === 429 && typeof err.extra.retry_after === 'number') {
      res.headers.set('Retry-After', String(err.extra.retry_after));
    }
    return res;
  }
};
