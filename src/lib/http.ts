/** Shared JSON response helpers so every REST route returns the same envelope. */

export function jsonOk(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ success: true, data }), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

export function jsonError(status: number, code: string, message: string, extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ success: false, error: { code, message, ...extra } }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Parses a JSON object body; returns null for invalid JSON or non-object payloads. */
export async function readJsonObject(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json();
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      return Object.fromEntries(Object.entries(body));
    }
    return null;
  } catch {
    return null;
  }
}

/** Errors thrown by feature modules that map directly onto an HTTP status. */
export class AppError extends Error {
  constructor(public status: number, public code: string, message: string, public extra: Record<string, unknown> = {}) {
    super(message);
  }
}

export function errorResponse(err: unknown): Response {
  if (err instanceof AppError) return jsonError(err.status, err.code, err.message, err.extra);
  console.error('Unhandled API error:', err instanceof Error ? err.message : 'unknown');
  return jsonError(500, 'internal_error', 'Internal server error');
}

export const REQUEST_ID_HEADER = 'X-Request-Id';
const INBOUND_REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/;

/** Reuses a well-formed inbound X-Request-Id (proxy/client correlation) or mints a new one. */
export function resolveRequestId(request: Request): string {
  const inbound = request.headers.get(REQUEST_ID_HEADER);
  if (inbound && INBOUND_REQUEST_ID.test(inbound)) return inbound;
  return `req_${crypto.randomUUID().replace(/-/g, '')}`;
}

/**
 * Stamps the request id on the response and, for the JSON error envelope (`success: false`), adds
 * `error.request_id` so a member can quote it in a support request. Other bodies pass through untouched.
 * The returned response always has mutable headers (fetch/redirect responses do not).
 */
export async function withRequestId(response: Response, requestId: string): Promise<Response> {
  let out = response;
  try {
    out.headers.set(REQUEST_ID_HEADER, requestId);
  } catch {
    out = new Response(response.body, response);
    out.headers.set(REQUEST_ID_HEADER, requestId);
  }
  const type = out.headers.get('Content-Type') ?? '';
  if (out.status < 400 || !type.includes('application/json') || out.body === null) return out;
  const text = await out.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  if (body && typeof body === 'object' && !Array.isArray(body) && 'success' in body && body.success === false
    && 'error' in body && body.error && typeof body.error === 'object' && !Array.isArray(body.error)) {
    const envelope = { ...body, error: { ...body.error, request_id: requestId } };
    const headers = new Headers(out.headers);
    headers.delete('Content-Length');
    return new Response(JSON.stringify(envelope), { status: out.status, statusText: out.statusText, headers });
  }
  return new Response(text, { status: out.status, statusText: out.statusText, headers: out.headers });
}

export function getString(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === 'string' ? v : undefined;
}

export function getNumber(obj: Record<string, unknown>, key: string): number | undefined {
  const v = obj[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
