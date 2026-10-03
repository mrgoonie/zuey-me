import type { OpenApiFragment } from '../openapi/types';
import { OAUTH_SCOPES } from './config';
import { SUPPORTED_VERSIONS } from './mcp-http';

const OAUTH_TAG = 'OAuth & MCP';

const json = (schema: Record<string, unknown>) => ({ 'application/json': { schema } });
const form = (schema: Record<string, unknown>) => ({ 'application/x-www-form-urlencoded': { schema } });
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const oauthError = { description: 'RFC 6749 error (`invalid_request`, `invalid_client`, `invalid_grant`, `unsupported_grant_type`, `invalid_scope`, `invalid_target`)', content: json(ref('OAuthError')) };
const envelopeError = { content: json(ref('Error')) };
const sessionOnly = [{ MemberSession: [] }];
const clientAuth = 'Public clients send `client_id` only; confidential (DCR) clients use HTTP Basic (`client_secret_basic`) or `client_secret`/`client_id` form fields (`client_secret_post`).';

export const oauthOpenApi: OpenApiFragment = {
  tag: {
    name: OAUTH_TAG,
    description: [
      'OAuth 2.1 authorization server for MCP clients (authorization code + PKCE S256 only, rotating refresh tokens, RFC 8707 resource indicators, RFC 9207 `iss`).',
      'Clients are identified by a Client ID Metadata Document URL or registered via RFC 7591 Dynamic Client Registration.',
      'Access tokens (`zoa_…`) are audience-bound to `<origin>/mcp` and only accepted by the `/mcp` endpoint in the `Authorization` header.',
      `\`/mcp\` speaks MCP Streamable HTTP (JSON-RPC 2.0, JSON responses, stateless). Supported protocol versions: ${SUPPORTED_VERSIONS.join(', ')}.`,
      '`/mcp` also accepts personal `zk_` keys and admin API keys; tools are filtered per caller and scope.',
    ].join(' '),
  },
  paths: {
    '/.well-known/oauth-authorization-server': {
      get: {
        tags: [OAUTH_TAG], summary: 'Authorization server metadata (RFC 8414)', security: [],
        responses: { '200': { description: 'Metadata', content: json({ type: 'object', additionalProperties: true }) } },
      },
    },
    '/.well-known/oauth-protected-resource/mcp': {
      get: {
        tags: [OAUTH_TAG], summary: 'Protected resource metadata for /mcp (RFC 9728); also served at /.well-known/oauth-protected-resource', security: [],
        responses: { '200': { description: 'Metadata', content: json(ref('ProtectedResourceMetadata')) } },
      },
    },
    '/oauth/register': {
      post: {
        tags: [OAUTH_TAG], summary: 'Dynamic client registration (RFC 7591)', security: [],
        description: 'Redirect URIs must be https, loopback http, or a private-use scheme; they are matched exactly at /oauth/authorize. Rate limited per IP.',
        requestBody: { required: true, content: json(ref('ClientRegistrationRequest')) },
        responses: {
          '201': { description: 'Registered. `client_secret` is shown once (confidential clients only).', content: json({ type: 'object', additionalProperties: true }) },
          '400': { description: '`invalid_redirect_uri` or `invalid_client_metadata`', content: json(ref('OAuthError')) },
          '429': { description: '`temporarily_unavailable` (too many registrations)', content: json(ref('OAuthError')) },
        },
      },
    },
    '/oauth/authorize': {
      get: {
        tags: [OAUTH_TAG], summary: 'Authorization endpoint (browser): member sign-in, then consent screen', security: [],
        description: 'Not callable from Try-it — open it in a browser. Errors about client_id/redirect_uri render a page; every other error redirects to the registered redirect_uri with `error`, `state` and `iss`.',
        parameters: [
          { name: 'response_type', in: 'query', required: true, schema: { type: 'string', enum: ['code'] } },
          { name: 'client_id', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'redirect_uri', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'code_challenge', in: 'query', required: true, schema: { type: 'string', minLength: 43, maxLength: 43 } },
          { name: 'code_challenge_method', in: 'query', required: true, schema: { type: 'string', enum: ['S256'] } },
          { name: 'state', in: 'query', schema: { type: 'string', maxLength: 500 } },
          { name: 'scope', in: 'query', schema: { type: 'string', description: `Space-separated subset of: ${OAUTH_SCOPES.join(' ')}` } },
          { name: 'resource', in: 'query', schema: { type: 'string', example: 'https://zuey.me/mcp' } },
        ],
        responses: { '302': { description: 'Redirect to sign-in, consent, or the client redirect_uri' }, '400': { description: 'HTML error page' } },
      },
    },
    '/oauth/token': {
      post: {
        tags: [OAUTH_TAG], summary: 'Token endpoint: authorization_code (+PKCE) and refresh_token (rotating)', security: [],
        description: `${clientAuth} Reusing a refresh token or authorization code revokes the whole token family.`,
        requestBody: { required: true, content: form(ref('TokenRequest')) },
        responses: { '200': { description: 'Tokens', content: json(ref('TokenResponse')) }, '400': oauthError, '401': oauthError },
      },
    },
    '/oauth/revoke': {
      post: {
        tags: [OAUTH_TAG], summary: 'Token revocation (RFC 7009); revokes the token family', security: [],
        description: clientAuth,
        requestBody: { required: true, content: form({ type: 'object', required: ['token'], properties: { token: { type: 'string' }, token_type_hint: { type: 'string' }, client_id: { type: 'string' } } }) },
        responses: { '200': { description: 'Revoked (also returned for unknown tokens)' }, '400': oauthError, '401': oauthError },
      },
    },
    '/oauth/connections': {
      get: {
        tags: [OAUTH_TAG], summary: 'Your connected apps (OAuth consents) — no token material', security: [{ MemberSession: [] }, { BearerAuth: [] }],
        responses: {
          '200': { description: 'Apps', content: json({ type: 'object', properties: { success: { type: 'boolean', enum: [true] }, data: { type: 'array', items: ref('ConnectedApp') } } }) },
          '401': { description: 'Not signed in', ...envelopeError },
        },
      },
    },
    '/oauth/connections/{id}': {
      delete: {
        tags: [OAUTH_TAG], summary: 'Disconnect an app: revoke consent and every token (session only)', security: sessionOnly,
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'Disconnected', content: json({ type: 'object', properties: { success: { type: 'boolean', enum: [true] }, data: { type: 'object' } } }) },
          '403': { description: '`session_required` or `csrf_rejected`', ...envelopeError },
          '404': { description: 'Not found', ...envelopeError },
        },
      },
    },
    '/mcp': {
      post: {
        tags: [OAUTH_TAG], summary: 'MCP Streamable HTTP endpoint (JSON-RPC 2.0)',
        security: [{ McpOAuth: [] }, { BearerAuth: [] }],
        description: [
          'Methods: `server/discover`, `initialize` (legacy versions), `ping`, `tools/list`, `tools/call`.',
          'For 2026-07-28 send `params._meta["io.modelcontextprotocol/protocolVersion"]` and the matching `MCP-Protocol-Version` and `Mcp-Method` headers (`Mcp-Name` for tools/call).',
          '401 responses carry `WWW-Authenticate: Bearer resource_metadata="…"`; 403 with `error="insufficient_scope"` names the scope to request.',
          'GET and DELETE answer 405 (no server-initiated stream, stateless server).',
        ].join(' '),
        parameters: [
          { name: 'MCP-Protocol-Version', in: 'header', schema: { type: 'string', enum: SUPPORTED_VERSIONS } },
          { name: 'Mcp-Method', in: 'header', schema: { type: 'string' } },
          { name: 'Mcp-Name', in: 'header', schema: { type: 'string' } },
        ],
        requestBody: {
          required: true,
          content: json({
            type: 'object', required: ['jsonrpc', 'method'],
            properties: { jsonrpc: { type: 'string', enum: ['2.0'] }, id: { type: ['string', 'integer'] }, method: { type: 'string' }, params: { type: 'object' } },
            example: {
              jsonrpc: '2.0', id: 1, method: 'tools/list',
              params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } },
            },
          }),
        },
        responses: {
          '200': { description: 'JSON-RPC result or error', content: json({ type: 'object', additionalProperties: true }) },
          '202': { description: 'Notification accepted' },
          '400': { description: 'Malformed JSON-RPC, header mismatch (-32020) or unsupported protocol version (-32022)' },
          '401': { description: 'Missing, invalid, expired or wrong-audience token (WWW-Authenticate challenge)' },
          '403': { description: 'Origin not allowed, or insufficient_scope step-up challenge' },
        },
      },
    },
  },
  schemas: {
    OAuthError: {
      type: 'object', required: ['error'],
      properties: { error: { type: 'string' }, error_description: { type: 'string' } },
    },
    ProtectedResourceMetadata: {
      type: 'object',
      properties: {
        resource: { type: 'string', example: 'https://zuey.me/mcp' },
        authorization_servers: { type: 'array', items: { type: 'string' } },
        scopes_supported: { type: 'array', items: { type: 'string' } },
        bearer_methods_supported: { type: 'array', items: { type: 'string', enum: ['header'] } },
      },
    },
    ClientRegistrationRequest: {
      type: 'object', required: ['redirect_uris'],
      properties: {
        redirect_uris: { type: 'array', items: { type: 'string' }, minItems: 1 },
        client_name: { type: 'string' },
        client_uri: { type: 'string' },
        token_endpoint_auth_method: { type: 'string', enum: ['none', 'client_secret_post', 'client_secret_basic'] },
        grant_types: { type: 'array', items: { type: 'string', enum: ['authorization_code', 'refresh_token'] } },
        response_types: { type: 'array', items: { type: 'string', enum: ['code'] } },
        scope: { type: 'string' },
      },
    },
    TokenRequest: {
      type: 'object', required: ['grant_type'],
      properties: {
        grant_type: { type: 'string', enum: ['authorization_code', 'refresh_token'] },
        code: { type: 'string' }, redirect_uri: { type: 'string' }, code_verifier: { type: 'string', minLength: 43, maxLength: 128 },
        refresh_token: { type: 'string' }, scope: { type: 'string', description: 'Refresh only: narrow the granted scopes' },
        resource: { type: 'string' }, client_id: { type: 'string' }, client_secret: { type: 'string' },
      },
    },
    TokenResponse: {
      type: 'object', required: ['access_token', 'token_type', 'expires_in', 'scope'],
      properties: {
        access_token: { type: 'string' }, token_type: { type: 'string', enum: ['Bearer'] }, expires_in: { type: 'integer' },
        refresh_token: { type: 'string' }, scope: { type: 'string' },
      },
    },
    ConnectedApp: {
      type: 'object',
      properties: {
        id: { type: 'string' }, client_id: { type: 'string' }, client_name: { type: 'string' }, client_uri: { type: ['string', 'null'] },
        registration: { type: 'string', enum: ['dcr', 'cimd'] }, redirect_hosts: { type: 'array', items: { type: 'string' } },
        scopes: { type: 'array', items: { type: 'string', enum: [...OAUTH_SCOPES] } },
        granted_at: { type: 'string', format: 'date-time' }, last_used_at: { type: ['string', 'null'], format: 'date-time' },
        active_tokens: { type: 'integer' },
      },
    },
  },
};
