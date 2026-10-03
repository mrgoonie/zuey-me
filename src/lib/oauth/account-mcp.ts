import { AppError } from '../http';
import { listUserKeys, toKeyView } from '../members/api-keys';
import { membersRuntime } from '../members/runtime';
import type { McpToolModule } from '../mcp/types';
import { requireUserId, resolvePrincipal } from '../members/policy';

/**
 * Read-only account tools. Key metadata only (prefix, name, scopes, dates, status) — secrets are never
 * stored, and creating/rotating/revoking keys stays a browser-session action at /account.
 */
export const accountMcpModule: McpToolModule = {
  tools: [
    {
      name: 'me_keys_list',
      description: 'Member: list your personal API keys (masked prefix, name, scopes, expiry, last use, status). Read-only; manage keys at /account (scope account:read).',
      inputSchema: { type: 'object', properties: {} },
    },
  ],

  async call(name, _args, ctx) {
    if (name !== 'me_keys_list') throw new AppError(404, 'unknown_tool', `Unknown tool ${name}`);
    const p = ctx.principal ? await ctx.principal() : await resolvePrincipal(ctx.request, { ...ctx.env, DB: ctx.d1 ?? ctx.env.DB });
    const userId = requireUserId(p, 'account:read');
    const d1 = ctx.d1 ?? ctx.env.DB;
    if (!d1) throw new AppError(503, 'database_unavailable', 'Membership requires the D1 database binding (DB)');
    const now = membersRuntime.now();
    return { keys: (await listUserKeys(d1, userId)).map(k => toKeyView(k, now)), manage_url: '/account#keys' };
  },
};
