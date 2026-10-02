import { DEFAULT_MEMBER_SCOPES, OAUTH_SCOPES, issuerFor, mcpResourceFor } from './config';

const PUBLIC_CACHE = { 'Cache-Control': 'public, max-age=300' };

function json(body: unknown): Response {
  return new Response(JSON.stringify(body, null, 2), { headers: { 'Content-Type': 'application/json', ...PUBLIC_CACHE } });
}

/** RFC 8414 authorization server metadata. */
export function authorizationServerMetadata(request: Request): Record<string, unknown> {
  const issuer = issuerFor(request);
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    scopes_supported: [...OAUTH_SCOPES],
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    revocation_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
    service_documentation: `${issuer}/docs`,
  };
}

/** RFC 9728 protected resource metadata for the MCP endpoint (same document at root and path-inserted URLs). */
export function protectedResourceMetadata(request: Request): Record<string, unknown> {
  const issuer = issuerFor(request);
  return {
    resource: mcpResourceFor(issuer),
    authorization_servers: [issuer],
    // Minimal member scopes for normal use; `admin` is requested only by admins (step-up).
    scopes_supported: [...DEFAULT_MEMBER_SCOPES],
    bearer_methods_supported: ['header'],
    resource_name: 'Zuey MCP',
    resource_documentation: `${issuer}/docs`,
  };
}

export function authorizationServerMetadataResponse(request: Request): Response {
  return json(authorizationServerMetadata(request));
}

export function protectedResourceMetadataResponse(request: Request): Response {
  return json(protectedResourceMetadata(request));
}
