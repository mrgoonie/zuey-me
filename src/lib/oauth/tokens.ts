import type { D1DatabaseLike } from '../../db/store';
import { AppError } from '../http';
import type { Row } from '../members/runtime';
import { base64Url, iso, membersRuntime, randomId, randomSecret, sha256Hex, str, strOrNull } from '../members/runtime';
import type { OAuthClient } from './clients';
import { redirectDisplayHost } from './clients';
import type { OAuthScope } from './config';
import {
  ACCESS_TOKEN_PREFIX, ACCESS_TOKEN_TTL_MS, CODE_PREFIX, CODE_TTL_MS, REFRESH_TOKEN_PREFIX, REFRESH_TOKEN_TTL_MS,
  canonicalResource, parseScopeParam, parseStoredScopes, sortScopes,
} from './config';
import { OAuthError } from './errors';

const LAST_USED_INTERVAL_MS = 5 * 60 * 1000;
const PKCE_VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;

export interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token?: string;
  scope: string;
}

export interface AccessTokenRecord {
  id: string;
  family_id: string;
  client_id: string;
  user_id: string;
  scopes: OAuthScope[];
  audience: string;
  access_expires_at: string;
}

const invalidGrant = (msg: string): OAuthError => new OAuthError(400, 'invalid_grant', msg);

/** base64url(SHA-256(verifier)) — the only PKCE method accepted (S256). */
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

async function revokeFamily(d1: D1DatabaseLike, familyId: string): Promise<void> {
  await d1.prepare('UPDATE oauth_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL')
    .bind(iso(membersRuntime.now()), familyId).run();
}

async function consentActive(d1: D1DatabaseLike, userId: string, clientId: string): Promise<boolean> {
  const row = await d1.prepare(
    `SELECT c.id FROM oauth_consents c JOIN users u ON u.id = c.user_id
     WHERE c.user_id = ? AND c.client_id = ? AND c.revoked_at IS NULL AND u.deleted_at IS NULL`
  ).bind(userId, clientId).first<Row>();
  return row !== null;
}

