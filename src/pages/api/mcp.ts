import type { APIRoute } from 'astro';
import { authenticateAdmin } from '../../lib/auth';
import { AppError } from '../../lib/http';
import { allMcpTools, callMcpTool } from '../../lib/mcp/dispatch';
import type { McpContext } from '../../lib/mcp/types';
import { resolvePrincipal } from '../../lib/members/policy';
import type { Principal } from '../../lib/members/policy';

/**
 * Legacy JSON-RPC MCP endpoint (protocol 2024-11-05). Accepts Studio sessions, admin/read API keys and
 * member `zk_` keys; anonymous callers get the public tools. The OAuth-protected Streamable HTTP
 * endpoint is `/mcp` and shares the same tools and authorization decisions.
 */
function rpc(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime?.env ?? {};
  const d1 = env.DB;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return rpc({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }, 400);
  }
  if (!isRecord(body)) return rpc({ jsonrpc: '2.0', error: { code: -32600, message: 'Invalid Request' }, id: null }, 400);

  const method = typeof body.method === 'string' ? body.method : '';
  const id = body.id !== undefined ? body.id : null;

  if (method === 'initialize') {
    return rpc({
      jsonrpc: '2.0',
      id,
      result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'zuey-me-mcp', version: '1.0.0' } },
    });
  }

  if (method === 'tools/list') {
    return rpc({ jsonrpc: '2.0', id, result: { tools: allMcpTools() } });
  }

  if (method === 'tools/call') {
    const params = isRecord(body.params) ? body.params : {};
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? params.arguments : {};

    let principalPromise: Promise<Principal> | null = null;
    const ctx: McpContext = {
      request,
      env,
      d1,
      principal() {
        principalPromise ??= resolvePrincipal(request, { ...env, DB: d1 });
        return principalPromise;
      },
      async requireAdmin() {
        const auth = await authenticateAdmin(request, d1, env);
        if (!auth.authenticated) {
          throw new AppError(auth.role ? 403 : 401, auth.role ? 'forbidden' : 'unauthorized', auth.error || 'Unauthorized. Provide Authorization: Bearer <API_KEY>');
        }
      },
      async isAdmin() {
        return (await authenticateAdmin(request, d1, env)).authenticated;
      },
    };

    try {
      const data = await callMcpTool(toolName, args, ctx);
      return rpc({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] } });
    } catch (err) {
      const appErr = err instanceof AppError ? err : null;
      if (appErr?.code === 'unknown_tool') {
        return rpc({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${toolName}` } }, 404);
      }
      if (!appErr) console.error('MCP tool error:', toolName, err instanceof Error ? err.message : 'unknown');
      return rpc({
        jsonrpc: '2.0',
        id,
        error: {
          code: appErr && (appErr.status === 401 || appErr.status === 403) ? -32001 : -32000,
          message: appErr ? appErr.message : 'Internal error',
          data: appErr ? { code: appErr.code, status: appErr.status, ...appErr.extra } : { code: 'internal_error' },
        },
      }, appErr ? appErr.status : 500);
    }
  }

  return rpc({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } }, 404);
};
