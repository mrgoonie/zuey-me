import type { RuntimeEnv } from '../../env';
import { AppError } from '../http';
import { allMcpTools, callMcpTool } from '../mcp/dispatch';
import type { McpContext } from '../mcp/types';
import type { Principal } from '../members/policy';
import { can, requireCan } from '../members/policy';
import type { McpCaller, OAuthGrantInfo } from './caller';
import { resolveMcpCaller } from './caller';
import { issuerFor, mcpResourceFor, resourceMetadataUrl } from './config';
import type { ToolAccess } from './tool-access';
import { toolAccess, visibleTools } from './tool-access';

/**
 * Streamable HTTP MCP endpoint (`/mcp`), dual-era:
 * - modern (2026-07-28): stateless, per-request `_meta` protocol version mirrored in headers;
 * - legacy (2025-03-26 … 2025-11-25): `initialize` handshake, served without sessions.
 * Every request must carry a bearer credential; unauthenticated requests get 401 + resource metadata.
 */
export const MODERN_VERSIONS = ['2026-07-28'];
export const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];
export const SUPPORTED_VERSIONS = [...MODERN_VERSIONS, ...LEGACY_VERSIONS];

export const SERVER_INFO = { name: 'zuey-me', title: 'Zuey (zuey.me)', version: '2.0.0' };
const INSTRUCTIONS = 'Tools for zuey.me: Duy Nguyen\'s profile, articles (full text follows the member\'s plan), workflows, reads, '
  + 'membership plans and SePay checkout. Admin tools appear only for admin identities that granted the admin scope.';

const META_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities';
const META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo';

// Application error codes (outside the JSON-RPC reserved range).
const ERR_UNAUTHORIZED = -31001;
const ERR_FORBIDDEN = -31003;

type JsonRpcId = string | number | null;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function respond(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}

function rpcError(id: JsonRpcId, code: number, message: string, status: number, data?: unknown, headers: Record<string, string> = {}): Response {
  const body: Record<string, unknown> = { jsonrpc: '2.0', error: { code, message, ...(data === undefined ? {} : { data }) } };
  if (id !== null) body.id = id;
  return respond(body, status, headers);
}

function quote(value: string): string {
  return `"${value.replace(/["\\\r\n]/g, ' ')}"`;
}

/** RFC 6750 §3 challenge pointing clients at the RFC 9728 metadata document. */
export function bearerChallenge(issuer: string, params: Record<string, string> = {}): string {
  const parts = Object.entries(params).map(([k, v]) => `${k}=${quote(v)}`);
  parts.push(`resource_metadata=${quote(resourceMetadataUrl(issuer))}`);
  return `Bearer ${parts.join(', ')}`;
}

function isLoopbackOrigin(url: URL): boolean {
  return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
}

/** DNS-rebinding guard required by the transport: present Origin must be this site, loopback, or allowlisted. */
export function originAllowed(request: Request, env: RuntimeEnv): boolean {
  const origin = request.headers.get('origin');
  if (origin === null) return true;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.origin === new URL(request.url).origin || isLoopbackOrigin(url)) return true;
  const extra = (env.MCP_ALLOWED_ORIGINS ?? '').split(',').map(s => s.trim()).filter(Boolean);
  return extra.includes(url.origin);
}

/** Decodes the `=?base64?…?=` sentinel used for non-ASCII MCP header values. */
function decodeHeaderValue(value: string): string | null {
  const m = /^=\?base64\?([A-Za-z0-9+/=]*)\?=$/.exec(value);
  if (!m) return value;
  try {
    return new TextDecoder().decode(Uint8Array.from(atob(m[1]), c => c.charCodeAt(0)));
  } catch {
    return null;
  }
}

function toolResult(data: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function toolErrorResult(err: AppError): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: { code: err.code, status: err.status, message: err.message, ...err.extra } }, null, 2) }],
    isError: true,
  };
}

/** Scope a client could obtain by re-authorizing (step-up), or null when more scope would not help. */
function stepUpScope(oauth: OAuthGrantInfo | null, err: AppError, access: ToolAccess): string | null {
  if (!oauth) return null;
  if (err.code === 'insufficient_scope' && typeof err.extra.required_scope === 'string') return err.extra.required_scope;
  if (access.kind === 'admin' && (err.status === 401 || err.status === 403) && oauth.adminIdentity && !oauth.scopes.includes('admin')) return 'admin';
  return null;
}

function toolContext(request: Request, env: RuntimeEnv, principal: Principal): McpContext {
  return {
    request,
    env,
    d1: env.DB,
    principal: async () => principal,
    async requireAdmin() {
      requireCan(principal, 'admin');
    },
    async isAdmin() {
      return can(principal, 'admin');
    },
  };
}

interface Era {
  modern: boolean;
  version: string;
}

