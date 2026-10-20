/**
 * Owner presence MCP tools. Listed only for the owner (`owner` visibility in oauth/tool-access.ts) and
 * re-checked on every call: owner = member id in PRESENCE_OWNER_MEMBER_IDS, never the admin role.
 */
import { AppError } from '../http';
import type { McpContext, McpToolModule } from '../mcp/types';
import { OWNER_MODES, OWNER_STATUS_TEXT_MAX } from './contract';
import { getOwnerStatus, parseOwnerStatusUpdate, setOwnerStatus } from './presence-owner-client';
import { requirePresenceOwner, type PresenceOwnerAccess } from './presence-owner-identity';

async function requireOwner(ctx: McpContext, access: PresenceOwnerAccess): Promise<void> {
  if (!ctx.principal) throw new AppError(401, 'unauthorized', 'Owner identity required');
  requirePresenceOwner(await ctx.principal(), ctx.env, access);
}

export const presenceMcpModule: McpToolModule = {
  tools: [
    {
      name: 'presence_status_get',
      description: 'Owner only: your presence setting (mode, text), whether you are connected, and the public status visitors see.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'presence_status_set',
      description: 'Owner only: set your presence. auto = online while on zuey.me; away/busy shown publicly; offline; invisible shows as offline. Omit or empty text to clear it.',
      inputSchema: {
        type: 'object',
        required: ['mode'],
        properties: {
          mode: { type: 'string', enum: [...OWNER_MODES] },
          text: { type: 'string', maxLength: OWNER_STATUS_TEXT_MAX, description: 'Optional short public status text (plain, one line)' },
        },
      },
    },
  ],
  async call(name, args, ctx) {
    switch (name) {
      case 'presence_status_get':
        await requireOwner(ctx, 'read');
        return getOwnerStatus(ctx.env);
      case 'presence_status_set':
        await requireOwner(ctx, 'write');
        return setOwnerStatus(ctx.env, parseOwnerStatusUpdate(args));
      default:
        throw new AppError(404, 'unknown_tool', `Unknown tool ${name}`);
    }
  },
};
