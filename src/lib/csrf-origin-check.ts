/**
 * Cross-site form submission guard. It reproduces Astro's built-in `security.checkOrigin` (disabled in
 * astro.config.mjs) so machine endpoints can be exempted: OAuth clients such as claude.ai call the token
 * and revocation endpoints server-to-server with form bodies and no Origin header.
 */

const FORM_CONTENT_TYPES = ['application/x-www-form-urlencoded', 'multipart/form-data', 'text/plain'];
const SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS'];

/**
 * Machine endpoints that never honour cookies: MCP + OAuth back-channel + discovery (called cross-origin by
 * browser-based MCP clients) and the token-authorized RFC 8058 one-click unsubscribe that mailbox providers POST
 * as a form without an Origin header.
 */
export function isMachineEndpoint(pathname: string): boolean {
  return pathname === '/mcp'
    || pathname === '/api/email/unsubscribe'
    || pathname === '/oauth/token'
    || pathname === '/oauth/register'
    || pathname === '/oauth/revoke'
    || pathname.startsWith('/.well-known/oauth-');
}

function isFormContentType(value: string): boolean {
  const type = value.split(';')[0]?.trim().toLowerCase() ?? '';
  return FORM_CONTENT_TYPES.includes(type);
}

/**
 * True when an unsafe request must be refused: a form-like body (or no body type at all) whose Origin is
 * not this site. Machine endpoints never honour cookies, so they are exempt.
 */
export function isForbiddenCrossSiteSubmission(request: Request, url: URL): boolean {
  if (SAFE_METHODS.includes(request.method) || isMachineEndpoint(url.pathname)) return false;
  if (request.headers.get('origin') === url.origin) return false;
  const contentType = request.headers.get('content-type');
  return contentType === null || isFormContentType(contentType);
}
