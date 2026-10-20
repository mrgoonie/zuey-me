import type { OpenApiFragment } from '../openapi/types';
import { PRESENCE_DEFAULT_ORIGIN, PRESENCE_TICKET_TTL_MS } from './contract';
import { PRESENCE_TICKET_RATE_LIMIT, PRESENCE_TICKET_RATE_WINDOW_MS } from './presence-rate-limit';

const TAG = 'Presence';
const json = (schema: Record<string, unknown>) => ({ 'application/json': { schema } });
const errorRef = json({ $ref: '#/components/schemas/Error' });

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
  },
  schemas: {},
};
