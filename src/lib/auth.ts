import { getApiKeyRole, verifySession } from '../db/store';
import type { D1DatabaseLike } from '../db/store';

export function extractSessionCookie(cookieHeader: string): string | null {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(/(?:^|;\s*)zuey_session=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

function extractApiToken(request: Request): string {
  const authHeader = request.headers.get('authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) return authHeader.substring(7).trim();
  return (request.headers.get('x-api-key') || '').trim();
}

export interface AuthResult {
  authenticated: boolean;
  /** 'admin' for Studio sessions and admin keys, 'read' for read-only keys. */
  role?: 'admin' | 'read';
  error?: string;
}

export async function authenticateRequest(
  request: Request,
  d1?: D1DatabaseLike
): Promise<AuthResult> {
  // 1. Studio session cookie (only admins can sign in to Studio)
  const sessionToken = extractSessionCookie(request.headers.get('cookie') || '');
  if (sessionToken && await verifySession(sessionToken, d1)) {
    return { authenticated: true, role: 'admin' };
  }

  // 2. API key via Bearer or X-API-Key
  const token = extractApiToken(request);
  if (!token) {
    return { authenticated: false, error: 'Unauthorized: missing or invalid session/API key' };
  }

  const role = await getApiKeyRole(token, d1);
  if (!role) {
    return { authenticated: false, error: 'Invalid or revoked API key' };
  }

  return { authenticated: true, role };
}

/** Requires a Studio session or an API key with the admin role. */
export async function authenticateAdmin(request: Request, d1?: D1DatabaseLike): Promise<AuthResult> {
  const auth = await authenticateRequest(request, d1);
  if (auth.authenticated && auth.role !== 'admin') {
    return { authenticated: false, role: auth.role, error: 'Forbidden: admin API key required' };
  }
  return auth;
}