/** Validates protocol version + mirrored headers; returns the era or an error response. */
function negotiate(request: Request, id: JsonRpcId, method: string, params: Record<string, unknown>): Era | Response {
  const header = request.headers.get('mcp-protocol-version');
  const meta = isRecord(params._meta) ? params._meta : null;
  const metaVersion = meta && typeof meta[META_VERSION] === 'string' ? meta[META_VERSION] : null;

  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    return { modern: false, version: LEGACY_VERSIONS.includes(requested) ? requested : LEGACY_VERSIONS[0] };
  }

  if (metaVersion !== null) {
    if (!MODERN_VERSIONS.includes(metaVersion)) {
      return rpcError(id, -32022, 'Unsupported protocol version', 400, { supported: SUPPORTED_VERSIONS, requested: metaVersion });
    }
    if (header !== metaVersion) {
      return rpcError(id, -32020, `Header mismatch: MCP-Protocol-Version header ${header ?? '(missing)'} does not match _meta ${metaVersion}`, 400);
    }
    const methodHeader = request.headers.get('mcp-method');
    if (methodHeader !== method) {
      return rpcError(id, -32020, `Header mismatch: Mcp-Method header ${methodHeader ?? '(missing)'} does not match body method ${method}`, 400);
    }
    if (method === 'tools/call') {
      const raw = request.headers.get('mcp-name');
      const name = raw === null ? null : decodeHeaderValue(raw);
      if (name === null || name !== params.name) {
        return rpcError(id, -32020, 'Header mismatch: Mcp-Name header does not match params.name', 400);
      }
    }
    if (!meta || !isRecord(meta[META_CAPABILITIES])) {
      return rpcError(id, -32602, `Invalid params: _meta["${META_CAPABILITIES}"] is required`, 400);
    }
    return { modern: true, version: metaVersion };
  }

  if (header !== null && MODERN_VERSIONS.includes(header)) {
    return rpcError(id, -32602, `Invalid params: _meta["${META_VERSION}"] is required for protocol ${header}`, 400);
  }
  if (header !== null && !LEGACY_VERSIONS.includes(header)) {
    return rpcError(id, -32022, 'Unsupported protocol version', 400, { supported: SUPPORTED_VERSIONS, requested: header });
  }
  // Clients older than 2025-06-18 do not send the header.
  return { modern: false, version: header ?? '2025-03-26' };
}

function decorate(result: Record<string, unknown>, era: Era): Record<string, unknown> {
  if (!era.modern) return result;
  const meta = isRecord(result._meta) ? result._meta : {};
  return { ...result, resultType: 'complete', _meta: { ...meta, [META_SERVER_INFO]: { name: SERVER_INFO.name, version: SERVER_INFO.version } } };
}

function unauthorized(id: JsonRpcId, issuer: string, caller: Extract<McpCaller, { ok: false }>): Response {
  const challenge = caller.error === 'missing'
    ? bearerChallenge(issuer)
    : bearerChallenge(issuer, { error: 'invalid_token', error_description: caller.description });
  return rpcError(id, ERR_UNAUTHORIZED, caller.description, 401, undefined, { 'WWW-Authenticate': challenge });
}

export async function handleMcpPost(request: Request, env: RuntimeEnv): Promise<Response> {
  if (!originAllowed(request, env)) return rpcError(null, ERR_FORBIDDEN, 'Origin not allowed', 403);
  const issuer = issuerFor(request);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return rpcError(null, -32700, 'Parse error', 400);
  }
  if (Array.isArray(body)) return rpcError(null, -32600, 'Invalid Request: JSON-RPC batches are not supported', 400);
  if (!isRecord(body) || body.jsonrpc !== '2.0') return rpcError(null, -32600, 'Invalid Request', 400);
  const rawId = body.id;
  const id: JsonRpcId = typeof rawId === 'string' || typeof rawId === 'number' ? rawId : null;
  const method = typeof body.method === 'string' ? body.method : null;

  const caller = await resolveMcpCaller(request, env, mcpResourceFor(issuer));
  if (!caller.ok) return unauthorized(id, issuer, caller);

  // Notifications and client responses carry no id: accept without a body.
  if (method === null || rawId === undefined) {
    if (method === null && !('result' in body) && !('error' in body)) return rpcError(null, -32600, 'Invalid Request', 400);
    return new Response(null, { status: 202 });
  }
  if (id === null) return rpcError(null, -32600, 'Invalid Request: id must be a string or number', 400);

  const params = isRecord(body.params) ? body.params : {};
  const era = negotiate(request, id, method, params);
  if (era instanceof Response) return era;
  const ok = (result: Record<string, unknown>): Response => respond({ jsonrpc: '2.0', id, result: decorate(result, era) });
  const { principal, oauth } = caller;

  switch (method) {
    case 'initialize':
      return ok({ protocolVersion: era.version, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS });
    case 'server/discover':
      return ok({ supportedVersions: SUPPORTED_VERSIONS, capabilities: { tools: { listChanged: false } }, instructions: INSTRUCTIONS });
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: visibleTools(principal, allMcpTools()) });
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = isRecord(params.arguments) ? params.arguments : {};
      const access = toolAccess(name);
      try {
        return ok(toolResult(await callMcpTool(name, args, toolContext(request, env, principal))));
      } catch (err) {
        if (!(err instanceof AppError)) {
          console.error('MCP tool error:', name, err instanceof Error ? err.message : 'unknown');
          return rpcError(id, -32603, 'Internal error', 500);
        }
        if (err.code === 'unknown_tool') return rpcError(id, -32602, `Unknown tool: ${name}`, 200);
        const scope = stepUpScope(oauth, err, access);
        if (scope) {
          const challenge = bearerChallenge(issuer, { error: 'insufficient_scope', scope, error_description: err.message });
          return rpcError(id, ERR_FORBIDDEN, err.message, 403, { code: 'insufficient_scope', required_scope: scope }, { 'WWW-Authenticate': challenge });
        }
        return ok(toolErrorResult(err));
      }
    }
    default:
      // Modern servers answer unknown methods with HTTP 404; legacy clients expect a plain JSON-RPC error.
      return rpcError(id, -32601, `Method not found: ${method}`, era.modern ? 404 : 200);
  }
}

export function methodNotAllowed(): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32600, message: 'Use POST for MCP requests (no GET/DELETE streams or sessions)' } }), {
    status: 405,
    headers: { 'Content-Type': 'application/json', Allow: 'POST, OPTIONS' },
  });
}
