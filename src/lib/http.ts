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

export function getString(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === 'string' ? v : undefined;
}

export function getNumber(obj: Record<string, unknown>, key: string): number | undefined {
  const v = obj[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
