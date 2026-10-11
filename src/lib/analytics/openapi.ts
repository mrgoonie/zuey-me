import type { OpenApiFragment } from '../openapi/types';
import { adminSecurity, errorResponses } from '../openapi/types';
import { DEFAULT_DRAIN_LIMIT, MAX_DRAIN_LIMIT, MAX_DRAIN_QUERIES, OUTBOX_MAX_ATTEMPTS, OUTBOX_SENT_RETENTION_MS } from './outbox';

const OUTBOX_SENT_RETENTION_DAYS = OUTBOX_SENT_RETENTION_MS / (24 * 60 * 60 * 1000);

const TAG = 'Analytics';
const json = (schema: Record<string, unknown>) => ({ 'application/json': { schema } });
const int = { type: 'integer' };

export const analyticsOpenApi: OpenApiFragment = {
  tag: {
    name: TAG,
    description: [
      'Server analytics outbox. Purchases, subscription lifecycle, refunds, payment issues and sign-ins are queued in the same flow as the verified change',
      '(one row per provider transaction or event id) and delivered to PostHog by the scheduler. Event dictionary: docs/analytics-events.md.',
    ].join(' '),
  },
  paths: {
    '/api/v1/analytics/outbox/drain': {
      post: {
        tags: [TAG],
        summary: 'Cron (Bearer CRON_SECRET) or admin: deliver due analytics events and queue ended plans. Idempotent',
        description: [
          `Delivers due rows in batches within a ~20 s budget, retrying failures with exponential backoff (5 min doubling, capped at 6 h); a row is dead-lettered after ${OUTBOX_MAX_ATTEMPTS} attempts (about 22 h) or when the destination rejects the payload (400/413/422).`,
          'Delivery is at-least-once with an idempotent event uuid per row.',
          `A run issues at most ${MAX_DRAIN_QUERIES} D1 statements, queues \`subscription_expired\` for plans that ended, and deletes rows delivered more than ${OUTBOX_SENT_RETENTION_DAYS} days ago.`,
          'Delivery happens only on zuey.me / www.zuey.me (or with PUBLIC_ANALYTICS_DEBUG); on any other host, e.g. a *.pages.dev preview, the run is `skipped` and rows stay queued.',
        ].join(' '),
        security: adminSecurity,
        requestBody: {
          required: false,
          content: json({ type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: MAX_DRAIN_LIMIT, default: DEFAULT_DRAIN_LIMIT } } }),
        },
        responses: {
          '200': {
            description: 'Run summary',
            content: json({
              type: 'object',
              properties: {
                success: { type: 'boolean', enum: [true] },
                data: {
                  type: 'object',
                  properties: {
                    status: { type: 'string', enum: ['ok', 'skipped'] },
                    skipped_reason: { type: ['string', 'null'], enum: ['not_production_host', 'analytics_disabled', null] },
                    claimed: int, sent: int, retried: int, dead: int, expired_queued: int,
                    purged: { ...int, description: `Delivered rows deleted ${OUTBOX_SENT_RETENTION_DAYS} days after delivery` },
                    pending: { ...int, description: 'Rows still waiting for delivery after the run (pending or leased)' },
                    queries: { ...int, description: `D1 statements the run issued (at most ${MAX_DRAIN_QUERIES})` },
                    budget_exhausted: { type: 'boolean', description: 'The run stopped because its time or query budget was spent' },
                  },
                },
              },
            }),
          },
          '503': { description: '`database_unavailable`', content: json({ $ref: '#/components/schemas/Error' }) },
          ...errorResponses,
        },
      },
    },
  },
  schemas: {},
};
