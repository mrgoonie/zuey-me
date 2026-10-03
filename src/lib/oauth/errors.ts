/** OAuth protocol error (RFC 6749 §5.2 / RFC 7591 §3.2.2) returned as `{ error, error_description }`. */
export class OAuthError extends Error {
  constructor(
    public status: number,
    public error: string,
    public description: string,
    public headers: Record<string, string> = {},
  ) {
    super(description);
  }
}

export const NO_STORE_HEADERS = { 'Cache-Control': 'no-store', Pragma: 'no-cache' };

export function oauthJson(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...NO_STORE_HEADERS, ...headers },
  });
}

export function oauthErrorResponse(err: unknown): Response {
  if (err instanceof OAuthError) {
    return oauthJson({ error: err.error, error_description: err.description }, err.status, err.headers);
  }
  console.error('OAuth endpoint error:', err instanceof Error ? err.message : 'unknown');
  return oauthJson({ error: 'server_error', error_description: 'Internal server error' }, 500);
}

/** Reads an `application/x-www-form-urlencoded` (or JSON object) body into string fields. */
export async function readFormBody(request: Request): Promise<Record<string, string>> {
  const type = (request.headers.get('content-type') || '').toLowerCase();
  const out: Record<string, string> = {};
  try {
    if (type.includes('application/json')) {
      const body: unknown = await request.json();
      if (body && typeof body === 'object' && !Array.isArray(body)) {
        for (const [k, v] of Object.entries(body)) if (typeof v === 'string') out[k] = v;
      }
      return out;
    }
    const text = await request.text();
    if (text.length > 16_384) throw new OAuthError(400, 'invalid_request', 'Request body too large');
    for (const [k, v] of new URLSearchParams(text)) {
      // Repeated parameters are invalid (RFC 6749 §3.1).
      if (k in out) throw new OAuthError(400, 'invalid_request', `Parameter ${k} must not be repeated`);
      out[k] = v;
    }
    return out;
  } catch (err) {
    if (err instanceof OAuthError) throw err;
    throw new OAuthError(400, 'invalid_request', 'Malformed request body');
  }
}
