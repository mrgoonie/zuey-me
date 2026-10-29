/**
 * zuey-me-presence: public edge of zuey.me realtime presence (https://presence.zuey.me).
 *
 *   GET /v1/health      liveness
 *   GET /v1/snapshot    aggregated PresenceSnapshot (CORS for zuey.me origins; memo + edge cache, see snapshot-cache.ts)
 *   GET /v1/history     24 h PresenceHistory in 5-minute buckets (same CORS; cached for a minute)
 *   GET|PUT /internal/owner  owner status control for the Pages app only (see internal-owner-route.ts)
 *   GET /internal/diagnostics  hub diagnostics for the Pages app only (see internal-diagnostics-route.ts)
 *   GET /v1/connect     WebSocket upgrade, forwarded to the single PresenceHub Durable Object. The ticket travels
 *                       in `Sec-WebSocket-Protocol: zuey-presence.v1, <ticket>`, never in the URL (logs record URLs).
 *
 * Tickets are verified here (HMAC, expiry) before any upgrade; the hub only ever sees the verified identity
 * plus a truncated HMAC of the client IP (IPv6: its /64). Raw IPs, user agents, tickets and ids are never
 * stored, forwarded or logged.
 */
import { PRESENCE_SUBPROTOCOL } from '../../../src/lib/presence/contract';
import { presenceIpKey } from '../../../src/lib/presence/ip-prefix';
import { hmacBase64Url, verifyPresenceTicket } from '../../../src/lib/presence/ticket';
import { INTERNAL_DIAGNOSTICS_PATH, handleInternalDiagnostics } from './internal-diagnostics-route';
import { INTERNAL_OWNER_PATH, handleInternalOwner } from './internal-owner-route';
import { PresenceHub, SESSION_HEADER } from './presence-hub';
import type { SessionIdentity } from './presence-state';
import type { PresenceEnv } from './runtime-types';
import { HISTORY_EDGE_CACHE_SECONDS, SNAPSHOT_EDGE_CACHE_SECONDS, cachedHistory, cachedSnapshot, isPresenceHistory, isPresenceSnapshot } from './snapshot-cache';

export { PresenceHub };

export const ALLOWED_ORIGINS: readonly string[] = ['https://zuey.me', 'https://www.zuey.me'];
/** Local `bun run dev` origins, allowed only when the Worker runs with PRESENCE_DEV_ORIGINS=1 (local `.dev.vars`). */
export const DEV_ORIGINS: readonly string[] = ['http://localhost:4321', 'http://127.0.0.1:4321'];

/** Name of the one hub instance; presence is global, so a single object sees every socket. */
const HUB_NAME = 'global';
/** Internal origin for Worker -> DO requests (never resolved over the network). */
const HUB_URL = 'https://presence-hub.internal';
const IP_HASH_LENGTH = 16;

type ErrorCode = 'not_found' | 'forbidden' | 'unauthorized' | 'unavailable' | 'upgrade_required' | 'method_not_allowed'
  | 'bad_request' | 'payload_too_large';

function errorResponse(status: number, code: ErrorCode, message: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ success: false, error: { code, message } }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}

function corsHeaders(origin: string | null): Record<string, string> {
  const headers: Record<string, string> = { Vary: 'Origin' };
  if (origin) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Methods'] = 'GET, OPTIONS';
    headers['Access-Control-Max-Age'] = '86400';
  }
  return headers;
}

export function isAllowedOrigin(origin: string | null, env: PresenceEnv): origin is string {
  if (origin === null) return false;
  return ALLOWED_ORIGINS.includes(origin) || (env.PRESENCE_DEV_ORIGINS === '1' && DEV_ORIGINS.includes(origin));
}

const hubStub = (env: PresenceEnv) => env.PRESENCE_HUB.get(env.PRESENCE_HUB.idFromName(HUB_NAME));

/** Reads one public aggregate from the hub; null for a failed or malformed answer. */
async function readHub<T>(env: PresenceEnv, path: string, isValid: (v: unknown) => v is T): Promise<T | null> {
  const res = await hubStub(env).fetch(new Request(`${HUB_URL}${path}`));
  const body: unknown = res.ok ? await res.json() : null;
  return isValid(body) ? body : null;
}

