import type { D1DatabaseLike } from '../../db/store';
import type { RuntimeEnv } from '../../env';
import { isAdminIdentity } from '../members/admins';
import type { Row } from '../members/runtime';
import { iso, membersRuntime, randomId, str, strOrNull } from '../members/runtime';
import { isSameOriginRequest, resolveMemberSession } from '../members/session';
import type { UserRecord } from '../members/users';
import { logActivity } from '../members/users';
import type { OAuthClient } from './clients';
import { getClient, redirectDisplayHost, redirectUriAllowed } from './clients';
import type { OAuthScope } from './config';
import {
  DEFAULT_MEMBER_SCOPES, REQUEST_TTL_MS, canonicalResource, isOAuthScope, issuerFor, mcpResourceFor, parseScopeParam,
  parseStoredScopes, sortScopes,
} from './config';
import { OAuthError } from './errors';
import { createAuthorizationCode, recordConsent } from './tokens';

const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
const STATE_MAX = 500;

export interface PendingAuthorization {
  id: string;
  client_id: string;
  redirect_uri: string;
  state: string | null;
  scopes: OAuthScope[];
  resource: string;
  code_challenge: string;
  user_id: string | null;
  expires_at: string;
}

/** Outcome of an authorization step: render an error page (never redirect to an unverified URI) or redirect. */
export type AuthorizeOutcome =
  | { kind: 'error'; status: number; title: string; message: string }
  | { kind: 'redirect'; location: string };

function errorPage(status: number, title: string, message: string): AuthorizeOutcome {
  return { kind: 'error', status, title, message };
}

/** Builds the client redirect with RFC 9207 `iss` so clients can detect authorization-server mix-up. */
export function clientRedirect(redirectUri: string, issuer: string, params: Record<string, string | null>): string {
  const url = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== null) url.searchParams.set(k, v);
  url.searchParams.set('iss', issuer);
  return url.toString();
}

function rowToPending(row: Row): PendingAuthorization {
  return {
    id: str(row, 'id'),
    client_id: str(row, 'client_id'),
    redirect_uri: str(row, 'redirect_uri'),
    state: strOrNull(row, 'state'),
    scopes: parseStoredScopes(str(row, 'scopes')),
    resource: str(row, 'resource'),
    code_challenge: str(row, 'code_challenge'),
    user_id: strOrNull(row, 'user_id'),
    expires_at: str(row, 'expires_at'),
  };
}

/**
 * Validates an authorization request (RFC 6749 §4.1.1 + PKCE + RFC 8707) and parks it server-side so
 * the long parameters never travel through the login `next` URL. Client/redirect problems render an
 * error page; every other problem is reported to the verified redirect_uri.
 */
