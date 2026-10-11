import { AppError } from '../http';
import type { McpContext, McpToolModule } from '../mcp/types';
import type { Principal } from '../members/policy';
import { requireCan, resolvePrincipal } from '../members/policy';
import { MAX_UNLINK_REASON_LENGTH, adminGetChannelIdentity, adminUnlinkChannelIdentity, parseChannelRef, parseUnlinkReason } from './admin';
import { CHANNEL_ACCESS_SCOPE, handleChannelAccessCheck } from './check';
import { SUPPORTED_CHANNEL_TYPES } from './link-token';

async function principalOf(ctx: McpContext): Promise<Principal> {
  return ctx.principal ? ctx.principal() : resolvePrincipal(ctx.request, { ...ctx.env, DB: ctx.d1 ?? ctx.env.DB });
}

function requireDb(ctx: McpContext): NonNullable<McpContext['d1']> {
  const d1 = ctx.d1 ?? ctx.env.DB;
  if (!d1) throw new AppError(503, 'database_unavailable', 'Membership requires the D1 database binding (DB)');
  return d1;
}

const refProperties = {
  provider: { type: 'string', enum: [...SUPPORTED_CHANNEL_TYPES], description: 'Chat channel (dewee channel_type)' },
  external_id: { type: 'string', description: 'Platform sender id (Telegram numeric user id)' },
};

/**
 * `channel_access_check`: the dewee Channel Access Gate verifier tool. Callable only with the dedicated
 * service key (CHANNEL_ACCESS_SERVICE_KEY) on the JSON-RPC endpoint `/api/mcp`; every other credential is
 * rejected inside the tool. The OAuth endpoint `/mcp` never accepts the service key.
 * `channel_identity_get` / `channel_identity_unlink`: admin recovery for a chat account linked to the wrong
 * member; read-only admin keys are refused.
 */
export const channelAccessMcpModule: McpToolModule = {
  tools: [
    {
      name: 'channel_access_check',
      description: `Service (scope ${CHANNEL_ACCESS_SCOPE}, dewee Channel Access Gate v1): may this chat sender talk to the Zuey AI agent? Returns decision allow (linked member with the agent_chat entitlement), deny (linked, no active plan; link_url = pricing) or link_required (sender not linked; link_url = /connect when link_token is given in a direct chat, never in a group), plus ttl_seconds and an opaque subject_ref. Requires Authorization: Bearer <CHANNEL_ACCESS_SERVICE_KEY>; admin and personal keys are rejected.`,
      inputSchema: {
        type: 'object',
        required: ['version', 'channel_type', 'sender_id', 'chat_type'],
        properties: {
          version: { type: 'integer', enum: [1], description: 'Contract version' },
          tenant: { type: 'string' },
          agent_key: { type: 'string' },
          channel_type: { type: 'string', enum: [...SUPPORTED_CHANNEL_TYPES] },
          channel_instance: { type: 'string' },
          sender_id: { type: 'string', description: 'Platform sender id (Telegram user id)' },
          sender_username: { type: 'string' },
          chat_type: { type: 'string', enum: ['direct', 'group'] },
          chat_id: { type: 'string' },
          link_token: { type: 'string', description: 'Signed dewee link token; echoed into the /connect link_url when the sender must link (direct chats only)' },
        },
      },
    },
    {
      name: 'channel_identity_get',
      description: 'Admin: which member (id, email, name) holds a linked chat account, with linked_at and source (link_token or community_backfill). 404 not_found when the sender id is not linked.',
      inputSchema: { type: 'object', required: ['provider', 'external_id'], properties: refProperties },
    },
    {
      name: 'channel_identity_unlink',
      description: 'Admin: unlink a chat account from whichever member holds it (e.g. a wrong community backfill or a link made on someone else\'s device), so the real owner can link it at /connect. The affected member\'s activity log shows only that an admin unlinked it (channel.unlinked, by admin); you and the optional reason are recorded in the admin-only admin_access_audit log. Also tells dewee to drop its cached gate decision for that sender. Read-only keys are refused; 404 not_found when the sender id is not linked.',
      inputSchema: {
        type: 'object',
        required: ['provider', 'external_id'],
        properties: { ...refProperties, reason: { type: 'string', maxLength: MAX_UNLINK_REASON_LENGTH, description: 'Why it was unlinked (admin-only audit log; never shown to the member)' } },
      },
    },
  ],
  async call(name, args, ctx) {
    switch (name) {
      case 'channel_access_check':
        return handleChannelAccessCheck(ctx.request, { ...ctx.env, DB: ctx.d1 ?? ctx.env.DB }, args);
      case 'channel_identity_get': {
        requireCan(await principalOf(ctx), 'admin');
        return adminGetChannelIdentity(requireDb(ctx), parseChannelRef(args.provider, args.external_id));
      }
      case 'channel_identity_unlink': {
        const p = await principalOf(ctx);
        requireCan(p, 'admin');
        const ref = parseChannelRef(args.provider, args.external_id);
        const reason = parseUnlinkReason(args.reason);
        return adminUnlinkChannelIdentity(requireDb(ctx), ctx.env, ref, { principal: p, reason, waitUntil: ctx.waitUntil });
      }
      default:
        throw new AppError(404, 'unknown_tool', `Unknown tool ${name}`);
    }
  },
};
