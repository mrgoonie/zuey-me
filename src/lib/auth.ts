import { verifyApiKey, verifySession } from '../db/store';
import type { D1DatabaseLike } from '../db/store';

function extractSessionCookie(cookieHeader: string): string | null {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(/(?:^|;\s*)zuey_session=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

export async function authenticateRequest(
  request: Request,
  d1?: D1DatabaseLike
): Promise<{ authenticated: boolean; error?: string }> {
  // 1. Check studio session cookie
  const cookieHeader = request.headers.get('cookie') || '';
  const sessionToken = extractSessionCookie(cookieHeader);
  if (sessionToken) {
    const isSessionValid = await verifySession(sessionToken, d1);
    if (isSessionValid) {
      return { authenticated: true };
    }
  }

  // 2. Check API key Bearer or X-API-Key
  const authHeader = request.headers.get('authorization');
  const apiKeyHeader = request.headers.get('x-api-key');

  let token = '';
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7).trim();
  } else if (apiKeyHeader) {
    token = apiKeyHeader.trim();
  }

  if (!token) {
    return { authenticated: false, error: 'Unauthorized: missing or invalid session/API key' };
  }

  const isValid = await verifyApiKey(token, d1);
  if (!isValid) {
    return { authenticated: false, error: 'Invalid or revoked API key' };
  }

  return { authenticated: true };
}
