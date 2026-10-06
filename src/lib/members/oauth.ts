import type { D1DatabaseLike } from '../../db/store';
import type { RuntimeEnv } from '../../env';
import { AppError } from '../http';
import { timingSafeEqualStrings } from '../payments/sepay';
import type { Row } from './runtime';
import { base64Url, iso, isUniqueViolation, membersRuntime, randomId, randomSecret, safeNextPath, str } from './runtime';
import { createMemberSession, isSameOriginRequest, memberCookie, readCookie, resolveMemberSession } from './session';
import type { UserRecord } from './users';
import { findOrCreateVerifiedUser, getUserById, logActivity, normalizeEmail } from './users';

export type OAuthProvider = 'google' | 'github';
export const OAUTH_PROVIDERS: OAuthProvider[] = ['google', 'github'];
export const MEMBER_OAUTH_COOKIE = 'zuey_member_oauth';
const STATE_TTL_SECONDS = 600;
const UA = 'zuey-me-members';

export function isOAuthProvider(v: unknown): v is OAuthProvider {
  return v === 'google' || v === 'github';
}

interface OAuthCredentials {
  clientId: string;
  clientSecret: string;
}

function credentials(env: RuntimeEnv, provider: OAuthProvider): OAuthCredentials | null {
  const id = (provider === 'google' ? env.GOOGLE_CLIENT_ID : env.GITHUB_CLIENT_ID)?.trim();
  const secret = (provider === 'google' ? env.GOOGLE_CLIENT_SECRET : env.GITHUB_CLIENT_SECRET)?.trim();
  return id && secret ? { clientId: id, clientSecret: secret } : null;
}

/** Member sign-in reuses the provider callback URLs already registered for Studio; `state` routes it. */
export function callbackUrl(request: Request, provider: OAuthProvider): string {
  return `${new URL(request.url).origin}/api/auth/${provider}/callback`;
}

function stateCookie(value: string, maxAge: number): string {
  return `${MEMBER_OAUTH_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ Location: location, 'Cache-Control': 'no-store' });
  for (const c of cookies) headers.append('Set-Cookie', c);
  return new Response(null, { status: 302, headers });
}

function loginError(code: string): Response {
  return redirect(`/login?error=${encodeURIComponent(code)}`, [stateCookie('', 0)]);
}

/** Starts member OAuth: binds a random state to this browser via a short-lived HttpOnly cookie. */
export function startMemberOAuth(request: Request, env: RuntimeEnv, provider: OAuthProvider): Response {
  const creds = credentials(env, provider);
  if (!creds) return redirect(`/login?error=${provider}_unconfigured`);
  const next = safeNextPath(new URL(request.url).searchParams.get('next'));
  const state = randomSecret(24);
  const cookieValue = `${provider}.${state}.${base64Url(new TextEncoder().encode(next))}`;
  const redirectUri = callbackUrl(request, provider);
  const url = provider === 'google'
    ? `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
      client_id: creds.clientId, redirect_uri: redirectUri, response_type: 'code', scope: 'openid email profile', state, prompt: 'select_account',
    })}`
    : `https://github.com/login/oauth/authorize?${new URLSearchParams({
      client_id: creds.clientId, redirect_uri: redirectUri, scope: 'read:user user:email', state, allow_signup: 'true',
    })}`;
  return redirect(url, [stateCookie(cookieValue, STATE_TTL_SECONDS)]);
}

interface StateCookie {
  provider: OAuthProvider;
  state: string;
  next: string;
}

function parseStateCookie(request: Request): StateCookie | null {
  const raw = readCookie(request, MEMBER_OAUTH_COOKIE);
  if (!raw) return null;
  const [provider, state, nextB64] = raw.split('.');
  if (!isOAuthProvider(provider) || !state || nextB64 === undefined) return null;
  let next = '/account';
  try {
    const bin = atob(nextB64.replace(/-/g, '+').replace(/_/g, '/'));
    next = safeNextPath(new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))));
  } catch {
    next = '/account';
  }
  return { provider, state, next };
}

/** True when this provider callback belongs to a member sign-in started by this browser. */
export function isMemberOAuthCallback(request: Request, provider: OAuthProvider): boolean {
  const cookie = parseStateCookie(request);
  return cookie !== null && cookie.provider === provider && new URL(request.url).searchParams.has('state');
}

// ---------------------------------------------------------------------------
// Provider profile fetches
// ---------------------------------------------------------------------------

export interface OAuthProfile {
  provider: OAuthProvider;
  subject: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  avatarUrl: string | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

async function readJson(res: Response): Promise<unknown> {
  return res.json().catch(() => null);
}

async function fetchGoogleProfile(creds: OAuthCredentials, code: string, redirectUri: string): Promise<OAuthProfile> {
  const f = membersRuntime.fetch;
  const tokenRes = await f('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: creds.clientId, client_secret: creds.clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' }).toString(),
  });
  const tokenBody = await readJson(tokenRes);
  const accessToken = isRecord(tokenBody) && typeof tokenBody.access_token === 'string' ? tokenBody.access_token : null;
  if (!accessToken) throw new AppError(502, 'oauth_token_failed', 'Google token exchange failed');
  const userRes = await f('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${accessToken}` } });
  const u = await readJson(userRes);
  if (!userRes.ok || !isRecord(u) || typeof u.sub !== 'string') throw new AppError(502, 'oauth_profile_failed', 'Could not read the Google profile');
  return {
    provider: 'google',
    subject: u.sub,
    email: typeof u.email === 'string' ? u.email : null,
    emailVerified: u.email_verified === true,
    name: typeof u.name === 'string' ? u.name : null,
    avatarUrl: typeof u.picture === 'string' ? u.picture : null,
  };
}

