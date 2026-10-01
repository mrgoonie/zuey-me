import type { OpenApiFragment } from '../openapi/types';
import { adminSecurity, errorResponses } from '../openapi/types';
import {
  BLOCK_TYPES, CALLOUT_TONES, CHART_KINDS, EMBED_PROVIDERS, LAYOUT_GAPS, LAYOUT_VARIANTS, LIMITS,
} from './schema';

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const inline = { type: 'string', maxLength: LIMITS.text, description: 'Inline text: **bold**, *italic*, `code`, [label](https://...) — no HTML' };
const short = { type: 'string', maxLength: LIMITS.shortText };
const id = { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$', description: 'Unique within the document; generated when omitted' };
const httpsUrl = { type: 'string', format: 'uri', pattern: '^https://', maxLength: LIMITS.url };
const colsInt = { type: 'integer', minimum: 1, maximum: LIMITS.layoutColsMax };

function block(type: string, properties: Record<string, unknown>, required: string[] = []) {
  return {
    type: 'object',
    required: ['type', ...required],
    properties: { id, type: { type: 'string', const: type }, ...properties },
  };
}

const schemaName = (type: string) => `Block${type.charAt(0).toUpperCase()}${type.slice(1)}`;

/** JSON Schema for every block type (OpenAPI 3.1 dialect). Also served to agents via the block_schema MCP tool. */
export const blockSchemas: Record<string, unknown> = {
  BlockParagraph: block('paragraph', { text: inline }, ['text']),
  BlockHeading: block('heading', { level: { type: 'integer', enum: [1, 2, 3] }, text: short }, ['level', 'text']),
  BlockList: block('list', { style: { type: 'string', enum: ['bullet', 'number'] }, items: { type: 'array', minItems: 1, maxItems: LIMITS.listItems, items: inline } }, ['items']),
  BlockChecklist: block('checklist', {
    items: { type: 'array', minItems: 1, maxItems: LIMITS.listItems, items: { type: 'object', required: ['text'], properties: { text: inline, checked: { type: 'boolean' } } } },
  }, ['items']),
  BlockQuote: block('quote', { text: inline, cite: short }, ['text']),
  BlockCallout: block('callout', { tone: { type: 'string', enum: [...CALLOUT_TONES] }, text: inline }, ['text']),
  BlockCode: block('code', { language: { type: 'string', maxLength: 40 }, code: { type: 'string', maxLength: LIMITS.code } }, ['code']),
  BlockDivider: block('divider', {}),
  BlockImage: block('image', { url: httpsUrl, alt: short, caption: short }, ['url']),
  BlockEmbed: block('embed', {
    url: httpsUrl,
    provider: { type: 'string', enum: [...EMBED_PROVIDERS], description: 'Detected from the URL when omitted. Rendered click-to-load for privacy.' },
    caption: short,
  }, ['url']),
  BlockTable: block('table', {
    headers: { type: 'array', minItems: 1, maxItems: LIMITS.tableColumns, items: short },
    rows: { type: 'array', maxItems: LIMITS.tableRows, items: { type: 'array', items: inline, description: 'Same length as headers' } },
  }, ['headers', 'rows']),
  BlockChart: block('chart', {
    kind: { type: 'string', enum: [...CHART_KINDS] },
    title: short,
    labels: { type: 'array', minItems: 1, maxItems: LIMITS.chartLabels, items: { type: 'string', maxLength: 120 } },
    series: {
      type: 'array', minItems: 1, maxItems: LIMITS.chartSeries,
      items: { type: 'object', required: ['name', 'data'], properties: { name: { type: 'string', maxLength: 120 }, data: { type: 'array', items: { type: 'number' }, description: 'Same length as labels' } } },
    },
  }, ['kind', 'labels', 'series']),
  BlockDiagram: block('diagram', { syntax: { type: 'string', const: 'mermaid' }, source: { type: 'string', maxLength: LIMITS.mermaid }, caption: short }, ['source']),
  BlockSurvey: block('survey', {
    question: short,
    options: {
      type: 'array', minItems: LIMITS.surveyOptionsMin, maxItems: LIMITS.surveyOptionsMax,
      items: { type: 'object', required: ['label'], properties: { id, label: { type: 'string', maxLength: 200 } } },
    },
    allowMultiple: { type: 'boolean', default: false },
  }, ['question', 'options']),
  BlockLayout: block('layout', {
    variant: { type: 'string', enum: [...LAYOUT_VARIANTS] },
    cols: { type: 'object', required: ['base', 'md', 'lg'], properties: { base: colsInt, md: colsInt, lg: colsInt }, description: 'Columns at <768px, ≥768px, ≥1024px' },
    gap: { type: 'string', enum: [...LAYOUT_GAPS] },
    children: { type: 'array', minItems: 1, maxItems: LIMITS.layoutChildren, items: ref('LayoutChild') },
  }, ['cols', 'children']),
};

export const BLOCK_SCHEMA_NOTES = [
  `Layouts may nest at most ${LIMITS.layoutDepth} levels (a layout inside a layout is fine, a third level is rejected).`,
  'Object span values must be ≤ cols at that breakpoint; a numeric span must be ≤ cols.lg and is clamped per breakpoint.',
  'Each chart series must have exactly as many data points as labels.',
  `A document may contain at most ${LIMITS.totalBlocks} blocks in total (nested blocks included).`,
];

const articleSummary = {
  type: 'object',
  properties: {
    id: { type: 'string' }, slug: { type: 'string' }, locale: { type: 'string', enum: ['vi', 'en'] },
    title: { type: 'string' }, excerpt: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } },
    access: { type: 'string', enum: ['free', 'knowledges'] }, status: { type: 'string', enum: ['draft', 'published'] },
    revision: { type: 'integer' }, created_at: { type: 'string' }, updated_at: { type: 'string' },
    published_at: { type: ['string', 'null'] }, has_unpublished_changes: { type: 'boolean' },
  },
};

