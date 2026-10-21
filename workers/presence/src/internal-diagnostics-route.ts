/**
 * `GET /internal/diagnostics`: hub diagnostics (PresenceDiagnostics, counts and timings only), Pages -> Worker
 * only. Guarded exactly like `/internal/owner`: a missing, stale or wrong PRESENCE_INTERNAL_HEADER gets the same
 * 404 as an unknown path, a Worker without the secret answers 503, and there are never CORS headers.
 */
import { isInternalCaller, relay, type ErrorResponder } from './internal-owner-route';
import type { DurableObjectStubLike, PresenceEnv } from './runtime-types';

export const INTERNAL_DIAGNOSTICS_PATH = '/internal/diagnostics';

export async function handleInternalDiagnostics(
  request: Request, env: PresenceEnv, hub: () => DurableObjectStubLike, hubUrl: string, error: ErrorResponder,
): Promise<Response> {
  const secret = env.PRESENCE_TICKET_SECRET;
  if (!secret) return error(503, 'unavailable', 'Presence is not configured');
  if (!(await isInternalCaller(request, secret))) return error(404, 'not_found', 'Not found');
  if (request.method !== 'GET') return error(405, 'method_not_allowed', 'Method not allowed', { Allow: 'GET' });
  try {
    return await relay(await hub().fetch(new Request(`${hubUrl}/diagnostics`)));
  } catch (err) {
    console.error('presence diagnostics request failed', err instanceof Error ? err.message : 'unknown error');
    return error(503, 'unavailable', 'Presence is temporarily unavailable');
  }
}