async function fetchGithubProfile(creds: OAuthCredentials, code: string, redirectUri: string): Promise<OAuthProfile> {
  const f = membersRuntime.fetch;
  const tokenRes = await f('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': UA },
    body: JSON.stringify({ client_id: creds.clientId, client_secret: creds.clientSecret, code, redirect_uri: redirectUri }),
  });
  const tokenBody = await readJson(tokenRes);
  const accessToken = isRecord(tokenBody) && typeof tokenBody.access_token === 'string' ? tokenBody.access_token : null;
  if (!accessToken) throw new AppError(502, 'oauth_token_failed', 'GitHub token exchange failed');
  return githubProfileFromToken(accessToken);
}

/** Reads the GitHub profile and its verified email with an access token already exchanged. */
export async function githubProfileFromToken(accessToken: string): Promise<OAuthProfile> {
  const f = membersRuntime.fetch;
  const headers = { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', 'User-Agent': UA };
  const userRes = await f('https://api.github.com/user', { headers });
  const u = await readJson(userRes);
  if (!userRes.ok || !isRecord(u) || (typeof u.id !== 'number' && typeof u.id !== 'string')) {
    throw new AppError(502, 'oauth_profile_failed', 'Could not read the GitHub profile');
  }
  // Only a verified address counts; prefer the primary one.
  let email: string | null = null;
  const emailsRes = await f('https://api.github.com/user/emails', { headers });
  const emails = emailsRes.ok ? await readJson(emailsRes) : null;
  if (Array.isArray(emails)) {
    const verified = emails.filter(isRecord).filter(e => e.verified === true && typeof e.email === 'string');
    const chosen = verified.find(e => e.primary === true) ?? verified[0];
    email = chosen && typeof chosen.email === 'string' ? chosen.email : null;
  }
  return {
    provider: 'github',
    subject: String(u.id),
    email,
    emailVerified: email !== null,
    name: typeof u.name === 'string' ? u.name : typeof u.login === 'string' ? u.login : null,
    avatarUrl: typeof u.avatar_url === 'string' ? u.avatar_url : null,
  };
}

// ---------------------------------------------------------------------------
// Identity linking
// ---------------------------------------------------------------------------

async function insertIdentity(d1: D1DatabaseLike, userId: string, profile: OAuthProfile): Promise<void> {
  try {
    await d1.prepare('INSERT INTO user_identities (id, user_id, provider, subject, email, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(randomId('uid'), userId, profile.provider, profile.subject, profile.email ? profile.email.toLowerCase() : null, iso(membersRuntime.now())).run();
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const row = await d1.prepare('SELECT user_id FROM user_identities WHERE provider = ? AND subject = ?').bind(profile.provider, profile.subject).first<Row>();
    if (!row || str(row, 'user_id') !== userId) throw new AppError(409, 'identity_linked_elsewhere', 'This account is already linked to another Zuey member');
  }
}

/**
 * Resolves the member for a provider identity:
 * known identity → its member; signed-in member → link to them; otherwise a VERIFIED provider
 * email finds or creates the member (unverified emails never create or claim an account).
 */
export async function completeOAuthLogin(
  d1: D1DatabaseLike, profile: OAuthProfile, currentUserId: string | null,
): Promise<{ user: UserRecord; created: boolean; linked: boolean }> {
  const identity = await d1.prepare('SELECT user_id FROM user_identities WHERE provider = ? AND subject = ?')
    .bind(profile.provider, profile.subject).first<Row>();
  if (identity) {
    const owner = await getUserById(d1, str(identity, 'user_id'));
    if (owner) {
      if (currentUserId && currentUserId !== owner.id) {
        throw new AppError(409, 'identity_linked_elsewhere', 'This account is already linked to another Zuey member');
      }
      return { user: owner, created: false, linked: false };
    }
    await d1.prepare('DELETE FROM user_identities WHERE provider = ? AND subject = ?').bind(profile.provider, profile.subject).run();
  }

  if (currentUserId) {
    const current = await getUserById(d1, currentUserId);
    if (!current) throw new AppError(401, 'unauthorized', 'Session expired; sign in again');
    await insertIdentity(d1, current.id, profile);
    return { user: current, created: false, linked: true };
  }

  const email = profile.emailVerified ? normalizeEmail(profile.email) : null;
  if (!email) throw new AppError(403, 'email_unverified', `Your ${profile.provider} account has no verified email address`);
  const { user, created } = await findOrCreateVerifiedUser(d1, { email, name: profile.name, avatarUrl: profile.avatarUrl });
  await insertIdentity(d1, user.id, profile);
  return { user, created, linked: true };
}

/** Handles the provider redirect for a member sign-in and opens a `zuey_member` session. */
export async function handleMemberOAuthCallback(request: Request, env: RuntimeEnv, provider: OAuthProvider): Promise<Response> {
  const url = new URL(request.url);
  const cookie = parseStateCookie(request);
  const state = url.searchParams.get('state') ?? '';
  if (!cookie || cookie.provider !== provider || !state || !(await timingSafeEqualStrings(state, cookie.state))) {
    return loginError('oauth_state');
  }
  if (url.searchParams.get('error')) return loginError('oauth_denied');
  const code = url.searchParams.get('code');
  if (!code) return loginError('oauth_denied');
  const creds = credentials(env, provider);
  if (!creds) return loginError(`${provider}_unconfigured`);
  const d1 = env.DB;
  if (!d1) return loginError('database_unavailable');

  try {
    const redirectUri = callbackUrl(request, provider);
    const profile = provider === 'google' ? await fetchGoogleProfile(creds, code, redirectUri) : await fetchGithubProfile(creds, code, redirectUri);
    // A top-level GET redirect is same-site navigation; linking uses the browser's existing session.
    const current = isSameOriginRequest(request) ? await resolveMemberSession(request, d1) : null;
    const { user, created, linked } = await completeOAuthLogin(d1, profile, current?.user.id ?? null);
    if (current && current.user.id === user.id) {
      if (linked) await logActivity(d1, user.id, 'identity.linked', { provider }, request);
      return redirect(cookie.next, [stateCookie('', 0)]);
    }
    const { token } = await createMemberSession(d1, user.id, request);
    await logActivity(d1, user.id, created ? 'account.created' : 'login', { method: provider }, request);
    return redirect(cookie.next, [stateCookie('', 0), memberCookie(token)]);
  } catch (err) {
    const code = err instanceof AppError ? err.code : 'oauth_failed';
    if (!(err instanceof AppError)) console.error('member OAuth error:', err instanceof Error ? err.message : 'unknown');
    return loginError(code);
  }
}

/**
 * Studio sign-in also opens a member session for the same identity, so the owner's browser has an
 * account for /account, community and Zuey AI. Returns the member Set-Cookie value, or null when the
 * browser already holds that member's session or the account cannot be resolved (Studio still signs in).
 */
export async function memberCookieForStudioLogin(request: Request, d1: D1DatabaseLike | undefined, profile: OAuthProfile): Promise<string | null> {
  if (!d1) return null;
  try {
    // No linking to whichever member happens to be signed in: the identity or its verified email decides.
    const { user, created } = await completeOAuthLogin(d1, profile, null);
    const current = await resolveMemberSession(request, d1);
    if (current && current.user.id === user.id) return null;
    const { token } = await createMemberSession(d1, user.id, request);
    await logActivity(d1, user.id, created ? 'account.created' : 'login', { method: profile.provider, via: 'studio' }, request);
    return memberCookie(token);
  } catch (err) {
    console.warn('Studio member session skipped:', err instanceof AppError ? err.code : err instanceof Error ? err.message : 'unknown');
    return null;
  }
}