const json = (schema: unknown) => ({ 'application/json': { schema } });
const ok = (description: string, data: unknown) => ({
  description,
  content: json({ type: 'object', properties: { success: { type: 'boolean' }, data } }),
});
const conflict = { description: 'Revision conflict or slug taken (`revision_conflict`, `slug_taken`, `already_voted`)', content: json(ref('Error')) };
const notFound = { description: 'Not found', content: json(ref('Error')) };
const slugParam = { name: 'slug', in: 'path', required: true, schema: { type: 'string' } };
const blockIdParam = { name: 'blockId', in: 'path', required: true, schema: { type: 'string' } };
const articleSlugQuery = { name: 'article_slug', in: 'query', required: true, schema: { type: 'string' } };
const tags = ['Articles'];

export const articlesOpenApi: OpenApiFragment = {
  tag: { name: 'Articles', description: 'Block-based articles (rich blocks, layouts, paywall) and surveys' },
  schemas: {
    ...blockSchemas,
    Block: {
      oneOf: BLOCK_TYPES.map(t => ref(schemaName(t))),
      discriminator: { propertyName: 'type', mapping: Object.fromEntries(BLOCK_TYPES.map(t => [t, `#/components/schemas/${schemaName(t)}`])) },
    },
    LayoutChild: {
      type: 'object',
      required: ['blocks'],
      properties: {
        span: {
          oneOf: [
            colsInt,
            { type: 'object', properties: { base: colsInt, md: colsInt, lg: colsInt } },
          ],
        },
        rowSpan: { type: 'integer', minimum: 1, maximum: LIMITS.layoutRowSpanMax },
        blocks: { type: 'array', items: ref('Block') },
      },
    },
    ArticleDocument: {
      type: 'object',
      required: ['blocks'],
      properties: { version: { type: 'integer', const: 1 }, blocks: { type: 'array', items: ref('Block') } },
      description: BLOCK_SCHEMA_NOTES.join(' '),
    },
    ArticleSummary: articleSummary,
    Article: {
      allOf: [articleSummary, {
        type: 'object',
        properties: {
          document: ref('ArticleDocument'),
          truncated: { type: 'boolean', description: 'True when the paid remainder was withheld for this viewer' },
          preview: { type: 'boolean' },
        },
      }],
    },
    ArticleInput: {
      type: 'object',
      properties: {
        slug: { type: 'string', pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$' }, title: { type: 'string', maxLength: 200 },
        excerpt: { type: 'string', maxLength: 500 }, locale: { type: 'string', enum: ['vi', 'en'] },
        access: { type: 'string', enum: ['free', 'knowledges'] }, tags: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 40 } },
        document: ref('ArticleDocument'),
      },
    },
    SurveyResults: {
      type: 'object',
      properties: {
        block_id: { type: 'string' }, question: { type: 'string' }, allow_multiple: { type: 'boolean' },
        total_voters: { type: 'integer' }, voted: { type: 'boolean' },
        options: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, label: { type: 'string' }, count: { type: 'integer' }, percent: { type: 'number' } } } },
      },
    },
  },
  paths: {
    '/api/v1/articles': {
      get: {
        tags, summary: 'List published articles (admins: ?include_drafts=1)',
        parameters: [{ name: 'include_drafts', in: 'query', schema: { type: 'string', enum: ['1'] } }],
        responses: { '200': ok('Articles', { type: 'array', items: ref('ArticleSummary') }), ...errorResponses },
      },
      post: {
        tags, summary: 'Create a draft article', security: adminSecurity,
        requestBody: { required: true, content: json({ allOf: [ref('ArticleInput'), { required: ['slug', 'title'] }] }) },
        responses: {
          '201': ok('Created draft', ref('Article')), '409': conflict,
          '422': { description: '`invalid_document` with `errors: [{path, message}]`', content: json(ref('Error')) }, ...errorResponses,
        },
      },
    },
    '/api/v1/articles/{slug}': {
      get: {
        tags, summary: 'Get a published article (paywalled) or, for admins, the draft with ?draft=1',
        parameters: [slugParam, { name: 'draft', in: 'query', schema: { type: 'string', enum: ['1'] } }],
        responses: { '200': ok('Article', ref('Article')), '404': notFound, ...errorResponses },
      },
      put: {
        tags, summary: 'Update the draft (optimistic concurrency)', security: adminSecurity, parameters: [slugParam],
        requestBody: { required: true, content: json({ allOf: [ref('ArticleInput'), { type: 'object', required: ['expected_revision'], properties: { expected_revision: { type: 'integer' } } }] }) },
        responses: { '200': ok('Updated draft', ref('Article')), '404': notFound, '409': conflict, '422': { description: 'invalid_document', content: json(ref('Error')) }, ...errorResponses },
      },
      delete: {
        tags, summary: 'Soft-delete an article', security: adminSecurity, parameters: [slugParam],
        responses: { '200': ok('Deleted', { type: 'object', properties: { deleted: { type: 'boolean' } } }), '404': notFound, ...errorResponses },
      },
    },
    '/api/v1/articles/{slug}/publish': {
      post: {
        tags, summary: 'Publish the current draft', security: adminSecurity, parameters: [slugParam],
        requestBody: { required: true, content: json({ type: 'object', required: ['expected_revision', 'confirm'], properties: { expected_revision: { type: 'integer' }, confirm: { type: 'boolean', const: true } } }) },
        responses: { '200': ok('Published', ref('Article')), '404': notFound, '409': conflict, ...errorResponses },
      },
    },
    '/api/v1/surveys/{blockId}/vote': {
      post: {
        tags, summary: 'Vote in a survey (one vote per person; sets an HttpOnly zuey_voter cookie for anonymous voters)',
        parameters: [blockIdParam],
        requestBody: { required: true, content: json({ type: 'object', required: ['article_slug', 'option_ids'], properties: { article_slug: { type: 'string' }, option_ids: { type: 'array', items: { type: 'string' } } } }) },
        responses: {
          '201': ok('Vote recorded; aggregated results', ref('SurveyResults')),
          '403': { description: '`survey_locked`: survey is in the members-only part', content: json(ref('Error')) },
          '404': notFound,
          '409': { description: '`already_voted`; error.results contains current results', content: json(ref('Error')) },
          '429': { description: '`rate_limited`', content: json(ref('Error')) },
          '503': { description: '`survey_unconfigured` (SURVEY_HASH_SALT missing)', content: json(ref('Error')) },
          '400': errorResponses['400'],
        },
      },
    },
    '/api/v1/surveys/{blockId}/results': {
      get: {
        tags, summary: 'Aggregated survey results', parameters: [blockIdParam, articleSlugQuery],
        responses: { '200': ok('Results', ref('SurveyResults')), '403': { description: 'survey_locked', content: json(ref('Error')) }, '404': notFound, '400': errorResponses['400'] },
      },
    },
    '/api/v1/surveys/{blockId}/export.csv': {
      get: {
        tags, summary: 'Export individual votes as CSV (hashed voter ids, no IPs)', security: adminSecurity,
        parameters: [blockIdParam, articleSlugQuery],
        responses: { '200': { description: 'CSV', content: { 'text/csv': { schema: { type: 'string' } } } }, '404': notFound, ...errorResponses },
      },
    },
  },
};
