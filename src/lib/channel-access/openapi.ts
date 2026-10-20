import type { OpenApiFragment } from '../openapi/types';
import { errorResponses } from '../openapi/types';
import { ALLOW_TTL_SECONDS, CHANNEL_ACCESS_CONTRACT_VERSIONS, CHANNEL_ACCESS_SCOPE, DENY_TTL_SECONDS, SENDER_ID_RE } from './check';

const TAG = 'Channel access (dewee gate)';

const errorRef = { content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };
const json = (schema: Record<string, unknown>) => ({ 'application/json': { schema } });
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const ok = (description: string, schema: Record<string, unknown>) => ({
  description,
  content: json({ type: 'object', properties: { success: { type: 'boolean', enum: [true] }, data: schema } }),
});
const err = (description: string) => ({ description, ...errorRef });

const serviceAuth = [{ BearerAuth: [] }];
const sessionAuth = [{ MemberSession: [] }];

export const channelAccessOpenApi: OpenApiFragment = {
  tag: {
    name: TAG,
    description: [
      'zuey.me is the external entitlement verifier of the dewee Channel Access Gate in hosted linking mode (Dewee Connect): only members whose plans grant `agent_chat`',
      '(Zuey AI, Kết hợp, Cộng đồng) may chat with the Zuey AI agent. The verifier is also the MCP tool `channel_access_check` on `/api/mcp`.',
      `It accepts only the dedicated service key (scope \`${CHANNEL_ACCESS_SCOPE}\`, env CHANNEL_ACCESS_SERVICE_KEY) as Bearer; admin and personal keys are rejected.`,
      'Dewee links chat accounts itself: it sends the member to `/dewee/connect`, which signs a handoff assertion for the signed-in member,',
      'and calls the verifier only for linked senders, with `external_subject` = the zuey.me member id. Linked accounts are listed and unlinked through Dewee.',
    ].join(' '),
  },
  paths: {
    '/api/v1/channel-access/check': {
      post: {
        tags: [TAG],
        summary: `Service: decide whether a linked chat sender may talk to the agent (scope ${CHANNEL_ACCESS_SCOPE})`,
        description: `allow (ttl ${ALLOW_TTL_SECONDS}s) when the member named by \`external_subject\` has agent_chat (card renewals keep a 24-hour grace; admins always), deny + pricing link_url (ttl ${DENY_TTL_SECONDS}s) when the member has no active plan, deny without a link when \`external_subject\` is missing (including every version 1 request), unknown or a deleted account. The sender id is never mapped to a member. Send Content-Type: application/json.`,
        security: serviceAuth,
        requestBody: { required: true, content: json(ref('ChannelAccessCheckInput')) },
        responses: {
          '200': ok('Decision', ref('ChannelAccessDecision')),
          '400': err('`invalid_json` (body is not a JSON object), `invalid_field`, `unsupported_version` or `unsupported_channel`'),
          '401': err('`unauthorized` (no key) or `invalid_service_key` (any other credential)'),
          '503': err('`channel_access_unconfigured` or `database_unavailable`'),
        },
      },
    },
    '/api/v1/me/channels': {
      get: {
        tags: [TAG], summary: 'Your chat accounts linked in Dewee (account:read)', security: [{ MemberSession: [] }, { BearerAuth: [] }],
        description: 'Read from Dewee (`GET /v1/identity/me/bindings`) with a one-minute identity session of the signed-in member. Only the last characters of each sender id (`sender_hint`) are shown.',
        responses: {
          '200': ok('Linked chat accounts', { type: 'array', items: ref('ChannelBinding') }),
          '401': errorResponses['401'], '403': errorResponses['403'],
          '409': err('`dewee_identity_revoked`'),
          '502': err('`dewee_identity_unavailable`'),
          '503': err('`dewee_identity_unconfigured` or `database_unavailable`'),
        },
      },
    },
    '/api/v1/me/channels/{binding_id}': {
      delete: {
        tags: [TAG], summary: 'Unlink one of your chat accounts in Dewee (browser session); the agent stops answering it', security: sessionAuth,
        parameters: [{ name: 'binding_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' }, description: 'Binding id from GET /api/v1/me/channels' }],
        responses: {
          '200': ok('Unlinked', { type: 'object', properties: { unlinked: { type: 'boolean' } } }),
          '400': err('`invalid_field` (not a UUID)'), '401': errorResponses['401'], '403': errorResponses['403'],
          '404': err('`not_found` (no such binding of yours)'),
          '409': err('`dewee_identity_revoked`'),
          '502': err('`dewee_identity_unavailable`'),
          '503': err('`dewee_identity_unconfigured` or `database_unavailable`'),
        },
      },
    },
  },
  schemas: {
    ChannelAccessCheckInput: {
      type: 'object',
      required: ['version', 'channel_type', 'sender_id', 'chat_type'],
      properties: {
        version: { type: 'integer', enum: [...CHANNEL_ACCESS_CONTRACT_VERSIONS], description: '2 in hosted mode; a version 1 request is always denied' },
        tenant: { type: 'string' },
        agent_key: { type: 'string' },
        channel_type: { type: 'string', pattern: '^[a-z0-9_-]{1,32}$' },
        channel_instance: { type: 'string' },
        sender_id: { type: 'string', pattern: SENDER_ID_RE.source, description: 'Canonical sender id; never used to pick a member' },
        sender_username: { type: 'string' },
        chat_type: { type: 'string', enum: ['direct', 'group'] },
        chat_id: { type: 'string' },
        principal_id: { type: 'string', description: 'Dewee principal of the linked sender (version 2)' },
        external_subject: { type: 'string', maxLength: 255, description: 'zuey.me member id of the linked sender (version 2)' },
        authn_level: { type: 'string', enum: ['verified', 'channel'], description: '`channel` when a linked sender is checked from a group (version 2)' },
      },
    },
    ChannelAccessDecision: {
      type: 'object',
      required: ['decision', 'ttl_seconds'],
      properties: {
        decision: { type: 'string', enum: ['allow', 'deny'] },
        reply: { type: 'string', description: 'Suggested reply to the sender (Vietnamese + English)' },
        link_url: { type: 'string', description: 'Pricing page (deny for a member without an active plan)' },
        ttl_seconds: { type: 'integer' },
        subject_ref: { type: 'string', description: 'Opaque stable member reference (never an email or the member id)' },
      },
    },
    ChannelBinding: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        channel_type: { type: 'string' },
        sender_hint: { type: 'string', description: 'Last characters of the sender id' },
        linked_at: { type: ['string', 'null'], format: 'date-time' },
      },
    },
  },
};
