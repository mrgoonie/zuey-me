import type { APIRoute } from 'astro';
import { handleMcpPost, methodNotAllowed } from '../lib/oauth/mcp-http';

/** Remote MCP endpoint (Streamable HTTP, OAuth 2.1 bearer). See src/lib/oauth/mcp-http.ts. */
export const POST: APIRoute = async ({ request, locals }) => {
  try {
    return await handleMcpPost(request, locals.runtime?.env ?? {});
  } catch (err) {
    console.error('MCP endpoint error:', err instanceof Error ? err.message : 'unknown');
    return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' } }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

export const GET: APIRoute = () => methodNotAllowed();
export const DELETE: APIRoute = () => methodNotAllowed();
