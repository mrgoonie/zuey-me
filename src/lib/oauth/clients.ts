import type { D1DatabaseLike } from '../../db/store';
import type { RuntimeEnv } from '../../env';
import { timingSafeEqualStrings } from '../payments/sepay';
import type { Row } from '../members/runtime';
import { clientIp, iso, isUniqueViolation, membersRuntime, randomSecret, sha256Hex, str, strOrNull } from '../members/runtime';
import {
  CIMD_STALE_MS, CIMD_TTL_MS, CLIENT_ID_PREFIX, CLIENT_SECRET_PREFIX, MAX_REGISTRATIONS_PER_IP_HOUR,
} from './config';
import { OAuthError } from './errors';

export type ClientSource = 'dcr' | 'cimd';
export type ClientAuthMethod = 'none' | 'client_secret_post' | 'client_secret_basic';
export type GrantType = 'authorization_code' | 'refresh_token';

const AUTH_METHODS: ClientAuthMethod[] = ['none', 'client_secret_post', 'client_secret_basic'];
const GRANT_TYPES: GrantType[] = ['authorization_code', 'refresh_token'];
const MAX_REDIRECT_URIS = 10;
const MAX_CIMD_BYTES = 64 * 1024;
const CIMD_TIMEOUT_MS = 5000;

/** Schemes that must never receive an authorization code. */
const FORBIDDEN_SCHEMES = new Set(['javascript:', 'data:', 'file:', 'vbscript:', 'about:', 'blob:', 'ftp:', 'ws:', 'wss:']);

