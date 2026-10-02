import { defineMiddleware } from 'astro:middleware';
import { REQUEST_ID_HEADER, resolveRequestId, withRequestId } from './lib/http';

/** Bearer-only machine endpoints (MCP + OAuth back-channel + discovery) that browser-based MCP clients call cross-origin. */
function isMachineEndpoint(pathname: string): boolean {
  return pathname === '/mcp'
    || pathname === '/oauth/token'
    || pathname === '/oauth/register'
    || pathname === '/oauth/revoke'
    || pathname.startsWith('/.well-known/oauth-');
}

const MACHINE_ALLOW_HEADERS = 'Content-Type, Authorization, Accept, MCP-Protocol-Version, Mcp-Method, Mcp-Name, Last-Event-ID, X-Request-Id';
const EXPOSE_HEADERS = 'WWW-Authenticate, X-Request-Id, MCP-Protocol-Version';

function setMachineCors(headers: Headers): void {
  // No cookies are honoured on these endpoints (Bearer tokens only), so a wildcard origin is safe; /mcp
  // additionally validates the Origin header itself.
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  headers.set('Access-Control-Allow-Headers', MACHINE_ALLOW_HEADERS);
  headers.set('Access-Control-Expose-Headers', EXPOSE_HEADERS);
  headers.set('Access-Control-Max-Age', '600');
}

export const onRequest = defineMiddleware(async (context, next) => {
  const { request, url } = context;
  const accept = request.headers.get('accept') || '';
  const requestId = resolveRequestId(request);
  const machine = isMachineEndpoint(url.pathname);

  // Intercept root page when requesting text/markdown
  if (url.pathname === '/' && accept.includes('text/markdown')) {
    return context.redirect('/index.md', 307);
  }

  if (machine && request.method === 'OPTIONS') {
    const headers = new Headers({ [REQUEST_ID_HEADER]: requestId });
    setMachineCors(headers);
    return new Response(null, { status: 204, headers });
  }

  const response = await withRequestId(await next(), requestId);

  if (machine) {
    setMachineCors(response.headers);
  } else if (url.pathname.startsWith('/api/') || url.pathname.endsWith('.md') || url.pathname.endsWith('.txt')) {
    // Add CORS headers for API and Markdown routes
    response.headers.set('Access-Control-Allow-Origin', '*');
    response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key, X-Request-Id');
    response.headers.set('Access-Control-Expose-Headers', EXPOSE_HEADERS);
  }

  return response;
});
