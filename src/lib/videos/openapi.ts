import { adminSecurity, errorResponses } from '../openapi/types';
import type { OpenApiFragment } from '../openapi/types';

const TAG = 'Zueytube';

const errorRef = { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } };
const envelope = (data: unknown) => ({
  'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data } } },
});
const idParam = {
  name: 'id', in: 'path', required: true, schema: { type: 'string' },
  description: 'Video id (`vid_…`) or the YouTube id of one edition. Edition-level edits/deletes need the YouTube id.',
};

export const videosOpenApi: OpenApiFragment = {
  tag: {
    name: TAG,
    description: 'Curated videos from youtube.com/@imzuey, grouped by language edition (VI/EN). Transcripts are fetched once via AnyMD and stored; related articles are computed automatically from content.',
  },
  paths: {
    '/api/v1/videos': {
      get: {
        tags: [TAG],
        summary: 'List or search videos',
        parameters: [
          { name: 'q', in: 'query', schema: { type: 'string' }, description: 'Search titles, descriptions and transcripts (returns `results` instead of `items`)' },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200, default: 100 } },
          { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0, default: 0 } },
        ],
        responses: {
          '200': {
            description: 'Curated list (featured, then manual position) or search hits',
            content: envelope({
              type: 'object',
              properties: {
                items: { type: 'array', items: { $ref: '#/components/schemas/Video' } },
                total: { type: 'integer' },
                query: { type: 'string' },
                results: { type: 'array', items: { $ref: '#/components/schemas/VideoHit' } },
              },
            }),
          },
          '503': { description: 'DB binding not configured', content: errorRef },
        },
      },
      post: {
        tags: [TAG],
        summary: 'Add a YouTube video (admin)',
        description: 'Stores the video and fetches its transcript once via AnyMD. A missing/failed transcript does not fail the request: check `transcript_status`. Use `pair_with` to add the other-language upload of an existing video.',
        security: adminSecurity,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['url'],
                properties: {
                  url: { type: 'string', description: 'YouTube link or 11-character id' },
                  locale: { type: 'string', enum: ['vi', 'en'], default: 'vi' },
                  pair_with: { type: 'string', description: 'Existing video id or YouTube id/link' },
                  title: { type: 'string', description: 'Optional title override' },
                },
              },
            },
          },
        },
        responses: {
          '201': { description: 'Video stored', content: envelope({ $ref: '#/components/schemas/VideoIngestResult' }) },
          '400': errorResponses['400'],
          '401': errorResponses['401'],
          '403': errorResponses['403'],
          '404': { description: 'pair_with target not found', content: errorRef },
          '409': { description: 'Video already added, or the target already has this language', content: errorRef },
        },
      },
    },
    '/api/v1/videos/{id}': {
      get: {
        tags: [TAG],
        summary: 'Get a video with transcripts and related articles',
        parameters: [idParam],
        responses: {
          '200': {
            description: 'Video detail',
            content: envelope({
              type: 'object',
              properties: {
                video: { $ref: '#/components/schemas/Video' },
                related_articles: { type: 'array', items: { $ref: '#/components/schemas/RelatedArticle' } },
              },
            }),
          },
          '404': { description: 'Not found', content: errorRef },
        },
      },
      patch: {
        tags: [TAG],
        summary: 'Update a video or edition (admin)',
        security: adminSecurity,
        parameters: [idParam],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  position: { type: 'number' },
                  featured: { type: 'boolean' },
                  title: { type: 'string', description: 'Edition only' },
                  description: { type: 'string', description: 'Edition only' },
                  locale: { type: 'string', enum: ['vi', 'en'], description: 'Edition only' },
                  pair_with: { type: 'string', description: 'Edition only: move under another video' },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Updated video', content: envelope({ $ref: '#/components/schemas/Video' }) },
          '400': errorResponses['400'],
          '401': errorResponses['401'],
          '403': errorResponses['403'],
          '404': { description: 'Not found', content: errorRef },
          '409': { description: 'Language edition already exists', content: errorRef },
        },
      },
      delete: {
        tags: [TAG],
        summary: 'Delete a video or one edition (admin)',
        security: adminSecurity,
        parameters: [idParam],
        responses: {
          '200': {
            description: 'Deleted',
            content: envelope({ type: 'object', properties: { deleted: { type: 'string', enum: ['video', 'edition'] }, id: { type: 'string' } } }),
          },
          '401': errorResponses['401'],
          '403': errorResponses['403'],
          '404': { description: 'Not found', content: errorRef },
        },
      },
    },
    '/api/v1/videos/{id}/refetch': {
      post: {
        tags: [TAG],
        summary: 'Fetch an edition transcript again (admin)',
        security: adminSecurity,
        parameters: [{ ...idParam, description: 'YouTube id of the edition' }],
        responses: {
          '200': { description: 'Refetch outcome', content: envelope({ $ref: '#/components/schemas/VideoIngestResult' }) },
          '401': errorResponses['401'],
          '403': errorResponses['403'],
          '404': { description: 'Not found', content: errorRef },
        },
      },
    },
    '/api/v1/videos/{id}/rewrite': {
      post: {
        tags: [TAG],
        summary: 'Rewrite an edition transcript with AI (admin)',
        description: 'Cleans up the stored raw captions with Workers AI (punctuation, paragraphs, filler words; same language, no summary) without calling AnyMD. Paragraph timestamps are estimates. A failed rewrite keeps the current text and reports `transcript_rewrite_status: failed`.',
        security: adminSecurity,
        parameters: [{ ...idParam, description: 'YouTube id of the edition' }],
        responses: {
          '200': { description: 'Rewrite outcome', content: envelope({ $ref: '#/components/schemas/VideoIngestResult' }) },
          '401': errorResponses['401'],
          '403': errorResponses['403'],
          '404': { description: 'Not found', content: errorRef },
          '409': { description: 'The edition has no transcript yet', content: errorRef },
          '503': { description: 'Workers AI binding not configured', content: errorRef },
        },
      },
    },
    '/videos.md': {
      get: {
        tags: [TAG],
        summary: 'Videos as Markdown',
        responses: { '200': { description: 'Markdown list of curated videos', content: { 'text/markdown': { schema: { type: 'string' } } } } },
      },
    },
  },
  schemas: {
    VideoEdition: {
      type: 'object',
      properties: {
        youtube_id: { type: 'string' },
        video_id: { type: 'string' },
        locale: { type: 'string', enum: ['vi', 'en'] },
        title: { type: 'string' },
        description: { type: 'string' },
        author: { type: 'string' },
        thumbnail_url: { type: 'string', nullable: true },
        duration_seconds: { type: 'integer', nullable: true },
        published_at: { type: 'string', nullable: true },
        transcript_status: { type: 'string', enum: ['pending', 'ready', 'unavailable', 'failed'] },
        transcript_error: { type: 'string', nullable: true },
        transcript_rewrite_status: { type: 'string', enum: ['none', 'ready', 'failed'], description: '`ready`: the transcript is AI-cleaned and its timestamps are estimates' },
        transcript_rewrite_error: { type: 'string', nullable: true },
        transcript_rewritten_at: { type: 'string', nullable: true },
        transcript_fetched_at: { type: 'string', nullable: true },
        word_count: { type: 'integer' },
        watch_url: { type: 'string', format: 'uri' },
        embed_url: { type: 'string', format: 'uri' },
        transcript: { type: 'string', nullable: true, description: 'Detail reads only: one "m:ss text" line per segment' },
      },
    },
    Video: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        position: { type: 'integer' },
        featured: { type: 'boolean' },
        created_at: { type: 'string' },
        updated_at: { type: 'string' },
        editions: { type: 'array', items: { $ref: '#/components/schemas/VideoEdition' } },
      },
    },
    VideoHit: {
      type: 'object',
      properties: {
        video_id: { type: 'string' },
        youtube_id: { type: 'string' },
        locale: { type: 'string', enum: ['vi', 'en'] },
        title: { type: 'string' },
        snippet: { type: 'string', description: 'Matched text; ** marks matched terms' },
        thumbnail_url: { type: 'string', nullable: true },
        duration_seconds: { type: 'integer', nullable: true },
        published_at: { type: 'string', nullable: true },
        url: { type: 'string', format: 'uri' },
        watch_url: { type: 'string', format: 'uri' },
        score: { type: 'number' },
      },
    },
    RelatedArticle: {
      type: 'object',
      properties: {
        article_id: { type: 'string' },
        slug: { type: 'string' },
        locale: { type: 'string' },
        title: { type: 'string' },
        excerpt: { type: 'string' },
        access: { type: 'string', enum: ['free', 'knowledges'] },
        url: { type: 'string', format: 'uri' },
      },
    },
    VideoIngestResult: {
      type: 'object',
      properties: {
        video: { $ref: '#/components/schemas/Video' },
        youtube_id: { type: 'string' },
        transcript_status: { type: 'string', enum: ['ready', 'unavailable', 'failed'] },
        transcript_error: { type: 'string', nullable: true },
        transcript_rewrite_status: { type: 'string', enum: ['none', 'ready', 'failed'], description: '`ready`: the transcript is AI-cleaned and its timestamps are estimates' },
        transcript_rewrite_error: { type: 'string', nullable: true },
      },
    },
  },
};
