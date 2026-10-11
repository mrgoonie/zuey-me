import type { OpenApiFragment } from '../openapi/types';
import { adminSecurity, errorResponses } from '../openapi/types';
import { MAX_UNLINK_REASON_LENGTH } from './admin';
import { ALLOW_TTL_SECONDS, CHANNEL_ACCESS_SCOPE, DENY_TTL_SECONDS } from './check';
import { SENDER_ID_RE, SUPPORTED_CHANNEL_TYPES } from './link-token';

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
const adminAuth = [...adminSecurity, { MemberSession: [] }];
const channelType = { type: 'string', enum: [...SUPPORTED_CHANNEL_TYPES] };
const identityParams = [
  { name: 'provider', in: 'path', required: true, schema: channelType },
  { name: 'external_id', in: 'path', required: true, schema: { type: 'string', pattern: SENDER_ID_RE.source }, description: 'Platform sender id (Telegram numeric user id); percent-encoding such as `%3A` for `:` is decoded once, malformed encoding is a 400 `invalid_field`' },
];

export const channelAccessOpenApi: OpenApiFragment = {
  tag: {
    name: TAG,
    description: [
      'zuey.me is the external entitlement verifier of the dewee Channel Access Gate: only members whose plans grant `agent_chat`',
      '(Zuey AI, Kết hợp, Cộng đồng) may chat with the Zuey AI agent on Telegram. The verifier is also the MCP tool `channel_access_check` on `/api/mcp`.',
      `It accepts only the dedicated service key (scope \`${CHANNEL_ACCESS_SCOPE}\`, env CHANNEL_ACCESS_SERVICE_KEY) as Bearer; admin and personal keys are rejected.`,
      'Members link a chat account at `/connect?token=…` with a token signed by dewee:',
      '`base64url(JSON payload) + "." + base64url(HMAC-SHA256(CHANNEL_LINK_TOKEN_SECRET, payloadPart))`,',
      'payload `{v:1, channel_type, channel_instance, sender_id, sender_username?, tenant?, exp, nonce}`; each token links once.',
    ].join(' '),
  },
  paths: {
    '/api/v1/channel-access/check': {
      post: {
        tags: [TAG],
        summary: `Service: decide whether a chat sender may talk to the agent (scope ${CHANNEL_ACCESS_SCOPE})`,
        description: `allow (ttl ${ALLOW_TTL_SECONDS}s) for a linked member with agent_chat (card renewals keep a 24-hour grace), deny + pricing link_url (ttl ${DENY_TTL_SECONDS}s) when linked without an active plan, link_required when the sender is not linked (link_url = /connect?token=… when link_token is given in a direct chat; group chats get a reply asking the sender to message the bot directly, with no link). Send Content-Type: application/json.`,
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
    '/api/v1/channel-access/link': {
      post: {
        tags: [TAG],
        summary: 'Link the chat account named by a dewee link token to your account (browser session)',
        description: 'Scripted linking with the token in the JSON body. The /connect page itself posts to POST /connect/link, which reads the token from its HttpOnly cookie so the page never sees it. A chat account already linked to another member is refused; the same member gets an idempotent success. Replayed, tampered or expired tokens are rejected.',
        security: sessionAuth,
        requestBody: { required: true, content: json({ type: 'object', required: ['token'], properties: { token: { type: 'string' } } }) },
        responses: {
          '200': ok('Linked', {
            type: 'object',
            properties: {
              provider: channelType, external_id: { type: 'string' }, sender_username: { type: ['string', 'null'] },
              already_linked: { type: 'boolean' }, entitled: { type: 'boolean', description: 'Your plans currently allow chatting with the agent' },
            },
          }),
          '400': err('`invalid_link_token`, `link_token_expired` or `unsupported_channel`'),
          '401': errorResponses['401'],
          '403': err('`session_required` or `csrf_rejected`'),
          '409': err('`channel_linked_elsewhere` or `link_token_used`'),
          '503': err('`channel_link_unconfigured` or `database_unavailable`'),
        },
      },
    },
    '/api/v1/me/channels': {
      get: {
        tags: [TAG], summary: 'Your linked chat accounts (account:read)', security: [{ MemberSession: [] }, { BearerAuth: [] }],
        responses: { '200': ok('Linked chat accounts', { type: 'array', items: ref('ChannelIdentity') }), '401': errorResponses['401'], '403': errorResponses['403'] },
      },
    },
    '/api/v1/me/channels/{provider}/{external_id}': {
      delete: {
        tags: [TAG], summary: 'Unlink one of your chat accounts (browser session); the agent stops answering it', security: sessionAuth,
        parameters: [
          { name: 'provider', in: 'path', required: true, schema: channelType },
          { name: 'external_id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { '200': ok('Unlinked', { type: 'object', properties: { unlinked: { type: 'boolean' } } }), '401': errorResponses['401'], '403': errorResponses['403'], '404': err('`not_found`') },
      },
    },
    '/api/v1/admin/channel-identities/{provider}/{external_id}': {
      get: {
        tags: [TAG], summary: 'Admin: which member holds a linked chat account (MCP channel_identity_get)', security: adminAuth, parameters: identityParams,
        responses: {
          '200': ok('Linked chat account and its member', ref('AdminChannelIdentity')),
          '400': err('`unsupported_channel` or `invalid_field`'), '401': errorResponses['401'], '403': errorResponses['403'],
          '404': err('`not_found` (the sender id is not linked)'), '503': err('`database_unavailable`'),
        },
      },
      delete: {
        tags: [TAG], summary: 'Admin: unlink a chat account from whichever member holds it (MCP channel_identity_unlink)', security: adminAuth, parameters: identityParams,
        description: [
          'Recovery for a chat account linked to the wrong member (mistaken community backfill, a link made on someone else\'s device, a support request',
          'from the real owner): the sender id is freed so its owner can link it at /connect. The affected member\'s activity log gets `channel.unlinked`',
          'with only `by: "admin"`; the admin and the optional reason go to the admin-only `admin_access_audit` log (action `channel.unlink`).',
          'dewee is told to drop its cached gate decision for that sender. Read-only keys are refused.',
          'The JSON body is optional; scripted calls must still send `Content-Type: application/json` (the origin check rejects body-less unsafe requests).',
        ].join(' '),
        requestBody: {
          required: false,
          content: json({ type: 'object', properties: { reason: { type: 'string', maxLength: MAX_UNLINK_REASON_LENGTH, description: 'Written to the admin-only audit log; never shown to the member' } } }),
        },
        responses: {
          '200': ok('Unlinked', { type: 'object', properties: { unlinked: { type: 'boolean', enum: [true] }, identity: ref('AdminChannelIdentity') } }),
          '400': err('`unsupported_channel`, `invalid_field` or `invalid_json`'), '401': errorResponses['401'], '403': errorResponses['403'],
          '404': err('`not_found` (the sender id is not linked)'), '503': err('`database_unavailable`'),
        },
      },
    },
  },
  schemas: {
    ChannelAccessCheckInput: {
      type: 'object',
      required: ['version', 'channel_type', 'sender_id', 'chat_type'],
      properties: {
        version: { type: 'integer', enum: [1] },
        tenant: { type: 'string' },
        agent_key: { type: 'string' },
        channel_type: channelType,
        channel_instance: { type: 'string' },
        sender_id: { type: 'string' },
        sender_username: { type: 'string' },
        chat_type: { type: 'string', enum: ['direct', 'group'] },
        chat_id: { type: 'string' },
        link_token: { type: 'string' },
      },
    },
    ChannelAccessDecision: {
      type: 'object',
      required: ['decision', 'ttl_seconds'],
      properties: {
        decision: { type: 'string', enum: ['allow', 'deny', 'link_required'] },
        reply: { type: 'string', description: 'Suggested reply to the sender (Vietnamese + English)' },
        link_url: { type: 'string', description: 'Pricing page (deny) or /connect link (link_required, direct chats only)' },
        ttl_seconds: { type: 'integer' },
        subject_ref: { type: 'string', description: 'Opaque stable member reference (never an email)' },
      },
    },
    ChannelIdentity: {
      type: 'object',
      properties: {
        provider: channelType,
        external_id: { type: 'string' },
        linked_at: { type: 'string', format: 'date-time' },
        source: { type: 'string', enum: ['link_token', 'community_backfill'] },
      },
    },
    AdminChannelIdentity: {
      type: 'object',
      properties: {
        provider: channelType,
        external_id: { type: 'string' },
        user_id: { type: 'string' },
        linked_at: { type: 'string', format: 'date-time' },
        source: { type: 'string', enum: ['link_token', 'community_backfill'] },
        member: {
          type: ['object', 'null'],
          properties: { id: { type: 'string' }, email: { type: 'string' }, name: { type: ['string', 'null'] } },
        },
      },
    },
  },
};
