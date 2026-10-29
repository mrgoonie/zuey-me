import { AppError } from '../http';
import type { McpToolModule } from '../mcp/types';
import { CHANNEL_ACCESS_SCOPE, handleChannelAccessCheck } from './check';

/**
 * `channel_access_check`: the dewee Channel Access Gate verifier tool. Callable only with the dedicated
 * service key (CHANNEL_ACCESS_SERVICE_KEY) on the JSON-RPC endpoint `/api/mcp`; every other credential is
 * rejected inside the tool. The OAuth endpoint `/mcp` never accepts the service key. Chat accounts are linked
 * and recovered in Dewee (hosted linking), so there are no zuey.me identity tools.
 */
export const channelAccessMcpModule: McpToolModule = {
  tools: [
    {
      name: 'channel_access_check',
      description: `Service (scope ${CHANNEL_ACCESS_SCOPE}, dewee Channel Access Gate, hosted linking): may this linked chat sender talk to the Zuey AI agent? Dewee sends contract version 2 with external_subject = the zuey.me member id. Returns decision allow (member with the agent_chat entitlement, admins always) or deny (no active plan: link_url = pricing; no or unknown external_subject: no link, the sender is never mapped by sender_id), plus ttl_seconds and an opaque subject_ref. Requires Authorization: Bearer <CHANNEL_ACCESS_SERVICE_KEY>; admin and personal keys are rejected.`,
      inputSchema: {
        type: 'object',
        required: ['version', 'channel_type', 'sender_id', 'chat_type'],
        properties: {
          version: { type: 'integer', enum: [1, 2], description: 'Contract version (2 in hosted mode; version 1 is always denied)' },
          tenant: { type: 'string' },
          agent_key: { type: 'string' },
          channel_type: { type: 'string', description: 'dewee channel type, e.g. telegram' },
          channel_instance: { type: 'string' },
          sender_id: { type: 'string', description: 'Canonical platform sender id (never used to pick a member)' },
          sender_username: { type: 'string' },
          chat_type: { type: 'string', enum: ['direct', 'group'] },
          chat_id: { type: 'string' },
          principal_id: { type: 'string', description: 'Dewee principal of the linked sender (version 2)' },
          external_subject: { type: 'string', description: 'zuey.me member id of the linked sender (version 2); without it the answer is deny' },
          authn_level: { type: 'string', enum: ['verified', 'channel'], description: 'How Dewee established the sender (version 2)' },
        },
      },
    },
  ],
  async call(name, args, ctx) {
    if (name === 'channel_access_check') return handleChannelAccessCheck(ctx.request, { ...ctx.env, DB: ctx.d1 ?? ctx.env.DB }, args);
    throw new AppError(404, 'unknown_tool', `Unknown tool ${name}`);
  },
};
