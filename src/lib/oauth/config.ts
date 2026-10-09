import type { UserKeyScope } from '../members/api-keys';
import { USER_KEY_SCOPES } from '../members/api-keys';
import { DAY_MS } from '../members/runtime';

/**
 * OAuth scopes for the remote MCP endpoint. Member scopes are exactly the personal API key scopes so
 * one `can()` decision covers keys and OAuth tokens; `admin` is only granted to verified admin
 * identities and is re-checked against the allowlist on every request.
 */
export const OAUTH_SCOPES = [...USER_KEY_SCOPES, 'admin'] as const;
export type OAuthScope = (typeof OAUTH_SCOPES)[number];

/** Scopes requested when a client asks for none (everything a member can grant, never admin). */
export const DEFAULT_MEMBER_SCOPES: UserKeyScope[] = [...USER_KEY_SCOPES];

/**
 * Long-lived on purpose: some MCP clients (Claude Code) refresh only while connected and ask for a new
 * sign-in when they reconnect with an expired access token. Every request still checks the token row,
 * consent and user in D1, so revoking a connected app takes effect immediately.
 */
export const ACCESS_TOKEN_TTL_MS = 30 * DAY_MS;
export const REFRESH_TOKEN_TTL_MS = 90 * DAY_MS;
export const CODE_TTL_MS = 2 * 60 * 1000;
export const REQUEST_TTL_MS = 10 * 60 * 1000;
/** Cached Client ID Metadata Documents are refetched after this long. */
export const CIMD_TTL_MS = 60 * 60 * 1000;
/** A cached document may still be used this long when a refetch fails. */
export const CIMD_STALE_MS = DAY_MS;
export const MAX_REGISTRATIONS_PER_IP_HOUR = 20;

export const ACCESS_TOKEN_PREFIX = 'zoa_';
export const REFRESH_TOKEN_PREFIX = 'zor_';
export const CODE_PREFIX = 'zac_';
export const CLIENT_ID_PREFIX = 'zc_';
export const CLIENT_SECRET_PREFIX = 'zcs_';

export const MCP_PATH = '/mcp';

export function isOAuthScope(v: unknown): v is OAuthScope {
  return typeof v === 'string' && (OAUTH_SCOPES as readonly string[]).includes(v);
}

export function isMemberScope(v: OAuthScope): v is UserKeyScope {
  return v !== 'admin';
}

/** Issuer is the origin serving the request, so tokens are bound to the host that issued them. */
export function issuerFor(request: Request): string {
  return new URL(request.url).origin;
}

/** Canonical resource URI (RFC 8707) of the MCP endpoint on this host — the token audience. */
export function mcpResourceFor(issuer: string): string {
  return `${issuer}${MCP_PATH}`;
}

export function resourceMetadataUrl(issuer: string): string {
  return `${issuer}/.well-known/oauth-protected-resource${MCP_PATH}`;
}

/**
 * Normalises a resource indicator: absolute http(s) URI without fragment, lowercase scheme/host
 * (done by URL), no trailing slash. Returns null when the value is not a usable URI.
 */
export function canonicalResource(raw: string): string | null {
  if (raw.length > 500 || raw.includes('#')) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password) return null;
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${path}${url.search}`;
}

/** Space-delimited scope string → validated, de-duplicated list; null when any scope is unknown. */
export function parseScopeParam(raw: string | null | undefined): OAuthScope[] | null {
  if (raw === null || raw === undefined || raw.trim() === '') return [];
  const out: OAuthScope[] = [];
  for (const s of raw.trim().split(/\s+/)) {
    if (!isOAuthScope(s)) return null;
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

export function parseStoredScopes(text: string): OAuthScope[] {
  try {
    const v: unknown = JSON.parse(text);
    return Array.isArray(v) ? v.filter(isOAuthScope) : [];
  } catch {
    return [];
  }
}

/** Stable ordering for display and storage. */
export function sortScopes(scopes: OAuthScope[]): OAuthScope[] {
  return OAUTH_SCOPES.filter(s => scopes.includes(s));
}
