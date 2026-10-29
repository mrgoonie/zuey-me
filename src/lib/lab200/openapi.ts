import type { OpenApiFragment } from '../openapi/types';

const TAG = '200lab';

const nullableDate = (description: string) => ({ type: 'string', format: 'date-time', nullable: true, description });

const itemProperties = {
  slug: { type: 'string', pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$' },
  url: { type: 'string', format: 'uri', description: 'Canonical https://200lab.io page (validated). Links on zuey.me add ref=T2CWW3D7 once.' },
  jsonUrl: { type: 'string', format: 'uri', description: 'Canonical detail JSON on https://200lab.io (validated, not fetched by zuey.me)' },
  title: { type: 'string' },
  subtitle: { type: 'string' },
  summary: { type: 'string' },
  cover: { allOf: [{ $ref: '#/components/schemas/Lab200Cover' }], nullable: true },
  publishedAt: nullableDate('First publication on 200lab'),
  pricing: { $ref: '#/components/schemas/Lab200Pricing' },
};

export const lab200OpenApi: OpenApiFragment = {
  tag: {
    name: TAG,
    description:
      "200lab courses and learning paths Duy recommends, mirrored from 200lab's versioned catalog feeds (https://200lab.io/courses.json and /learning-paths.json) into independent D1 snapshots that refresh in the background.",
  },
  paths: {
    '/api/v1/lab200': {
      get: {
        tags: [TAG],
        summary: 'Get the 200lab course and learning-path catalogs',
        description:
          'Public. Returns the last valid copy of each feed; a stale feed is refreshed from 200lab after the response, and a failed refresh keeps the previous copy. Prices are 200lab\'s own (integer minor units); no referral discount is applied.',
        responses: {
          '200': {
            description: '200lab catalogs',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['success', 'data'],
                  properties: {
                    success: { type: 'boolean' },
                    data: {
                      type: 'object',
                      required: ['courses', 'synced_at', 'courses_locale', 'learning_paths', 'learning_paths_synced_at', 'learning_paths_locale'],
                      properties: {
                        courses: { type: 'array', items: { $ref: '#/components/schemas/Lab200Course' } },
                        synced_at: nullableDate('Last valid fetch of courses.json'),
                        courses_locale: { type: 'string', nullable: true, description: 'Locale reported by courses.json, e.g. "vi"' },
                        learning_paths: { type: 'array', items: { $ref: '#/components/schemas/Lab200LearningPath' } },
                        learning_paths_synced_at: nullableDate('Last valid fetch of learning-paths.json'),
                        learning_paths_locale: { type: 'string', nullable: true, description: 'Locale reported by learning-paths.json' },
                      },
                    },
                  },
                },
              },
            },
          },
          '500': { description: 'Catalog unavailable', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
  },
  schemas: {
    Lab200Cover: {
      type: 'object',
      required: ['url', 'variants'],
      properties: {
        url: { type: 'string', format: 'uri', description: 'https://assets.200lab.io only' },
        variants: {
          type: 'array',
          items: { type: 'object', required: ['width', 'url'], properties: { width: { type: 'integer' }, url: { type: 'string', format: 'uri' } } },
        },
      },
    },
    Lab200Pricing: {
      type: 'object',
      required: ['state', 'prices'],
      properties: {
        state: { type: 'string', enum: ['available', 'unavailable'], description: 'Any state other than available is reported as unavailable' },
        prices: {
          type: 'array',
          items: {
            type: 'object',
            required: ['minorUnits', 'currency', 'compareAtMinorUnits'],
            properties: {
              minorUnits: { type: 'integer', minimum: 0, description: 'Selling price in minor units (VND: whole dong)' },
              currency: { type: 'string', enum: ['VND'] },
              compareAtMinorUnits: { type: 'integer', nullable: true, description: "200lab's comparison (strikethrough) price, not a referral price" },
            },
          },
        },
      },
    },
    Lab200Course: {
      type: 'object',
      required: ['slug', 'url', 'jsonUrl', 'title', 'subtitle', 'summary', 'cover', 'publishedAt', 'pricing', 'category', 'lessonCount', 'readingMinutes'],
      properties: {
        ...itemProperties,
        category: {
          type: 'object', nullable: true, required: ['slug', 'name'],
          properties: { slug: { type: 'string' }, name: { type: 'string' } },
        },
        lessonCount: { type: 'integer', nullable: true },
        readingMinutes: { type: 'integer', nullable: true },
      },
    },
    Lab200LearningPath: {
      type: 'object',
      required: ['slug', 'url', 'jsonUrl', 'title', 'subtitle', 'summary', 'cover', 'publishedAt', 'pricing', 'courseCount'],
      properties: {
        ...itemProperties,
        courseCount: { type: 'integer', nullable: true, description: 'Courses in the path' },
      },
    },
  },
};
