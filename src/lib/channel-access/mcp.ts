import { AppError } from '../http';
import type { McpToolModule } from '../mcp/types';
import { CHANNEL_ACCESS_SCOPE, handleChannelAccessCheck } from './check';
import { SUPPORTED_CHANNEL_TYPES } from './link-token';

/**
 * `channel_access_check`: the dewee Channel Access Gate verifier tool. Callable only with the dedicated
 * service key (CHANNEL_ACCESS_SERVICE_KEY) on the JSON-RPC endpoint `/api/mcp`; every other credential is
 * rejected inside the tool. The OAuth endpoint `/mcp` never accepts the service key.
 */
export const channelAccessMcpModule: McpToolModule = {
  tools: [
    {
      name: 'channel_access_check',
      description: `Service (scope ${CHANNEL_ACCESS_SCOPE}, dewee Channel Access Gate v1): may this chat sender talk to the Zuey AI agent? Returns decision allow (linked member with the agent_chat entitlement), deny (linked, no active plan; link_url = pricing) or link_required (sender not linked; link_url = /connect when link_token is given), plus ttl_seconds and an opaque subject_ref. Requires Authorization: Bearer <CHANNEL_ACCESS_SERVICE_KEY>; admin and personal keys are rejected.`,
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
          link_token: { type: 'string', description: 'Signed dewee link token; echoed into the /connect link_url when the sender must link' },
        },
      },
    },
  ],
  async call(name, args, ctx) {
    if (name !== 'channel_access_check') throw new AppError(404, 'unknown_tool', `Unknown tool ${name}`);
    return handleChannelAccessCheck(ctx.request, { ...ctx.env, DB: ctx.d1 ?? ctx.env.DB }, args);
  },
};
