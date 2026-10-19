import { adminSecurity, errorResponses } from '../openapi/types';
import type { OpenApiFragment } from '../openapi/types';

const TAG = 'Idempotency';

/** Optional header on admin article and media writes; add it to a write operation's `parameters`. */
export const idempotencyKeyParam = {
  name: 'Idempotency-Key',
  in: 'header',
  required: false,
  schema: { type: 'string', minLength: 8, maxLength: 128, pattern: '^[A-Za-z0-9._:-]{8,128}$' },
  description: 'Opaque client-generated key that makes retries safe. Repeating the same request with the same key returns the stored result (`idempotent_replay: true`, header `Idempotent-Replayed: true`) without a second write, revision, email or media object. 422 `idempotency_key_reused` when the key was used for a different request; 409 `idempotency_in_progress` while the first request still runs (retry after `retry_after_seconds`). A failed request releases the key. Results are kept 24 hours, private to the admin. Also accepted as `idempotency_key` in the JSON body (routes without a body take the header only).',
} as const;

const errorRef = { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } };

export const idempotencyOpenApi: OpenApiFragment = {
  tag: {
    name: TAG,
    description: 'Replay-safe retries for admin article and media writes. Send `Idempotency-Key` on POST/PUT/DELETE article routes and JSON media imports/uploads. MCP: `idempotency_key` argument on article_create, article_update, article_publish, article_delete, article_edition_delete, article_tags_set, media_import, media_upload, media_delete; result lookup with idempotency_lookup.',
  },
  paths: {
    '/api/v1/admin/idempotency/{key}': {
      get: {
        tags: [TAG],
        summary: 'Look up what a keyed request did (admin)',
        description: 'Returns the recorded outcome for 24 hours after the request, so a client that lost the response can recover it without writing again.',
        security: adminSecurity,
        parameters: [{ name: 'key', in: 'path', required: true, schema: { type: 'string' }, description: 'The idempotency key that was sent' }],
        responses: {
          '200': {
            description: 'Recorded outcome',
            content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { $ref: '#/components/schemas/IdempotencyRecord' } } } } },
          },
          '404': { description: 'Unknown or expired key', content: errorRef },
          ...errorResponses,
        },
      },
    },
  },
  schemas: {
    IdempotencyRecord: {
      type: 'object',
      properties: {
        operation: { type: 'string', description: 'Tool or route name, e.g. article_update' },
        state: { type: 'string', enum: ['in_progress', 'done'] },
        status_code: { type: ['integer', 'null'] },
        started_at: { type: 'string', format: 'date-time' },
        completed_at: { type: ['string', 'null'], format: 'date-time' },
        expires_at: { type: 'string', format: 'date-time' },
        result: { type: ['object', 'null'], description: 'The stored response body of the original request' },
      },
    },
  },
};
