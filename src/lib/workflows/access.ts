import type { D1DatabaseLike } from '../../db/store';
import { verifySession } from '../../db/store';
import { authenticateAdmin, extractSessionCookie } from '../auth';
import { AppError } from '../http';
import type { WorkflowActor } from './store';

/** Which credential authorised an admin write; Studio sessions win over API keys like authenticateRequest. */
export async function resolveActor(request: Request, d1?: D1DatabaseLike): Promise<WorkflowActor> {
  const token = extractSessionCookie(request.headers.get('cookie') || '');
  if (token && (await verifySession(token, d1))) return 'session';
  return 'api_key';
}

/** Throws 401 (no/invalid credentials) or 403 (read-only key) unless the caller is an admin. */
export async function requireWorkflowAdmin(request: Request, d1?: D1DatabaseLike): Promise<WorkflowActor> {
  const auth = await authenticateAdmin(request, d1);
  if (!auth.authenticated) {
    const forbidden = auth.role === 'read';
    throw new AppError(forbidden ? 403 : 401, forbidden ? 'forbidden' : 'unauthorized', auth.error || 'Unauthorized');
  }
  return resolveActor(request, d1);
}

/** `?include_drafts=1|true` asks for admin views (drafts, revisions, findings). */
export function wantsDrafts(url: URL): boolean {
  const v = url.searchParams.get('include_drafts');
  return v === '1' || v === 'true';
}
