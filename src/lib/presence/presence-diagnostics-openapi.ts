/** OpenAPI path and schema of the admin presence diagnostics endpoint, merged into the Presence fragment. */
import { adminSecurity } from '../openapi/types';

const json = (schema: Record<string, unknown>) => ({ 'application/json': { schema } });
const errorRef = json({ $ref: '#/components/schemas/Error' });
const count = { type: 'integer', minimum: 0 };
const time = { type: 'string', format: 'date-time' };
const timeOrNull = { type: ['string', 'null'], format: 'date-time' };
const object = (properties: Record<string, unknown>, description?: string) => ({
  type: 'object', required: Object.keys(properties), properties, ...(description ? { description } : {}),
});

export const presenceDiagnosticsPath = {
  get: {
    tags: ['Presence'],
    summary: 'Admin: presence Worker diagnostics (read-only)',
    description: [
      'Socket breakdown, connection limits, counters since the Durable Object last started, alarm timing and history storage of the',
      'presence Worker, read over the `PRESENCE` service binding. Counts and timings only: never keys, IPs, tickets or owner text.',
      'Any admin (Studio session, admin member session or admin key) and read-only Studio keys may read it; it is not owner-only.',
      'Responses are `Cache-Control: no-store`.',
    ].join(' '),
    security: [{ MemberSession: [] }, ...adminSecurity],
    responses: {
      '200': {
        description: 'Current diagnostics',
        content: json({
          type: 'object',
          properties: { success: { type: 'boolean', enum: [true] }, data: { $ref: '#/components/schemas/PresenceDiagnostics' } },
        }),
      },
      '401': { description: '`unauthorized` (no credential) or an invalid, expired or revoked key', content: errorRef },
      '403': { description: '`forbidden` (signed in, but not an admin), `member_account_required` or `csrf_rejected`', content: errorRef },
      '503': { description: '`presence_unavailable`: the presence Worker is unreachable, answered badly, or presence is not configured', content: errorRef },
    },
  },
};

export const presenceDiagnosticsSchema = {
  ...object({
    v: { type: 'integer', enum: [1] },
    at: time,
    sockets: object({
      total: count,
      activeSessions: { ...count, description: 'Counted visitor sessions (unique keys), same number as the snapshot `active`' },
      idle: { ...count, description: 'Counted sockets that are idle or hidden' },
      watchOnly: count,
      subscribers: count,
      owner: count,
    }),
    limits: object({ maxTotal: count, maxPerIp: count, maxPerKey: count }),
    counters: object({
      startedAt: time,
      connectsAccepted: count,
      connectsRejected: count,
      messagesDropped: count,
      abuseCloses: count,
      broadcasts: count,
    }, 'In memory since the Durable Object last started; resets on eviction'),
    alarm: object({ nextAt: timeOrNull, lastRunAt: timeOrNull, lastRunMs: { type: ['number', 'null'], minimum: 0 } }),
    history: object({ buckets: count, oldest: timeOrNull, storageBytes: count }, 'Stored 5-minute aggregate buckets'),
  }),
};
