import type { OpenApiFragment } from '../openapi/types';
import { adminSecurity, errorResponses } from '../openapi/types';
import { LOCALES } from '../i18n/locales';
import { SORTS } from './articles';
import { MAX_ARTICLE_PAGE } from './pagination';
import {
  BLOCK_TYPES, CALLOUT_TONES, CHART_KINDS, EMBED_PROVIDERS, LAYOUT_GAPS, LAYOUT_VARIANTS, LIMITS,
} from './schema';

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const inline = { type: 'string', maxLength: LIMITS.text, description: 'Inline text: **bold**, *italic*, ~~strike~~, ==highlight==, `code`, [label](https://...) — no HTML' };
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
  BlockInteractive: block('interactive', {
    title: short,
    html: { type: 'string', maxLength: LIMITS.interactiveField, description: 'Body HTML' },
    css: { type: 'string', maxLength: LIMITS.interactiveField },
    js: { type: 'string', maxLength: LIMITS.interactiveField, description: 'Runs in a sandboxed opaque-origin iframe with CSP connect-src none; call zuey.fetch(url) for allowlisted GET requests via the server proxy' },
    height: { type: 'integer', minimum: LIMITS.interactiveHeightMin, maximum: LIMITS.interactiveHeightMax },
    caption: short,
  }, ['title']),
  BlockMath: block('math', { tex: { type: 'string', maxLength: LIMITS.math, description: 'TeX source; shown as accessible source text' }, caption: short }, ['tex']),
  BlockGallery: block('gallery', {
    images: {
      type: 'array', minItems: 1, maxItems: LIMITS.galleryImages,
      items: { type: 'object', required: ['url'], properties: { url: httpsUrl, alt: short, caption: short } },
    },
    caption: short,
  }, ['images']),
  BlockAudio: block('audio', { url: httpsUrl, title: short, caption: short }, ['url']),
  BlockVideo: block('video', { url: httpsUrl, poster: httpsUrl, title: short, caption: short }, ['url']),
  BlockFile: block('file', { url: httpsUrl, name: short, sizeBytes: { type: 'integer', minimum: 0 }, caption: short }, ['url', 'name']),
  BlockBookmark: block('bookmark', {
    url: httpsUrl, title: short, description: { type: 'string', maxLength: 1000 }, image: httpsUrl, siteName: { type: 'string', maxLength: 120 },
  }, ['url']),
  BlockToggle: block('toggle', {
    summary: short,
    open: { type: 'boolean', default: false },
    blocks: { type: 'array', maxItems: LIMITS.toggleChildren, items: ref('Block'), description: 'May not contain toggle or layout blocks' },
  }, ['summary', 'blocks']),
};

export const BLOCK_SCHEMA_NOTES = [
  `Layouts may nest at most ${LIMITS.layoutDepth} levels (a layout inside a layout is fine, a third level is rejected).`,
  'Object span values must be ≤ cols at that breakpoint; a numeric span must be ≤ cols.lg and is clamped per breakpoint.',
  'Each chart series must have exactly as many data points as labels.',
  `A document may contain at most ${LIMITS.totalBlocks} blocks in total (nested blocks included).`,
  `Interactive blocks: html/css/js at most ${LIMITS.interactiveField} characters each and ${LIMITS.interactiveTotal} combined; they run only in a sandboxed iframe and are rendered as a text fallback with a link in Markdown.`,
  'Toggle blocks may contain any block except toggle and layout.',
  'Inline text supports **bold**, *italic*, ~~strike~~, ==highlight==, `code` and [label](https://...).',
];