export async function startAuthorization(d1: D1DatabaseLike, request: Request): Promise<AuthorizeOutcome> {
  const url = new URL(request.url);
  const q = (k: string): string | null => url.searchParams.get(k);
  const issuer = issuerFor(request);

  const clientId = q('client_id');
  if (!clientId) return errorPage(400, 'Thiếu client_id', 'Ứng dụng đã gửi một yêu cầu uỷ quyền không hợp lệ (thiếu client_id).');
  let client: OAuthClient | null;
  try {
    client = await getClient(d1, clientId);
  } catch (err) {
    const message = err instanceof OAuthError ? err.description : 'Không đọc được thông tin ứng dụng.';
    return errorPage(400, 'Ứng dụng không hợp lệ', message);
  }
  if (!client) return errorPage(400, 'Ứng dụng chưa đăng ký', 'Không tìm thấy ứng dụng với client_id này. Hãy kết nối lại từ ứng dụng MCP của bạn.');
  const redirectUri = q('redirect_uri');
  if (!redirectUri || !redirectUriAllowed(client, redirectUri)) {
    return errorPage(400, 'Địa chỉ chuyển hướng không khớp', 'redirect_uri không khớp chính xác với địa chỉ ứng dụng đã đăng ký, nên Zuey sẽ không gửi mã uỷ quyền.');
  }

  const state = q('state');
  const fail = (error: string, description: string): AuthorizeOutcome => ({
    kind: 'redirect',
    location: clientRedirect(redirectUri, issuer, { error, error_description: description, state }),
  });
  if (state !== null && state.length > STATE_MAX) return fail('invalid_request', 'state is too long');
  if (q('response_type') !== 'code') return fail('unsupported_response_type', 'Only response_type=code is supported');
  const challenge = q('code_challenge');
  if (!challenge || q('code_challenge_method') !== 'S256' || !CHALLENGE_RE.test(challenge)) {
    return fail('invalid_request', 'PKCE is required: code_challenge (43 base64url characters) with code_challenge_method=S256');
  }
  if (q('prompt') === 'none') return fail('interaction_required', 'Zuey always asks the member to approve access');
  const requested = parseScopeParam(q('scope'));
  if (requested === null) return fail('invalid_scope', 'Unknown scope requested');
  const scopes = requested.length > 0 ? requested : [...DEFAULT_MEMBER_SCOPES];

  const expectedResource = mcpResourceFor(issuer);
  const rawResource = q('resource');
  if (rawResource !== null && canonicalResource(rawResource) !== expectedResource) {
    return fail('invalid_target', `resource must be ${expectedResource}`);
  }

  const now = membersRuntime.now();
  const id = randomId('oar');
  await d1.prepare(
    `INSERT INTO oauth_requests (id, client_id, redirect_uri, state, scopes, resource, code_challenge, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, client.client_id, redirectUri, state, JSON.stringify(sortScopes(scopes)), expectedResource, challenge, iso(now), iso(now + REQUEST_TTL_MS)).run();
  return { kind: 'redirect', location: `/oauth/authorize?request_id=${encodeURIComponent(id)}` };
}

export async function loadPendingAuthorization(d1: D1DatabaseLike, id: string): Promise<PendingAuthorization | null> {
  if (!/^oar_[a-f0-9]{20}$/.test(id)) return null;
  const row = await d1.prepare('SELECT * FROM oauth_requests WHERE id = ? AND completed_at IS NULL AND expires_at > ?')
    .bind(id, iso(membersRuntime.now())).first<Row>();
  return row ? rowToPending(row) : null;
}

export interface ScopeChoice {
  scope: OAuthScope;
  requested: boolean;
}

export interface ConsentView {
  request_id: string;
  client_name: string;
  client_id: string;
  client_uri: string | null;
  registration: 'dcr' | 'cimd';
  redirect_uri: string;
  redirect_host: string;
  resource: string;
  user_email: string;
  scopes: ScopeChoice[];
  expires_at: string;
}

export type ConsentLoad =
  | { kind: 'consent'; view: ConsentView }
  | { kind: 'login'; location: string }
  | AuthorizeOutcome;

/** Loads the consent screen for the signed-in member; the request is bound to the first member who opens it. */
export async function loadConsent(d1: D1DatabaseLike, env: RuntimeEnv, request: Request, requestId: string): Promise<ConsentLoad> {
  const pending = await loadPendingAuthorization(d1, requestId);
  if (!pending) return errorPage(400, 'Yêu cầu đã hết hạn', 'Yêu cầu uỷ quyền này không còn hiệu lực (quá 10 phút hoặc đã được xử lý). Hãy kết nối lại từ ứng dụng.');
  const session = await resolveMemberSession(request, d1);
  if (!session) return { kind: 'login', location: `/login?next=${encodeURIComponent(`/oauth/authorize?request_id=${pending.id}`)}` };
  const user = session.user;
  if (pending.user_id && pending.user_id !== user.id) {
    return errorPage(403, 'Yêu cầu thuộc tài khoản khác', 'Yêu cầu uỷ quyền này đã được mở bằng một tài khoản khác. Hãy kết nối lại từ ứng dụng.');
  }
  if (!pending.user_id) {
    await d1.prepare('UPDATE oauth_requests SET user_id = ? WHERE id = ? AND user_id IS NULL').bind(user.id, pending.id).run();
  }
  const client = await getClient(d1, pending.client_id).catch(() => null);
  if (!client || !redirectUriAllowed(client, pending.redirect_uri)) {
    return errorPage(400, 'Ứng dụng không còn hợp lệ', 'Thông tin đăng ký của ứng dụng đã thay đổi. Hãy kết nối lại từ ứng dụng.');
  }
  return { kind: 'consent', view: buildView(env, pending, client, user) };
}

function buildView(env: RuntimeEnv, pending: PendingAuthorization, client: OAuthClient, user: UserRecord): ConsentView {
  const admin = isAdminIdentity(user.email, user.email_verified_at, env);
  const offered = sortScopes([...pending.scopes.filter(s => s !== 'admin' || admin), ...(admin ? ['admin' as const] : [])]);
  return {
    request_id: pending.id,
    client_name: client.client_name,
    client_id: client.client_id,
    client_uri: client.client_uri,
    registration: client.source,
    redirect_uri: pending.redirect_uri,
    redirect_host: redirectDisplayHost(pending.redirect_uri),
    resource: pending.resource,
    user_email: user.email,
    scopes: offered.map(scope => ({ scope, requested: pending.scopes.includes(scope) })),
    expires_at: pending.expires_at,
  };
}

/**
 * Handles the consent form POST. Requires the member session, a same-origin request (CSRF) and the
 * member the request is bound to. Each pending request can be decided exactly once.
 */
export async function decideConsent(d1: D1DatabaseLike, env: RuntimeEnv, request: Request, form: URLSearchParams): Promise<AuthorizeOutcome> {
  if (!isSameOriginRequest(request)) return errorPage(403, 'Yêu cầu bị chặn', 'Biểu mẫu đồng ý phải được gửi từ chính zuey.me.');
  const session = await resolveMemberSession(request, d1);
  if (!session) return errorPage(401, 'Phiên đăng nhập đã hết hạn', 'Hãy đăng nhập lại rồi kết nối lại từ ứng dụng.');
  const pending = await loadPendingAuthorization(d1, form.get('request_id') ?? '');
  if (!pending) return errorPage(400, 'Yêu cầu đã hết hạn', 'Yêu cầu uỷ quyền này không còn hiệu lực. Hãy kết nối lại từ ứng dụng.');
  if (pending.user_id !== session.user.id) return errorPage(403, 'Yêu cầu thuộc tài khoản khác', 'Yêu cầu này không thuộc tài khoản đang đăng nhập.');
  const client = await getClient(d1, pending.client_id).catch(() => null);
  if (!client || !redirectUriAllowed(client, pending.redirect_uri)) {
    return errorPage(400, 'Ứng dụng không còn hợp lệ', 'Thông tin đăng ký của ứng dụng đã thay đổi. Hãy kết nối lại từ ứng dụng.');
  }

  const decision = form.get('decision');
  const issuer = issuerFor(request);
  const view = buildView(env, pending, client, session.user);
  const offered = view.scopes.map(s => s.scope);
  const chosen = sortScopes(form.getAll('scope').filter(isOAuthScope).filter(s => offered.includes(s)));
  if (decision === 'approve' && chosen.length === 0) {
    return { kind: 'redirect', location: `/oauth/authorize?request_id=${encodeURIComponent(pending.id)}&error=no_scope` };
  }

  const claim = await d1.prepare('UPDATE oauth_requests SET completed_at = ? WHERE id = ? AND completed_at IS NULL')
    .bind(iso(membersRuntime.now()), pending.id).run();
  if (!claim.meta?.changes) return errorPage(409, 'Yêu cầu đã được xử lý', 'Yêu cầu uỷ quyền này đã được xử lý trước đó.');

  if (decision !== 'approve') {
    await logActivity(d1, session.user.id, 'oauth.denied', { client_id: client.client_id, client_name: client.client_name }, request);
    return { kind: 'redirect', location: clientRedirect(pending.redirect_uri, issuer, { error: 'access_denied', error_description: 'The member denied access', state: pending.state }) };
  }

  await recordConsent(d1, session.user.id, client.client_id, chosen);
  const code = await createAuthorizationCode(d1, {
    clientId: client.client_id, userId: session.user.id, redirectUri: pending.redirect_uri, codeChallenge: pending.code_challenge,
    scopes: chosen, resource: pending.resource,
  });
  await logActivity(d1, session.user.id, 'oauth.granted', { client_id: client.client_id, client_name: client.client_name, scopes: chosen }, request);
  return { kind: 'redirect', location: clientRedirect(pending.redirect_uri, issuer, { code, state: pending.state }) };
}