export interface OAuthClient {
  client_id: string;
  source: ClientSource;
  token_endpoint_auth_method: ClientAuthMethod;
  client_name: string;
  client_uri: string | null;
  redirect_uris: string[];
  grant_types: GrantType[];
  created_at: string;
  fetched_at: string | null;
  has_secret: boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseList(text: string): string[] {
  try {
    const v: unknown = JSON.parse(text);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function isAuthMethod(v: unknown): v is ClientAuthMethod {
  return typeof v === 'string' && (AUTH_METHODS as string[]).includes(v);
}

function isGrantType(v: unknown): v is GrantType {
  return typeof v === 'string' && (GRANT_TYPES as string[]).includes(v);
}

function rowToClient(row: Row): OAuthClient {
  const method = str(row, 'token_endpoint_auth_method');
  const source = str(row, 'source');
  return {
    client_id: str(row, 'client_id'),
    source: source === 'cimd' ? 'cimd' : 'dcr',
    token_endpoint_auth_method: isAuthMethod(method) ? method : 'none',
    client_name: str(row, 'client_name'),
    client_uri: strOrNull(row, 'client_uri'),
    redirect_uris: parseList(str(row, 'redirect_uris')),
    grant_types: parseList(str(row, 'grant_types')).filter(isGrantType),
    created_at: str(row, 'created_at'),
    fetched_at: strOrNull(row, 'fetched_at'),
    has_secret: strOrNull(row, 'client_secret_hash') !== null,
  };
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

/** Display-safe text: no control characters, collapsed whitespace, bounded length. */
function cleanText(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const s = v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return s.length > 0 ? s.slice(0, max) : null;
}

function httpsUrlOrNull(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 300) return null;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Accepts https redirect URIs, http only on loopback hosts (native apps, RFC 8252 §7.3) and
 * private-use schemes such as `cursor://…` (RFC 8252 §7.1). Fragments and credentials are rejected.
 */
export function validateRedirectUri(raw: unknown, errorCode = 'invalid_redirect_uri'): string {
  const bad = (msg: string): never => {
    throw new OAuthError(400, errorCode, msg);
  };
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 500) return bad('redirect_uri must be a non-empty string of at most 500 characters');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return bad('redirect_uri must be an absolute URI');
  }
  if (raw.includes('#') || url.hash) bad('redirect_uri must not contain a fragment');
  if (url.username || url.password) bad('redirect_uri must not contain credentials');
  if (FORBIDDEN_SCHEMES.has(url.protocol)) bad(`redirect_uri scheme ${url.protocol} is not allowed`);
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) bad('http redirect_uri is only allowed on localhost / 127.0.0.1 / [::1]');
  if (url.protocol !== 'https:' && url.protocol !== 'http:' && !/^[a-z][a-z0-9+.-]*:$/.test(url.protocol)) bad('redirect_uri has an invalid scheme');
  return raw;
}

/** Host shown on the consent screen so members can see exactly where the code will be sent. */
export function redirectDisplayHost(uri: string): string {
  try {
    const u = new URL(uri);
    return u.host ? `${u.protocol}//${u.host}` : `${u.protocol}${u.pathname.split('/')[0] ?? ''}`;
  } catch {
    return uri.slice(0, 80);
  }
}

export interface RegistrationResult {
  client: OAuthClient;
  secret: string | null;
}

async function ipHash(env: RuntimeEnv, request: Request): Promise<string | null> {
  const ip = clientIp(request);
  return ip ? sha256Hex(`oauth-ip:${ip}:${env.MEMBER_HASH_SALT ?? ''}`) : null;
}

/** Dynamic Client Registration (RFC 7591). Unauthenticated, so it is rate limited per client IP. */
export async function registerClient(d1: D1DatabaseLike, env: RuntimeEnv, request: Request, body: Record<string, unknown>): Promise<RegistrationResult> {
  const meta = (msg: string): never => {
    throw new OAuthError(400, 'invalid_client_metadata', msg);
  };

  const rawUris = body.redirect_uris;
  if (!Array.isArray(rawUris) || rawUris.length === 0) meta('redirect_uris must be a non-empty array');
  const uris = Array.isArray(rawUris) ? rawUris : [];
  if (uris.length > MAX_REDIRECT_URIS) meta(`At most ${MAX_REDIRECT_URIS} redirect_uris are allowed`);
  const redirectUris: string[] = [];
  for (const u of uris) {
    const valid = validateRedirectUri(u);
    if (!redirectUris.includes(valid)) redirectUris.push(valid);
  }

  const method = body.token_endpoint_auth_method ?? 'client_secret_basic';
  if (!isAuthMethod(method)) meta(`token_endpoint_auth_method must be one of ${AUTH_METHODS.join(', ')}`);
  const authMethod: ClientAuthMethod = isAuthMethod(method) ? method : 'none';

  const rawGrants = body.grant_types ?? ['authorization_code'];
  if (!Array.isArray(rawGrants) || rawGrants.length === 0 || !rawGrants.every(isGrantType)) {
    meta(`grant_types must be a subset of ${GRANT_TYPES.join(', ')}`);
  }
  const grantTypes = Array.isArray(rawGrants) ? [...new Set(rawGrants.filter(isGrantType))] : [];
  if (!grantTypes.includes('authorization_code')) meta('grant_types must include authorization_code');

  const responseTypes = body.response_types ?? ['code'];
  if (!Array.isArray(responseTypes) || responseTypes.some(t => t !== 'code')) meta('response_types must be ["code"]');

  const clientName = cleanText(body.client_name, 100) ?? 'Unnamed MCP client';
  const clientUri = body.client_uri === undefined ? null : httpsUrlOrNull(body.client_uri);
  if (body.client_uri !== undefined && !clientUri) meta('client_uri must be an https URL');

  const hashedIp = await ipHash(env, request);
  const now = membersRuntime.now();
  if (hashedIp) {
    const row = await d1.prepare('SELECT COUNT(*) AS n FROM oauth_clients WHERE created_ip_hash = ? AND created_at > ?')
      .bind(hashedIp, iso(now - 60 * 60 * 1000)).first<Row>();
    if (Number(row?.n ?? 0) >= MAX_REGISTRATIONS_PER_IP_HOUR) {
      throw new OAuthError(429, 'temporarily_unavailable', 'Too many client registrations from this network; try again later', { 'Retry-After': '3600' });
    }
  }

  const clientId = CLIENT_ID_PREFIX + randomSecret(18);
  const secret = authMethod === 'none' ? null : CLIENT_SECRET_PREFIX + randomSecret(32);
  await d1.prepare(
    `INSERT INTO oauth_clients (client_id, source, client_secret_hash, token_endpoint_auth_method, client_name, client_uri, redirect_uris, grant_types, created_ip_hash, created_at)
     VALUES (?, 'dcr', ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(clientId, secret ? await sha256Hex(secret) : null, authMethod, clientName, clientUri, JSON.stringify(redirectUris), JSON.stringify(grantTypes), hashedIp, iso(now)).run();

  return {
    client: {
      client_id: clientId, source: 'dcr', token_endpoint_auth_method: authMethod, client_name: clientName, client_uri: clientUri,
      redirect_uris: redirectUris, grant_types: grantTypes, created_at: iso(now), fetched_at: null, has_secret: secret !== null,
    },
    secret,
  };
}

/** RFC 7591 §3.2.1 registration response. The secret is shown exactly once. */
export function registrationResponse(result: RegistrationResult): Record<string, unknown> {
  const { client, secret } = result;
  return {
    client_id: client.client_id,
    client_id_issued_at: Math.floor(Date.parse(client.created_at) / 1000),
    ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
    client_name: client.client_name,
    ...(client.client_uri ? { client_uri: client.client_uri } : {}),
    redirect_uris: client.redirect_uris,
    grant_types: client.grant_types,
    response_types: ['code'],
    token_endpoint_auth_method: client.token_endpoint_auth_method,
  };
}

/** Client ID Metadata Document ids are https URLs with a path, on a public DNS host. */
export function isMetadataDocumentClientId(clientId: string): boolean {
  if (!clientId.startsWith('https://') || clientId.length > 500) return false;
  try {
    const u = new URL(clientId);
    if (u.hash || u.username || u.password || u.pathname === '/' || u.port) return false;
    const host = u.hostname;
    if (isLoopbackHost(host) || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return false;
    // IP literals are refused so the server never fetches arbitrary internal addresses.
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.startsWith('[')) return false;
    return host.includes('.');
  } catch {
    return false;
  }
}

async function fetchMetadataDocument(clientId: string): Promise<{ name: string; uri: string | null; redirectUris: string[]; grants: GrantType[] }> {
  const invalid = (msg: string): never => {
    throw new OAuthError(400, 'invalid_client', `Client metadata document rejected: ${msg}`);
  };
  let res: Response;
  try {
    // Cloudflare Workers reject `redirect: 'error'`, so redirects are taken manually and refused below.
    res = await membersRuntime.fetch(clientId, {
      headers: { Accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(CIMD_TIMEOUT_MS),
    });
  } catch {
    return invalid('the document could not be fetched');
  }
  if (res.status >= 300 && res.status < 400) invalid('the document URL must not redirect');
  if (!res.ok) invalid(`the document URL answered HTTP ${res.status}`);
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > MAX_CIMD_BYTES) invalid('the document is too large');
  const text = await res.text();
  if (text.length > MAX_CIMD_BYTES) invalid('the document is too large');
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return invalid('the document is not valid JSON');
  }
  if (!isRecord(doc)) return invalid('the document is not a JSON object');
  if (doc.client_id !== clientId) invalid('client_id does not match the document URL');
  const name = cleanText(doc.client_name, 100);
  if (!name) invalid('client_name is required');
  if (!Array.isArray(doc.redirect_uris) || doc.redirect_uris.length === 0 || doc.redirect_uris.length > MAX_REDIRECT_URIS) {
    invalid('redirect_uris must be a non-empty array');
  }
  const redirectUris = (Array.isArray(doc.redirect_uris) ? doc.redirect_uris : []).map(u => validateRedirectUri(u, 'invalid_client'));
  // Clients such as ChatGPT prefer private_key_jwt but list `none` among the methods they support; this
  // server only advertises `none` for them, so they authenticate as public clients protected by PKCE.
  const method = doc.token_endpoint_auth_method ?? 'none';
  const supported = Array.isArray(doc.token_endpoint_auth_methods_supported) ? doc.token_endpoint_auth_methods_supported : [];
  if (method !== 'none' && !supported.includes('none')) invalid('only token_endpoint_auth_method "none" is supported for metadata-document clients');
  const grants = Array.isArray(doc.grant_types) ? doc.grant_types.filter(isGrantType) : ['authorization_code' as const];
  if (!grants.includes('authorization_code')) invalid('grant_types must include authorization_code');
  return { name: name ?? '', uri: httpsUrlOrNull(doc.client_uri), redirectUris, grants: [...new Set(grants)] };
}

async function resolveMetadataDocumentClient(d1: D1DatabaseLike, clientId: string): Promise<OAuthClient> {
  const row = await d1.prepare('SELECT * FROM oauth_clients WHERE client_id = ?').bind(clientId).first<Row>();
  const cached = row ? rowToClient(row) : null;
  const now = membersRuntime.now();
  const age = cached?.fetched_at ? now - Date.parse(cached.fetched_at) : Infinity;
  if (cached && age < CIMD_TTL_MS) return cached;

  let fetched: Awaited<ReturnType<typeof fetchMetadataDocument>>;
  try {
    fetched = await fetchMetadataDocument(clientId);
  } catch (err) {
    if (cached && age < CIMD_STALE_MS) {
      console.error('client metadata refetch failed; using cached copy:', err instanceof Error ? err.message : 'unknown');
      return cached;
    }
    throw err;
  }
  const values = [fetched.name, fetched.uri, JSON.stringify(fetched.redirectUris), JSON.stringify(fetched.grants), iso(now)];
  if (cached) {
    await d1.prepare('UPDATE oauth_clients SET client_name = ?, client_uri = ?, redirect_uris = ?, grant_types = ?, fetched_at = ? WHERE client_id = ?')
      .bind(...values, clientId).run();
  } else {
    try {
      await d1.prepare(
        `INSERT INTO oauth_clients (client_id, source, client_secret_hash, token_endpoint_auth_method, client_name, client_uri, redirect_uris, grant_types, created_at, fetched_at)
         VALUES (?, 'cimd', NULL, 'none', ?, ?, ?, ?, ?, ?)`
      ).bind(clientId, fetched.name, fetched.uri, values[2], values[3], iso(now), iso(now)).run();
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
  }
  return {
    client_id: clientId, source: 'cimd', token_endpoint_auth_method: 'none', client_name: fetched.name, client_uri: fetched.uri,
    redirect_uris: fetched.redirectUris, grant_types: fetched.grants, created_at: cached?.created_at ?? iso(now), fetched_at: iso(now), has_secret: false,
  };
}

/** Registered client, or a metadata-document client fetched/cached on demand; null when unknown. */
export async function getClient(d1: D1DatabaseLike, clientId: string): Promise<OAuthClient | null> {
  if (!clientId || clientId.length > 500) return null;
  if (isMetadataDocumentClientId(clientId)) return resolveMetadataDocumentClient(d1, clientId);
  const row = await d1.prepare("SELECT * FROM oauth_clients WHERE client_id = ? AND source = 'dcr'").bind(clientId).first<Row>();
  return row ? rowToClient(row) : null;
}

/** The redirect URI without its port when it is an http loopback URI, otherwise null. */
function loopbackWithoutPort(uri: string): string | null {
  try {
    const u = new URL(uri);
    if (u.protocol !== 'http:' || !isLoopbackHost(u.hostname)) return null;
    u.port = '';
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Exact string comparison against the registered redirect URIs (no prefix or wildcard matching), except
 * that http loopback URIs match on any port: native apps such as Claude Code register
 * `http://localhost/callback` and listen on an ephemeral port (RFC 8252 §7.3).
 */
export function redirectUriAllowed(client: OAuthClient, redirectUri: string): boolean {
  if (client.redirect_uris.includes(redirectUri)) return true;
  const requested = loopbackWithoutPort(redirectUri);
  return requested !== null && client.redirect_uris.some(r => loopbackWithoutPort(r) === requested);
}

function decodeBasic(header: string): { id: string; secret: string } | null {
  if (!/^basic /i.test(header)) return null;
  try {
    const decoded = atob(header.slice(6).trim());
    const idx = decoded.indexOf(':');
    if (idx < 0) return null;
    return { id: decodeURIComponent(decoded.slice(0, idx)), secret: decodeURIComponent(decoded.slice(idx + 1)) };
  } catch {
    return null;
  }
}

/**
 * Authenticates the client at the token/revocation endpoints using its registered method.
 * Public clients (`none`) only identify themselves; PKCE protects their codes.
 */
export async function authenticateClient(d1: D1DatabaseLike, request: Request, form: Record<string, string>): Promise<OAuthClient> {
  const invalidClient = (msg: string): never => {
    throw new OAuthError(401, 'invalid_client', msg, { 'WWW-Authenticate': 'Basic realm="zuey-oauth"' });
  };
  const basic = decodeBasic(request.headers.get('authorization') || '');
  const clientId = basic?.id ?? form.client_id;
  if (!clientId) return invalidClient('client_id is required');
  if (basic && form.client_id && form.client_id !== basic.id) invalidClient('client_id mismatch');
  const client = await getClient(d1, clientId);
  if (!client) return invalidClient('Unknown client');

  if (client.token_endpoint_auth_method === 'none') {
    if (basic || form.client_secret) invalidClient('This client is registered as a public client (token_endpoint_auth_method none)');
    return client;
  }
  const presented = client.token_endpoint_auth_method === 'client_secret_basic' ? basic?.secret : form.client_secret;
  if (!presented) return invalidClient(`Client authentication with ${client.token_endpoint_auth_method} is required`);
  const row = await d1.prepare('SELECT client_secret_hash FROM oauth_clients WHERE client_id = ?').bind(client.client_id).first<Row>();
  const stored = row ? strOrNull(row, 'client_secret_hash') : null;
  if (!stored || !(await timingSafeEqualStrings(stored, await sha256Hex(presented)))) invalidClient('Invalid client credentials');
  return client;
}
