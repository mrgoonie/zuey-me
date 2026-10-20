import type { OpenApiFragment } from '../openapi/types';

const TAG = '200lab';

export const lab200OpenApi: OpenApiFragment = {
  tag: {
    name: TAG,
    description: '200lab courses Duy recommends, mirrored from 200lab.io/courses.md into a D1 snapshot that refreshes in the background.',
  },
  paths: {
    '/api/v1/lab200': {
      get: {
        tags: [TAG],
        summary: 'Get the 200lab course snapshot',
        description: 'Public. Returns the last stored snapshot; a stale one is refreshed from 200lab after the response.',
        responses: {
          '200': {
            description: '200lab courses',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean' },
                    data: {
                      type: 'object',
                      properties: {
                        courses: { type: 'array', items: { $ref: '#/components/schemas/Lab200Course' } },
                        synced_at: { type: 'string', format: 'date-time', nullable: true, description: 'Last successful fetch of courses.md' },
                      },
                    },
                  },
                },
              },
            },
          },
          '500': { description: 'Snapshot unavailable', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
  },
  schemas: {
    Lab200Course: {
      type: 'object',
      required: ['slug', 'title', 'summary', 'status', 'free'],
      properties: {
        slug: { type: 'string' },
        title: { type: 'string' },
        summary: { type: 'string' },
        lessons: { type: 'integer', nullable: true },
        status: { type: 'string', description: 'Sale status as published by 200lab' },
        free: { type: 'boolean' },
        image: { type: 'string', format: 'uri', nullable: true },
      },
    },
  },
};