async function issueTokens(
  d1: D1DatabaseLike,
  input: { familyId: string; client: OAuthClient; userId: string; scopes: OAuthScope[]; audience: string },
): Promise<TokenResponse> {
  const now = membersRuntime.now();
  const access = ACCESS_TOKEN_PREFIX + randomSecret(32);
  const withRefresh = input.client.grant_types.includes('refresh_token');
  const refresh = withRefresh ? REFRESH_TOKEN_PREFIX + randomSecret(32) : null;
  const scopes = sortScopes(input.scopes);
  await d1.prepare(
    `INSERT INTO oauth_tokens (id, family_id, client_id, user_id, access_hash, refresh_hash, scopes, audience, created_at, access_expires_at, refresh_expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    randomId('ot'), input.familyId, input.client.client_id, input.userId, await sha256Hex(access), refresh ? await sha256Hex(refresh) : null,
    JSON.stringify(scopes), input.audience, iso(now), iso(now + ACCESS_TOKEN_TTL_MS), refresh ? iso(now + REFRESH_TOKEN_TTL_MS) : null,
  ).run();
  return {
    access_token: access,
    token_type: 'Bearer',
    expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
    ...(refresh ? { refresh_token: refresh } : {}),
    scope: scopes.join(' '),
  };
}

// ---------------------------------------------------------------------------
// Authorization codes
// ---------------------------------------------------------------------------

export async function createAuthorizationCode(
  d1: D1DatabaseLike,
  input: { clientId: string; userId: string; redirectUri: string; codeChallenge: string; scopes: OAuthScope[]; resource: string },
): Promise<string> {
  const code = CODE_PREFIX + randomSecret(32);
  const now = membersRuntime.now();
  await d1.prepare(
    `INSERT INTO oauth_codes (id, code_hash, client_id, user_id, redirect_uri, code_challenge, scopes, resource, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    randomId('oc'), await sha256Hex(code), input.clientId, input.userId, input.redirectUri, input.codeChallenge,
    JSON.stringify(sortScopes(input.scopes)), input.resource, iso(now), iso(now + CODE_TTL_MS),
  ).run();
  return code;
}

function checkResourceParam(raw: string | undefined, expected: string): void {
  if (raw === undefined || raw === '') return;
  if (canonicalResource(raw) !== expected) throw new OAuthError(400, 'invalid_target', 'resource does not match the authorized resource');
}

/** authorization_code grant: single-use code + exact redirect_uri + PKCE S256 + resource binding. */
export async function exchangeAuthorizationCode(d1: D1DatabaseLike, client: OAuthClient, form: Record<string, string>): Promise<TokenResponse> {
  const code = form.code;
  if (!code) throw new OAuthError(400, 'invalid_request', 'code is required');
  const row = await d1.prepare('SELECT * FROM oauth_codes WHERE code_hash = ?').bind(await sha256Hex(code)).first<Row>();
  if (!row || str(row, 'client_id') !== client.client_id) throw invalidGrant('Invalid authorization code');
  const codeId = str(row, 'id');

  // Claim atomically. A second presentation means the code leaked: revoke what it produced.
  const now = membersRuntime.now();
  const claim = await d1.prepare('UPDATE oauth_codes SET used_at = ? WHERE id = ? AND used_at IS NULL').bind(iso(now), codeId).run();
  if (!claim.meta?.changes) {
    await revokeFamily(d1, codeId);
    throw invalidGrant('Authorization code was already used');
  }
  if (Date.parse(str(row, 'expires_at')) <= now) throw invalidGrant('Authorization code expired');
  if (form.redirect_uri !== str(row, 'redirect_uri')) throw invalidGrant('redirect_uri does not match the authorization request');

  const verifier = form.code_verifier ?? '';
  if (!PKCE_VERIFIER_RE.test(verifier)) throw invalidGrant('code_verifier is missing or malformed');
  if ((await pkceChallenge(verifier)) !== str(row, 'code_challenge')) throw invalidGrant('PKCE verification failed');

  const resource = str(row, 'resource');
  checkResourceParam(form.resource, resource);
  const userId = str(row, 'user_id');
  if (!(await consentActive(d1, userId, client.client_id))) throw invalidGrant('Access was revoked');
  return issueTokens(d1, { familyId: codeId, client, userId, scopes: parseStoredScopes(str(row, 'scopes')), audience: resource });
}

/** refresh_token grant with rotation; presenting an already-rotated token revokes the whole family. */
export async function refreshTokens(d1: D1DatabaseLike, client: OAuthClient, form: Record<string, string>): Promise<TokenResponse> {
  if (!client.grant_types.includes('refresh_token')) throw new OAuthError(400, 'unauthorized_client', 'This client is not registered for refresh_token');
  const token = form.refresh_token;
  if (!token || !token.startsWith(REFRESH_TOKEN_PREFIX)) throw new OAuthError(400, 'invalid_request', 'refresh_token is required');
  const row = await d1.prepare('SELECT * FROM oauth_tokens WHERE refresh_hash = ?').bind(await sha256Hex(token)).first<Row>();
  if (!row || str(row, 'client_id') !== client.client_id) throw invalidGrant('Invalid refresh token');
  const familyId = str(row, 'family_id');
  if (strOrNull(row, 'rotated_at') || strOrNull(row, 'revoked_at')) {
    await revokeFamily(d1, familyId);
    throw invalidGrant('Refresh token was already used or revoked; all tokens of this grant are now revoked');
  }
  const now = membersRuntime.now();
  const expires = strOrNull(row, 'refresh_expires_at');
  if (!expires || Date.parse(expires) <= now) throw invalidGrant('Refresh token expired');

  const claim = await d1.prepare('UPDATE oauth_tokens SET rotated_at = ? WHERE id = ? AND rotated_at IS NULL AND revoked_at IS NULL')
    .bind(iso(now), str(row, 'id')).run();
  if (!claim.meta?.changes) {
    await revokeFamily(d1, familyId);
    throw invalidGrant('Refresh token was already used');
  }

  const granted = parseStoredScopes(str(row, 'scopes'));
  let scopes = granted;
  if (form.scope !== undefined) {
    const requested = parseScopeParam(form.scope);
    if (requested === null || requested.some(s => !granted.includes(s))) {
      throw new OAuthError(400, 'invalid_scope', 'Requested scope exceeds the original grant');
    }
    if (requested.length > 0) scopes = requested;
  }
  const audience = str(row, 'audience');
  checkResourceParam(form.resource, audience);
  const userId = str(row, 'user_id');
  if (!(await consentActive(d1, userId, client.client_id))) {
    await revokeFamily(d1, familyId);
    throw invalidGrant('Access was revoked');
  }
  return issueTokens(d1, { familyId, client, userId, scopes, audience });
}

export type AccessTokenCheck =
  | { ok: true; token: AccessTokenRecord }
  | { ok: false; reason: 'invalid' | 'expired' | 'revoked' | 'audience' };

/** Resource-server validation: known hash, not revoked/expired, live consent + user, exact audience. */
export async function validateAccessToken(d1: D1DatabaseLike, token: string, audience: string): Promise<AccessTokenCheck> {
  if (!token.startsWith(ACCESS_TOKEN_PREFIX) || token.length > 200) return { ok: false, reason: 'invalid' };
  const row = await d1.prepare(
    `SELECT t.*, c.revoked_at AS consent_revoked_at, c.id AS consent_id
     FROM oauth_tokens t
     JOIN users u ON u.id = t.user_id AND u.deleted_at IS NULL
     LEFT JOIN oauth_consents c ON c.user_id = t.user_id AND c.client_id = t.client_id
     WHERE t.access_hash = ?`
  ).bind(await sha256Hex(token)).first<Row>();
  if (!row) return { ok: false, reason: 'invalid' };
  if (strOrNull(row, 'revoked_at') || !strOrNull(row, 'consent_id') || strOrNull(row, 'consent_revoked_at')) return { ok: false, reason: 'revoked' };
  const now = membersRuntime.now();
  if (Date.parse(str(row, 'access_expires_at')) <= now) return { ok: false, reason: 'expired' };
  if (str(row, 'audience') !== audience) return { ok: false, reason: 'audience' };

  const lastUsed = strOrNull(row, 'last_used_at');
  if (!lastUsed || now - Date.parse(lastUsed) > LAST_USED_INTERVAL_MS) {
    const stamp = iso(now);
    await Promise.all([
      d1.prepare('UPDATE oauth_tokens SET last_used_at = ? WHERE id = ?').bind(stamp, str(row, 'id')).run(),
      d1.prepare('UPDATE oauth_consents SET last_used_at = ? WHERE id = ?').bind(stamp, str(row, 'consent_id')).run(),
    ]).catch((err: unknown) => console.error('oauth last_used update failed:', err instanceof Error ? err.message : 'unknown'));
  }
  return {
    ok: true,
    token: {
      id: str(row, 'id'),
      family_id: str(row, 'family_id'),
      client_id: str(row, 'client_id'),
      user_id: str(row, 'user_id'),
      scopes: parseStoredScopes(str(row, 'scopes')),
      audience: str(row, 'audience'),
      access_expires_at: str(row, 'access_expires_at'),
    },
  };
}

/** RFC 7009: revokes the grant family of an access or refresh token owned by this client. */
export async function revokeTokenForClient(d1: D1DatabaseLike, client: OAuthClient, token: string): Promise<void> {
  if (!token || token.length > 200) return;
  const hash = await sha256Hex(token);
  const row = await d1.prepare('SELECT family_id, client_id FROM oauth_tokens WHERE access_hash = ? OR refresh_hash = ?').bind(hash, hash).first<Row>();
  if (!row || str(row, 'client_id') !== client.client_id) return;
  await revokeFamily(d1, str(row, 'family_id'));
}

// ---------------------------------------------------------------------------
// Consents (connected apps)
// ---------------------------------------------------------------------------

export async function recordConsent(d1: D1DatabaseLike, userId: string, clientId: string, scopes: OAuthScope[]): Promise<void> {
  const now = iso(membersRuntime.now());
  await d1.prepare(
    `INSERT INTO oauth_consents (id, user_id, client_id, scopes, granted_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id, client_id) DO UPDATE SET scopes = excluded.scopes, granted_at = excluded.granted_at, updated_at = excluded.updated_at, revoked_at = NULL`
  ).bind(randomId('ocs'), userId, clientId, JSON.stringify(sortScopes(scopes)), now, now).run();
}

export interface ConnectedApp {
  id: string;
  client_id: string;
  client_name: string;
  client_uri: string | null;
  registration: 'dcr' | 'cimd';
  redirect_hosts: string[];
  scopes: OAuthScope[];
  granted_at: string;
  last_used_at: string | null;
  active_tokens: number;
}

/** The member's apps with live consent, newest first. Never includes token material. */
export async function listConnectedApps(d1: D1DatabaseLike, userId: string): Promise<ConnectedApp[]> {
  const now = iso(membersRuntime.now());
  const { results } = await d1.prepare(
    `SELECT c.id, c.client_id, c.scopes, c.granted_at, c.last_used_at, k.client_name, k.client_uri, k.source, k.redirect_uris,
            (SELECT COUNT(*) FROM oauth_tokens t WHERE t.user_id = c.user_id AND t.client_id = c.client_id AND t.revoked_at IS NULL
               AND (t.access_expires_at > ? OR (t.rotated_at IS NULL AND t.refresh_expires_at > ?))) AS active_tokens
     FROM oauth_consents c JOIN oauth_clients k ON k.client_id = c.client_id
     WHERE c.user_id = ? AND c.revoked_at IS NULL
     ORDER BY c.granted_at DESC`
  ).bind(now, now, userId).all<Row>();
  return (results ?? []).map(r => {
    let uris: string[] = [];
    try {
      const v: unknown = JSON.parse(str(r, 'redirect_uris'));
      uris = Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      uris = [];
    }
    return {
      id: str(r, 'id'),
      client_id: str(r, 'client_id'),
      client_name: str(r, 'client_name'),
      client_uri: strOrNull(r, 'client_uri'),
      registration: str(r, 'source') === 'cimd' ? 'cimd' : 'dcr',
      redirect_hosts: [...new Set(uris.map(redirectDisplayHost))],
      scopes: parseStoredScopes(str(r, 'scopes')),
      granted_at: str(r, 'granted_at'),
      last_used_at: strOrNull(r, 'last_used_at'),
      active_tokens: Number(r.active_tokens ?? 0),
    };
  });
}

/** Disconnects an app: consent revoked and every token it holds for this member revoked. 404 for others' ids. */
export async function revokeConnectedApp(d1: D1DatabaseLike, userId: string, consentId: string): Promise<{ client_id: string; client_name: string }> {
  const row = await d1.prepare(
    `SELECT c.client_id, k.client_name FROM oauth_consents c JOIN oauth_clients k ON k.client_id = c.client_id
     WHERE c.id = ? AND c.user_id = ? AND c.revoked_at IS NULL`
  ).bind(consentId, userId).first<Row>();
  if (!row) throw new AppError(404, 'not_found', 'Connected app not found');
  const now = iso(membersRuntime.now());
  const clientId = str(row, 'client_id');
  await d1.prepare('UPDATE oauth_consents SET revoked_at = ?, updated_at = ? WHERE id = ? AND user_id = ?').bind(now, now, consentId, userId).run();
  await d1.prepare('UPDATE oauth_tokens SET revoked_at = ? WHERE user_id = ? AND client_id = ? AND revoked_at IS NULL').bind(now, userId, clientId).run();
  return { client_id: clientId, client_name: str(row, 'client_name') };
}