/** A cached public read: the aggregate with per-request CORS, or 503 when none is available. */
function publicRead(current: unknown, origin: string | null, maxAgeSeconds: number): Response {
  if (!current) return errorResponse(503, 'unavailable', 'Presence is temporarily unavailable', corsHeaders(origin));
  return new Response(JSON.stringify(current), {
    status: 200,
    headers: { ...corsHeaders(origin), 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': `public, max-age=${maxAgeSeconds}` },
  });
}

async function snapshot(env: PresenceEnv, url: URL, origin: string | null): Promise<Response> {
  const current = await cachedSnapshot(url.origin, () => readHub(env, '/snapshot', isPresenceSnapshot));
  return publicRead(current, origin, SNAPSHOT_EDGE_CACHE_SECONDS);
}

async function history(env: PresenceEnv, url: URL, origin: string | null): Promise<Response> {
  const current = await cachedHistory(url.origin, () => readHub(env, '/history', isPresenceHistory));
  return publicRead(current, origin, HISTORY_EDGE_CACHE_SECONDS);
}

/**
 * Ticket offered as a WebSocket subprotocol: the header must list PRESENCE_SUBPROTOCOL plus exactly one
 * other entry (the ticket). Returns '' when absent, so verification fails closed.
 */
export function ticketFromProtocols(header: string | null): string {
  const offered = (header ?? '').split(',').map(p => p.trim()).filter(p => p.length > 0);
  if (!offered.includes(PRESENCE_SUBPROTOCOL)) return '';
  const others = offered.filter(p => p !== PRESENCE_SUBPROTOCOL);
  return others.length === 1 ? (others[0] ?? '') : '';
}

async function connect(request: Request, env: PresenceEnv): Promise<Response> {
  const secret = env.PRESENCE_TICKET_SECRET;
  if (!secret) return errorResponse(503, 'unavailable', 'Presence is not configured');
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
    return errorResponse(426, 'upgrade_required', 'Expected a WebSocket upgrade', { Upgrade: 'websocket' });
  }
  const ticket = await verifyPresenceTicket(secret, ticketFromProtocols(request.headers.get('Sec-WebSocket-Protocol')));
  if (!ticket) return errorResponse(401, 'unauthorized', 'Invalid or expired ticket');

  const ip = presenceIpKey(request.headers.get('CF-Connecting-IP') ?? '') || 'unknown';
  const identity: SessionIdentity = {
    k: ticket.k, c: ticket.c, m: ticket.m, o: ticket.o,
    ipHash: (await hmacBase64Url(secret, `ip:${ip}`)).slice(0, IP_HASH_LENGTH),
  };
  try {
    const stub = hubStub(env);
    // A fresh request: no client headers (cookies, the ticket, spoofed session headers) reach the hub.
    return await stub.fetch(new Request(`${HUB_URL}/connect`, {
      headers: { Upgrade: 'websocket', [SESSION_HEADER]: JSON.stringify(identity) },
    }));
  } catch (err) {
    console.error('presence connect failed', err instanceof Error ? err.message : 'unknown error');
    return errorResponse(503, 'unavailable', 'Presence is temporarily unavailable');
  }
}

export async function handleRequest(request: Request, env: PresenceEnv): Promise<Response> {
  const url = new URL(request.url);
  const route = url.pathname;
  if (route === INTERNAL_OWNER_PATH) return handleInternalOwner(request, env, () => hubStub(env), HUB_URL, errorResponse);
  if (route === INTERNAL_DIAGNOSTICS_PATH) return handleInternalDiagnostics(request, env, () => hubStub(env), HUB_URL, errorResponse);
  if (route !== '/v1/health' && route !== '/v1/snapshot' && route !== '/v1/history' && route !== '/v1/connect') {
    return errorResponse(404, 'not_found', 'Not found');
  }

  const origin = request.headers.get('Origin');
  const originAllowed = isAllowedOrigin(origin, env);

  if (route === '/v1/health') {
    if (request.method !== 'GET' && request.method !== 'HEAD') return errorResponse(405, 'method_not_allowed', 'Method not allowed');
    return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
  }

  if (route === '/v1/snapshot' || route === '/v1/history') {
    // Server-to-server reads carry no Origin and get no CORS headers; browsers must come from an allowed origin.
    if (origin !== null && !originAllowed) return errorResponse(403, 'forbidden', 'Origin not allowed', { Vary: 'Origin' });
    const corsOrigin = originAllowed ? origin : null;
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(corsOrigin) });
    if (request.method !== 'GET' && request.method !== 'HEAD') return errorResponse(405, 'method_not_allowed', 'Method not allowed', corsHeaders(corsOrigin));
    return route === '/v1/snapshot' ? snapshot(env, url, corsOrigin) : history(env, url, corsOrigin);
  }

  // /v1/connect: browsers always send Origin on a WebSocket handshake, so a missing one is refused too.
  if (!originAllowed) return errorResponse(403, 'forbidden', 'Origin not allowed');
  if (request.method !== 'GET') return errorResponse(405, 'method_not_allowed', 'Method not allowed');
  return connect(request, env);
}

export default {
  async fetch(request: Request, env: PresenceEnv): Promise<Response> {
    try {
      return await handleRequest(request, env);
    } catch (err) {
      console.error('presence worker failed', err instanceof Error ? err.message : 'unknown error');
      return errorResponse(500, 'unavailable', 'Presence is temporarily unavailable');
    }
  },
};
