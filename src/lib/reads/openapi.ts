import { adminSecurity, errorResponses } from '../openapi/types';
import type { OpenApiFragment } from '../openapi/types';

const TAG = 'Zuey Reads';

const errorRef = { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } };

export const readsOpenApi: OpenApiFragment = {
  tag: {
    name: TAG,
    description: 'Curated reading list synced from the AnyMD library (tag `zuey-reads`) with AI-generated summaries. Summaries may be inaccurate; every item links to the original.',
  },
  paths: {
    '/api/v1/reads': {
      get: {
        tags: [TAG],
        summary: 'List visible reads',
        parameters: [
          { name: 'q', in: 'query', schema: { type: 'string' }, description: 'Search in title, summary, site and domain' },
          { name: 'source', in: 'query', schema: { type: 'string' }, description: 'Filter by source_kind' },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 500, default: 50 } },
          { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0, default: 0 } },
          { name: 'include_hidden', in: 'query', schema: { type: 'integer', enum: [0, 1] }, description: 'Admin only: include reads hidden after the zuey-reads tag was removed' },
        ],
        responses: {
          '200': {
            description: 'Reads list',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean' },
                    data: {
                      type: 'object',
                      properties: {
                        items: { type: 'array', items: { $ref: '#/components/schemas/ReadItem' } },
                        total: { type: 'integer' },
                        sources: {
                          type: 'array',
                          items: { type: 'object', properties: { source_kind: { type: 'string' }, count: { type: 'integer' } } },
                        },
                        last_synced_at: { type: 'string', format: 'date-time', nullable: true },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/api/v1/reads/sync': {
      post: {
        tags: [TAG],
        summary: 'Sync reads from AnyMD (admin)',
        description: 'Crawls the AnyMD library, keeps items tagged `zuey-reads`, summarizes new/changed content with Workers AI and hides items that lost the tag.',
        security: adminSecurity,
        responses: {
          '200': {
            description: 'Sync run stats',
            content: {
              'application/json': {
                schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { $ref: '#/components/schemas/ReadsSyncRun' } } },
              },
            },
          },
          '401': errorResponses['401'],
          '403': errorResponses['403'],
          '502': { description: 'AnyMD or Workers AI upstream error', content: errorRef },
          '503': { description: 'ANYMD_API_KEY, AI or DB binding not configured', content: errorRef },
        },
      },
    },
    '/reads.md': {
      get: {
        tags: [TAG],
        summary: 'Reads as Markdown',
        responses: { '200': { description: 'Markdown list of reads', content: { 'text/markdown': { schema: { type: 'string' } } } } },
      },
    },
  },
  schemas: {
    ReadItem: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        url: { type: 'string', format: 'uri' },
        title: { type: 'string' },
        author: { type: 'string', nullable: true },
        description: { type: 'string', nullable: true },
        domain: { type: 'string', nullable: true },
        site: { type: 'string', nullable: true },
        image: { type: 'string', nullable: true },
        source_kind: { type: 'string', nullable: true },
        language: { type: 'string', nullable: true },
        published: { type: 'string', nullable: true },
        tags: { type: 'string', description: 'Space-separated AnyMD tags' },
        word_count: { type: 'integer', nullable: true },
        content_hash: { type: 'string', nullable: true },
        summary: { type: 'string', nullable: true, description: 'AI-generated summary (may be inaccurate)' },
        visible: { type: 'boolean' },
        anymd_updated_at: { type: 'integer', nullable: true },
        synced_at: { type: 'string', nullable: true },
        created_at: { type: 'string' },
      },
    },
    ReadsSyncRun: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        started_at: { type: 'string', format: 'date-time' },
        finished_at: { type: 'string', format: 'date-time', nullable: true },
        status: { type: 'string', enum: ['running', 'success', 'partial', 'failed'] },
        fetched: { type: 'integer' },
        tagged: { type: 'integer' },
        summarized: { type: 'integer' },
        unchanged: { type: 'integer' },
        hidden: { type: 'integer' },
        error: { type: 'string', nullable: true },
      },
    },
  },
};