const localeEnum = { type: 'string', enum: [...LOCALES] };
const publicTag = { type: 'object', properties: { id: { type: 'string' }, slug: { type: 'string' }, name: { type: 'string' } } };
const publicLabel = {
  type: 'object',
  properties: { id: { type: 'string' }, kind: { type: 'string' }, slug: { type: 'string' }, name: { type: 'string' }, version: { type: ['string', 'null'] } },
};
const editionSummary = {
  type: 'object',
  properties: {
    locale: localeEnum, title: { type: 'string' }, excerpt: { type: 'string' }, status: { type: 'string', enum: ['draft', 'published'] },
    revision: { type: 'integer' }, published_revision: { type: ['integer', 'null'] }, published_at: { type: ['string', 'null'] },
    updated_at: { type: 'string' }, has_unpublished_changes: { type: 'boolean' }, reading_minutes: { type: 'integer' },
  },
};
const articleSummary = {
  type: 'object',
  properties: {
    id: { type: 'string' }, slug: { type: 'string' },
    locale: { ...localeEnum, description: 'Locale of the edition in this response' }, primary_locale: localeEnum,
    title: { type: 'string' }, excerpt: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' }, description: 'Display names of topic_tags (public for every reader)' },
    topic_tags: { type: 'array', items: publicTag }, category: { oneOf: [publicTag, { type: 'null' }] },
    labels: { type: 'array', items: publicLabel, description: 'Approved labels for this edition (evidence is admin-only)' },
    access: { type: 'string', enum: ['free', 'knowledges'] }, status: { type: 'string', enum: ['draft', 'published'] },
    revision: { type: 'integer', description: 'Article-wide revision for expected_revision' }, label_revision: { type: 'integer' },
    published_revision: { type: ['integer', 'null'] }, created_at: { type: 'string' }, updated_at: { type: 'string' },
    published_at: { type: ['string', 'null'] }, has_unpublished_changes: { type: 'boolean' },
    available_locales: { type: 'array', items: localeEnum, description: 'Locales with a published, human-written edition' },
    reading_minutes: { type: 'integer' }, cover_url: { type: ['string', 'null'] },
    snippet: { type: 'string', description: 'Search snippet (only with ?q=), from text this caller may read; ** marks matches' },
    editions: { type: 'array', items: editionSummary, description: 'Admin responses only' },
    email_notification: {
      description: 'Admin draft views and publish responses only: the new-article email to members (null before the first publish)',
      oneOf: [{ type: 'null' }, { type: 'object', properties: {
        status: { type: 'string', enum: ['scheduled', 'sending', 'sent', 'skipped', 'cancelled'] },
        send_after: { type: 'string', format: 'date-time' }, sent_count: { type: 'integer' },
        reason: { type: ['string', 'null'] }, updated_at: { type: 'string' },
      } }],
    },
  },
};
const localeQuery = { name: 'lang', in: 'query', schema: localeEnum, description: 'Edition locale; falls back to the primary edition (locale_fallback: true)' };

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
          locked_outline: {
            type: 'object',
            description: 'Only when truncated: the withheld top-level headings (plain text + level) and the withheld size. No other withheld text is returned.',
            required: ['headings', 'blocks', 'words'],
            properties: {
              headings: {
                type: 'array',
                items: { type: 'object', required: ['level', 'text'], properties: { level: { type: 'integer', enum: [1, 2, 3] }, text: { type: 'string' } } },
              },
              blocks: { type: 'integer', description: 'Number of withheld top-level blocks' },
              words: { type: 'integer', description: 'Approximate number of withheld words' },
            },
          },
          preview: { type: 'boolean' },
          locale_fallback: { type: 'boolean', description: 'The requested locale had no edition; another edition is returned' },
        },
      }],
    },
    ArticleInput: {
      type: 'object',
      properties: {
        slug: { type: 'string', pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$' }, title: { type: 'string', maxLength: 200 },
        excerpt: { type: 'string', maxLength: 500 },
        locale: { ...localeEnum, description: 'Edition to create/update (default: primary). Translations are written by people, never generated.' },
        primary_locale: localeEnum,
        access: { type: 'string', enum: ['free', 'knowledges'] },
        tags: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 40 }, description: 'Topic tag ids, slugs, aliases or names; unknown names create tags' },
        category: { type: ['string', 'null'], description: 'Category id or slug; null clears' },
        document: ref('ArticleDocument'),
      },
    },
    ArticleEdition: editionSummary,
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
        tags, summary: 'List/discover published articles (admins: ?include_drafts=1). With q, the authorization-first knowledge search orders results (X-Search-Semantic: 1|0).',
        parameters: [
          { name: 'include_drafts', in: 'query', schema: { type: 'string', enum: ['1'] } },
          { name: 'q', in: 'query', schema: { type: 'string', maxLength: 200 } },
          { ...localeQuery, description: 'Preferred edition locale; articles without it show their primary edition' },
          { name: 'category', in: 'query', schema: { type: 'string' }, description: 'Category slug or id' },
          { name: 'tag', in: 'query', schema: { type: 'string' }, description: 'Topic tag slug or id' },
          { name: 'label', in: 'query', schema: { type: 'string' }, description: '<kind>:<slug>, e.g. freshness:current' },
          { name: 'access', in: 'query', schema: { type: 'string', enum: ['free', 'knowledges'] } },
          { name: 'sort', in: 'query', schema: { type: 'string', enum: [...SORTS] } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100 }, description: 'Maximum results; with page, the page size (default 20)' },
          { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, maximum: MAX_ARTICLE_PAGE }, description: '1-based page of limit results' },
        ],
        responses: {
          '200': {
            ...ok('Articles', { type: 'array', items: ref('ArticleSummary') }),
            headers: {
              'X-Total-Count': { description: 'Matching articles before paging', schema: { type: 'integer' } },
              'X-Has-More': { description: '1 when more results follow this page', schema: { type: 'string', enum: ['0', '1'] } },
              Link: { description: 'rel="next" URL when page is given and more results follow', schema: { type: 'string' } },
            },
          },
          ...errorResponses,
        },
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
        tags, summary: 'Get one published edition (paywalled) or, for admins, its draft with ?draft=1',
        parameters: [slugParam, localeQuery, { name: 'draft', in: 'query', schema: { type: 'string', enum: ['1'] } }],
        responses: { '200': ok('Article', ref('Article')), '404': notFound, ...errorResponses },
      },
      put: {
        tags, summary: 'Update one edition draft (body.locale; a missing edition is created) and article metadata (optimistic concurrency)', security: adminSecurity, parameters: [slugParam],
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
        tags, summary: 'Publish one edition draft (locale, default primary)', security: adminSecurity, parameters: [slugParam],
        requestBody: { required: true, content: json({ type: 'object', required: ['expected_revision', 'confirm'], properties: {
          expected_revision: { type: 'integer' }, confirm: { type: 'boolean', const: true }, locale: localeEnum,
          published_at: { type: 'string', format: 'date-time', description: 'Backdate the publish time (not in the future), e.g. archive imports' },
          notify: { type: 'boolean', description: 'Email verified members 30 minutes after the first publish (default true; false when published_at backdates). false cancels a pending email; true schedules a previously skipped one.' },
        } }) },
        responses: { '200': ok('Published', ref('Article')), '404': notFound, '409': conflict, ...errorResponses },
      },
    },
    '/api/v1/articles/notifications/dispatch': {
      post: {
        tags, summary: 'Cron/admin: send due new-article emails to verified members (warm-up limited, quiet hours 23:00–07:00 Asia/Ho_Chi_Minh)',
        description: 'Called every 5 minutes by the Cloudflare cron worker with `Authorization: Bearer <CRON_SECRET>`; admins may call it too. Idempotent per article and member.',
        security: adminSecurity,
        responses: {
          '200': ok('Dispatch summary', { type: 'object', properties: {
            quiet_hours: { type: 'boolean' }, daily_limit: { type: 'integer' }, sent_last_24h: { type: 'integer' },
            articles: { type: 'array', items: { type: 'object', properties: {
              article_id: { type: 'string' }, slug: { type: ['string', 'null'] }, status: { type: 'string', enum: ['sent', 'sending', 'cancelled', 'error'] },
              sent: { type: 'integer' }, failed: { type: 'integer' }, error: { type: 'string' },
            } } },
          } }),
          '503': { description: '`email_unconfigured` (RESEND_API_KEY or MEMBER_HASH_SALT missing)', content: json(ref('Error')) },
          ...errorResponses,
        },
      },
    },
    '/api/v1/articles/{slug}/editions': {
      get: {
        tags, summary: 'List every locale edition (draft and published state)', security: adminSecurity, parameters: [slugParam],
        responses: { '200': ok('Editions', { type: 'object', properties: { slug: { type: 'string' }, primary_locale: localeEnum, revision: { type: 'integer' }, editions: { type: 'array', items: ref('ArticleEdition') } } }), '404': notFound, ...errorResponses },
      },
      delete: {
        tags, summary: 'Delete one non-primary edition', security: adminSecurity, parameters: [slugParam],
        requestBody: { required: true, content: json({ type: 'object', required: ['locale', 'expected_revision'], properties: { locale: localeEnum, expected_revision: { type: 'integer' } } }) },
        responses: { '200': ok('Remaining article', ref('ArticleSummary')), '404': notFound, '409': { description: '`revision_conflict` or `primary_edition`', content: json(ref('Error')) }, ...errorResponses },
      },
    },
    '/api/v1/articles/{slug}/revisions': {
      get: {
        tags, summary: 'Revision history; with ?revision=N&lang=xx the stored document (restore by saving it as the draft)', security: adminSecurity,
        parameters: [slugParam, localeQuery, { name: 'revision', in: 'query', schema: { type: 'integer', minimum: 1 } }],
        responses: {
          '200': ok('History or document', {
            oneOf: [
              { type: 'array', items: { type: 'object', properties: { revision: { type: 'integer' }, locale: localeEnum, action: { type: 'string' }, title: { type: 'string' }, actor: { type: 'string' }, created_at: { type: 'string' } } } },
              { type: 'object', properties: { revision: { type: 'integer' }, locale: localeEnum, title: { type: 'string' }, excerpt: { type: 'string' }, document: ref('ArticleDocument') } },
            ],
          }),
          '404': notFound, ...errorResponses,
        },
      },
    },
    '/api/v1/articles/{slug}/tags': {
      put: {
        tags, summary: 'Replace topic tags with existing tags', security: adminSecurity, parameters: [slugParam],
        requestBody: { required: true, content: json({ type: 'object', required: ['tags', 'expected_revision'], properties: { tags: { type: 'array', maxItems: 20, items: { type: 'string' } }, expected_revision: { type: 'integer' } } }) },
        responses: { '200': ok('Article', ref('ArticleSummary')), '404': notFound, '409': conflict, ...errorResponses },
      },
    },
    '/api/v1/articles/{slug}/labels': {
      get: {
        tags, summary: 'Label assignments with evidence and label history', security: adminSecurity, parameters: [slugParam],
        responses: { '200': ok('Label state', ref('LabelState')), '404': notFound, ...errorResponses },
      },
      put: {
        tags, summary: 'Replace label assignments as a new label revision (strict: facts need evidence)', security: adminSecurity, parameters: [slugParam],
        requestBody: { required: true, content: json({ type: 'object', required: ['assignments', 'expected_label_revision'], properties: { assignments: { type: 'array', items: ref('LabelAssignment') }, expected_label_revision: { type: 'integer' }, reason: { type: 'string' } } }) },
        responses: {
          '200': ok('Label state', ref('LabelState')), '404': notFound,
          '409': { description: '`label_revision_conflict`', content: json(ref('Error')) },
          '422': { description: '`invalid_labels` with errors', content: json(ref('Error')) }, ...errorResponses,
        },
      },
    },
    '/api/v1/articles/{slug}/labels/revert': {
      post: {
        tags, summary: 'Restore an earlier label revision as a new revision', security: adminSecurity, parameters: [slugParam],
        requestBody: { required: true, content: json({ type: 'object', required: ['to_label_revision', 'expected_label_revision'], properties: { to_label_revision: { type: 'integer', minimum: 0 }, expected_label_revision: { type: 'integer' }, reason: { type: 'string' } } }) },
        responses: { '200': ok('Label state', ref('LabelState')), '404': notFound, '409': { description: '`label_revision_conflict`', content: json(ref('Error')) }, ...errorResponses },
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
