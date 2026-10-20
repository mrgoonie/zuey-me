import type { OpenApiFragment } from '../openapi/types';
import { OWNER_MODES, OWNER_STATUS_TEXT_MAX, PRESENCE_DEFAULT_ORIGIN, PRESENCE_TICKET_TTL_MS } from './contract';
import { PRESENCE_TICKET_RATE_LIMIT, PRESENCE_TICKET_RATE_WINDOW_MS } from './presence-rate-limit';

const TAG = 'Presence';
const json = (schema: Record<string, unknown>) => ({ 'application/json': { schema } });
const errorRef = json({ $ref: '#/components/schemas/Error' });
const ownerSecurity = [{ MemberSession: [] }, { BearerAuth: [] }];
const ownerState = {
  description: 'Owner presence state (Cache-Control: no-store)',
  content: json({
    type: 'object',
    properties: { success: { type: 'boolean', enum: [true] }, data: { $ref: '#/components/schemas/PresenceOwnerStatus' } },
  }),
};
const ownerDenied = {
  '401': { description: '`unauthorized` (no credential) or an invalid, expired or revoked key or token', content: errorRef },
  '403': {
    description: '`not_owner` (signed in but not listed in PRESENCE_OWNER_MEMBER_IDS; the admin role alone is refused), `csrf_rejected`, or `insufficient_scope`',
    content: errorRef,
  },
  '503': { description: '`presence_unavailable`: the presence Worker is unreachable, answered badly, or presence is not configured', content: errorRef },
};
const OWNER_AUTH = [
  'Owner only: a member session, personal `zk_` key or OAuth token whose member id is listed in PRESENCE_OWNER_MEMBER_IDS.',
  'Studio sessions, Studio admin/read keys and admins who are not listed get 403 `not_owner`.',
].join(' ');

export const presenceOpenApi: OpenApiFragment = {
  tag: {
    name: TAG,
    description: [
      'Realtime presence (live visitor counts). The browser asks for a short-lived signed ticket here, then connects to the',
      `presence Worker (${PRESENCE_DEFAULT_ORIGIN}). Presence is ephemeral and aggregate-only; see docs/analytics-events.md "Realtime presence".`,
    ].join(' '),
  },
  paths: {
    '/api/v1/presence/ticket': {
      post: {
        tags: [TAG],
        summary: 'Browser only: signed WebSocket connect ticket for the presence Worker',
        description: [
          'Called by the site-wide presence beacon while analytics consent is granted. Authentication is optional and comes only from the',
          'member session cookie (same origin); API keys and bearer tokens are ignored. Member and owner status are decided by the server',
          '(owner = member id listed in PRESENCE_OWNER_MEMBER_IDS, never the admin role) and the dedupe key is an HMAC, never a raw id.',
          '`count: true` asks to be counted: a guest must send its random `browserId`; `count: false` is a watch-only connection that never counts.',
          `Tickets expire after ${PRESENCE_TICKET_TTL_MS / 1000} s and may be reused for reconnects until shortly before then.`,
          `Rate limited to about ${PRESENCE_TICKET_RATE_LIMIT} tickets per ${PRESENCE_TICKET_RATE_WINDOW_MS / 60_000} minutes per client IP, IPv6 counted per /64 (per edge isolate).`,
        ].join(' '),
        security: [],
        requestBody: {
          required: true,
          content: json({
            type: 'object',
            required: ['count'],
            properties: {
              count: { type: 'boolean', description: 'True only when the visitor’s analytics consent allows counting' },
              browserId: {
                type: 'string', pattern: '^[A-Za-z0-9_-]{16,64}$',
                description: 'Random per-browser presence id (localStorage `zuey_presence_id`). Required for guests when `count` is true; ignored otherwise',
              },
            },
          }),
        },
        responses: {
          '200': {
            description: 'Ticket issued (Cache-Control: no-store)',
            content: json({
              type: 'object',
              properties: {
                success: { type: 'boolean', enum: [true] },
                data: {
                  type: 'object',
                  required: ['ticket', 'url', 'expiresAt'],
                  properties: {
                    ticket: { type: 'string', description: 'Opaque signed ticket (base64url token chars and `.`); offer it as the second WebSocket subprotocol, after `zuey-presence.v1`, e.g. `new WebSocket(url, [\'zuey-presence.v1\', ticket])`. Never put it in the URL' },
                    url: { type: 'string', format: 'uri', example: 'wss://presence.zuey.me/v1/connect' },
                    expiresAt: { type: 'string', format: 'date-time' },
                  },
                },
              },
            }),
          },
          '400': { description: '`invalid_json`, `invalid_request` (count not boolean) or `invalid_browser_id`', content: errorRef },
          '403': { description: 'Cross-site request rejected by the origin check', content: errorRef },
          '429': { description: '`rate_limited`; `error.retry_after` and the Retry-After header give the seconds to wait', content: errorRef },
          '503': { description: '`presence_unavailable`: PRESENCE_TICKET_SECRET is not set or PUBLIC_PRESENCE_URL is invalid', content: errorRef },
        },
      },
    },
    '/api/v1/presence/owner': {
      get: {
        tags: [TAG],
        summary: 'Owner: read the presence setting and the public status (account:read)',
        description: `${OWNER_AUTH} Scope-limited credentials need \`account:read\`.`,
        security: ownerSecurity,
        responses: { '200': ownerState, ...ownerDenied },
      },
      put: {
        tags: [TAG],
        summary: 'Owner: set the presence mode and optional status text (account:write)',
        description: [
          OWNER_AUTH,
          'Scope-limited credentials need `account:write`; read-only keys can never change it.',
          '`auto` shows online while the owner has a live zuey.me connection, else offline; `away` and `busy` are shown as set;',
          '`offline` and `invisible` both show offline publicly (nothing public tells them apart). Send `Content-Type: application/json`.',
        ].join(' '),
        security: ownerSecurity,
        requestBody: {
          required: true,
          content: json({
            type: 'object',
            required: ['mode'],
            properties: {
              mode: { type: 'string', enum: [...OWNER_MODES] },
              text: {
                type: ['string', 'null'], maxLength: OWNER_STATUS_TEXT_MAX,
                description: 'Optional public status text. Line breaks and tabs become spaces, other control characters and bidi override marks are dropped, then trimmed; the limit counts UTF-16 units; omitted, null or empty clears it. Longer text is rejected (400 `text_too_long`)',
              },
            },
          }),
        },
        responses: {
          '200': ownerState,
          '400': { description: '`invalid_json`, `invalid_mode`, `invalid_text` or `text_too_long`', content: errorRef },
          ...ownerDenied,
        },
      },
    },
  },
  schemas: {
    PresenceOwnerStatus: {
      type: 'object',
      required: ['mode', 'text', 'updatedAt', 'connected', 'public'],
      properties: {
        mode: { type: 'string', enum: [...OWNER_MODES], description: 'Manual setting' },
        text: { type: ['string', 'null'], maxLength: OWNER_STATUS_TEXT_MAX },
        updatedAt: { type: 'string', format: 'date-time', description: 'When the manual setting last changed' },
        connected: { type: 'boolean', description: 'True while the owner has a live, counted zuey.me connection' },
        public: {
          type: 'object',
          description: 'Exactly what visitors see in the presence snapshot',
          required: ['status', 'onSite', 'since'],
          properties: {
            status: { type: 'string', enum: ['online', 'away', 'busy', 'offline'] },
            onSite: { type: 'boolean' },
            text: { type: 'string', description: 'Present only when set and the owner is not offline/invisible' },
            since: { type: 'string', format: 'date-time' },
          },
        },
      },
    },
  },
};
