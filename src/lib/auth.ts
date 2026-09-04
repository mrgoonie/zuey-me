import { verifyApiKey } from '../db/store';
import type { D1DatabaseLike } from '../db/store';

export async function authenticateRequest(
  request: Request,
  d1?: D1DatabaseLike
): Promise<{ authenticated: boolean; error?: string }> {
  const authHeader = request.headers.get('authorization');
  const apiKeyHeader = request.headers.get('x-api-key');

  let token = '';
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7).trim();
  } else if (apiKeyHeader) {
    token = apiKeyHeader.trim();
  }

  // Also check studio session cookie
  const cookie = request.headers.get('cookie') || '';
  if (cookie.includes('zuey_session=authenticated')) {
    return { authenticated: true };
  }

  if (!token) {
    return { authenticated: false, error: 'Missing Authorization header or X-API-Key' };
  }

  const isValid = await verifyApiKey(token, d1);
  if (!isValid) {
    return { authenticated: false, error: 'Invalid or revoked API key' };
  }

  return { authenticated: true };
}
