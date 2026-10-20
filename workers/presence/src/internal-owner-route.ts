/**
 * `/internal/owner`: owner status control, Pages -> Worker only (service binding, HTTP fallback in dev).
 *
 *   GET  /internal/owner   OwnerStatusState
 *   PUT  /internal/owner   OwnerStatusUpdate JSON (<= INTERNAL_MAX_BODY_BYTES) -> OwnerStatusState
 *
 * Auth: PRESENCE_INTERNAL_HEADER must be a fresh `<unixSeconds>.<hmac>` value (verifyPresenceInternal: within
 * PRESENCE_INTERNAL_MAX_SKEW_MS of now, HMAC compared in constant time). A missing or wrong header gets the same 404 as an unknown path, so the route is
 * not revealed; a Worker without the secret answers 503. No CORS: browsers never call this route.
 */
import { PRESENCE_INTERNAL_HEADER } from '../../../src/lib/presence/contract';
import { verifyPresenceInternal } from '../../../src/lib/presence/internal-auth';
import { parseOwnerStatusUpdate, toOwnerStatusUpdate } from './owner-status';
import type { DurableObjectStubLike, PresenceEnv } from './runtime-types';

export const INTERNAL_OWNER_PATH = '/internal/owner';
export const INTERNAL_MAX_BODY_BYTES = 1024;
export type InternalErrorCode = 'not_found' | 'unavailable' | 'bad_request' | 'payload_too_large' | 'method_not_allowed';
export type ErrorResponder = (status: number, code: InternalErrorCode, message: string, headers?: Record<string, string>) => Response;

/** True when the request carries a fresh, correctly signed PRESENCE_INTERNAL_HEADER. */
export function isInternalCaller(request: Request, secret: string, nowMs = Date.now()): Promise<boolean> {
  return verifyPresenceInternal(secret, request.headers.get(PRESENCE_INTERNAL_HEADER), nowMs);
}

/** Reads at most `limit` bytes of the body; null when it is larger. */
export async function readBodyLimited(request: Request, limit: number): Promise<string | null> {
  const declared = Number(request.headers.get('Content-Length') ?? '0');
  if (Number.isFinite(declared) && declared > limit) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** Copies the hub answer with no-store caching (no CORS headers, ever). */
async function relay(res: Response): Promise<Response> {
  return new Response(await res.text(), {
    status: res.status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export async function handleInternalOwner(
  request: Request, env: PresenceEnv, hub: () => DurableObjectStubLike, hubUrl: string, error: ErrorResponder,
): Promise<Response> {
  const secret = env.PRESENCE_TICKET_SECRET;
  if (!secret) return error(503, 'unavailable', 'Presence is not configured');
  if (!(await isInternalCaller(request, secret))) return error(404, 'not_found', 'Not found');

  const callHub = async (req: Request): Promise<Response> => {
    try {
      return await relay(await hub().fetch(req));
    } catch (err) {
      console.error('presence owner request failed', err instanceof Error ? err.message : 'unknown error');
      return error(503, 'unavailable', 'Presence is temporarily unavailable');
    }
  };

  if (request.method === 'GET') return callHub(new Request(`${hubUrl}/owner`));
  if (request.method !== 'PUT') return error(405, 'method_not_allowed', 'Method not allowed', { Allow: 'GET, PUT' });

  const raw = await readBodyLimited(request, INTERNAL_MAX_BODY_BYTES);
  if (raw === null) return error(413, 'payload_too_large', `Body must be at most ${INTERNAL_MAX_BODY_BYTES} bytes`);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return error(400, 'bad_request', 'Body must be JSON');
  }
  const update = parseOwnerStatusUpdate(body);
  if (!update.ok) return error(400, 'bad_request', update.message);
  // A fresh request carrying only the validated update; no client headers reach the hub.
  return callHub(new Request(`${hubUrl}/owner`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(toOwnerStatusUpdate(update.mode, update.text)),
  }));
}
