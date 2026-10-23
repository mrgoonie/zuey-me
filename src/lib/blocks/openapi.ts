import type { OpenApiFragment } from '../openapi/types';
import { idempotencyKeyParam } from '../idempotency/openapi';
import { adminSecurity, errorResponses } from '../openapi/types';
import { LOCALES } from '../i18n/locales';
import { SORTS, WRITE_OPERATIONS } from './articles';
import { MAX_ARTICLE_PAGE } from './pagination';
import { BLOCK_TYPES, LIMITS } from './schema';
import { ICON_NAMES } from './icons';
import { blockDefinitions } from './registry';
import { blockId, colsInt } from './definitions/schema-fragments';

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

export { CALLOUT_ICON_EXAMPLE, ICON_BLOCK_EXAMPLE } from './definitions/text';
export { CARD_EXAMPLE, SECTION_EXAMPLE } from './definitions/containers';
export { MATH_EXAMPLE } from './definitions/media';

const schemaName = (type: string) => `Block${type.charAt(0).toUpperCase()}${type.slice(1)}`;

/** JSON Schema for every block type (OpenAPI 3.1 dialect), from the block registry. Also served to agents via the block_schema MCP tool. */
export const blockSchemas: Record<string, unknown> = Object.fromEntries(blockDefinitions().map(def => {
  const { properties, required = [], extra = {} } = def.schema;
  return [schemaName(def.type), {
    type: 'object',
    required: ['type', ...required],
    properties: { id: blockId, type: { type: 'string', const: def.type }, ...properties },
    ...extra,
  }];
}));

export const BLOCK_SCHEMA_NOTES = [
  `Layouts may nest at most ${LIMITS.layoutDepth} levels (a layout inside a layout is fine, a third level is rejected).`,
  'Object span values must be ≤ cols at that breakpoint; a numeric span must be ≤ cols.lg and is clamped per breakpoint.',
  'Each chart series must have exactly as many data points as labels.',
  `A document may contain at most ${LIMITS.totalBlocks} blocks in total (nested blocks included).`,
  `Interactive blocks: html/css/js at most ${LIMITS.interactiveField} characters each and ${LIMITS.interactiveTotal} combined; they run only in a sandboxed iframe and are rendered as a text fallback with a link in Markdown.`,
  'Toggle blocks may contain any block except toggle and layout.',
  `Math blocks hold TeX (KaTeX subset, at most ${LIMITS.math} characters, without surrounding $ or $$). Readers get it typeset on the server as HTML plus MathML, with the TeX source one click away and a copy-TeX button; malformed TeX is not rejected but shown as source with an error note. mode is display (default) or inline; numbered: true (display only) adds an equation number in document order; equation, align, gather and \\tag number themselves in the same sequence and get no second number. Macro definitions (\\def, \\newcommand), formulas over 2000 characters and math beyond a per-page typesetting budget show as source. Markdown exports $$…$$ (display) or $…$ (inline), or a math code block when the TeX contains the delimiter.`,
  `Section blocks are top-level only (never inside a layout, toggle or card) and may contain any block except section (at most ${LIMITS.sectionChildren}). width picks the reading lane on the article page (prose, wide or full); surface and padding style the band; anchor is an optional unique slug for #links. The paywall counts a section's children one by one, like those of cards, toggles and layout cells.`,
  `Card blocks may appear anywhere except inside another card (body at most ${LIMITS.cardChildren} blocks, no section or card). A card needs a title, an image or at least one block; level (2, 3 or 4, default 3) sets the heading level of its title; footer is inline text for links.`,
  `Icon blocks and callout.icon accept only the ${ICON_NAMES.length} curated icon names (or their aliases); block_schema returns them under icons. Add label when the icon carries meaning; omit it for decoration.`,
  'Inline text supports **bold**, *italic*, ~~strike~~, ==highlight==, `code` and [label](https://...).',
  'Host images on https://media.zuey.me instead of hotlinking: media_upload_url (file on disk, upload with curl), media_import (public URL) or media_upload (small base64) return an image block with width and height to insert as is.',
];

const localeEnum = { type: 'string', enum: [...LOCALES] };
const responseMode = { type: 'string', enum: ['full', 'summary'], description: 'summary: answer with the receipt (document_blocks, content_hash) instead of echoing the document' };
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
    reading_minutes: { type: 'integer' },
    cover_url: { type: ['string', 'null'], description: 'Cover of this edition: the managed cover when set, else the first public image' },
    cover_asset_id: { type: ['string', 'null'], description: 'Managed media asset shared by every edition as the cover (set with PUT /api/v1/articles/{slug}/cover)' },
    cover_alt: { type: 'string', description: "Alt text of this edition's managed cover" },
    social_preview: {
      type: 'object',
      description: 'What og:image and Twitter cards show: generated_card (rendered share card, default), cover (the managed cover) or custom_asset (its own asset)',
      properties: { mode: { type: 'string', enum: ['generated_card', 'cover', 'custom_asset'] }, asset_id: { type: ['string', 'null'] } },
    },
    snippet: { type: 'string', description: 'Search snippet (only with ?q=), from text this caller may read; ** marks matches' },
    editions: { type: 'array', items: editionSummary, description: 'Admin responses only' },
    email_notification: {
      description: 'Admin draft views and publish responses only: the new-article email to members (null before the first publish). '
        + 'A publish response reports status `failed` (reason `notification_update_failed`, send_after null) when the email step failed after the publish committed; '
        + 'the edition is published, and republishing with an explicit `notify` applies the email decision again.',
      oneOf: [{ type: 'null' }, { type: 'object', properties: {
        status: { type: 'string', enum: ['scheduled', 'sending', 'sent', 'skipped', 'cancelled', 'failed'] },
        send_after: { type: ['string', 'null'], format: 'date-time' }, sent_count: { type: 'integer' },
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
/** A writer's answer: the article plus the required `receipt` of the write. */
const withReceipt = (article: unknown) => ({ allOf: [article, { type: 'object', required: ['receipt'], properties: { receipt: ref('WriteReceipt') } }] });
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
    WriteReceipt: {
      type: 'object',
      description: 'Outcome of a write, separate from the public `status` of the article it returns.',
      required: ['operation_success', 'operation', 'locale', 'article_revision', 'edition_draft_revision', 'published_revision', 'has_unpublished_changes', 'submitted_fields', 'next_action'],
      properties: {
        operation_success: { type: 'boolean', const: true },
        operation: { type: 'string', enum: [...WRITE_OPERATIONS], description: 'The writer that produced the receipt' },
        locale: { ...localeEnum, description: 'Edition the write is about: the saved, published or deleted one; the primary edition for tags_set' },
        article_revision: { type: 'integer', description: 'Use as the next expected_revision' },
        edition_draft_revision: { type: 'integer', description: 'Revision at which this edition last changed; lower than article_revision after tags_set, which leaves the edition alone' },
        published_revision: { type: ['integer', 'null'], description: 'null when the edition was never published or was just deleted' },
        has_unpublished_changes: { type: 'boolean' },
        submitted_fields: { type: 'array', items: { type: 'string' }, description: 'Fields present in the request, not a diff (publish: published_at, notify; tags_set: tags; edition_delete: none)' },
        next_action: { type: 'string', enum: ['publish', 'none'] },
      },
    },
    Article: {
      allOf: [articleSummary, {
        type: 'object',
        properties: {
          document: ref('ArticleDocument'),
          truncated: { type: 'boolean', description: 'True when the paid remainder was withheld for this viewer' },
          locked_outline: {
            type: 'object',
            description: 'Only when truncated: the withheld headings (plain text + level) and the withheld size. No other withheld text is returned.',
            required: ['headings', 'blocks', 'words'],
            properties: {
              headings: {
                type: 'array',
                items: { type: 'object', required: ['level', 'text'], properties: { level: { type: 'integer', enum: [1, 2, 3] }, text: { type: 'string' } } },
              },
              blocks: { type: 'integer', description: 'Number of withheld blocks (blocks inside sections, cards, toggles and layout cells count one by one)' },
              words: { type: 'integer', description: 'Approximate number of withheld words' },
            },
          },
          preview: { type: 'boolean' },
          locale_fallback: { type: 'boolean', description: 'The requested locale had no edition; another edition is returned' },
          recovery: { ...ref('DocumentRecovery'), description: 'Admin draft reads (?draft=1) only' },
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
        response_mode: responseMode,
      },
    },
    ArticleEdition: editionSummary,
    DocumentRecovery: {
      type: ['object', 'null'],
      description: 'null when the stored document passed validation; otherwise how it was recovered for display. '
        + 'Saving the returned document over the stored one makes the loss permanent, so editors should confirm first.',
      required: ['dropped_blocks', 'degraded_embeds', 'unreadable'],
      properties: {
        dropped_blocks: { type: 'integer', minimum: 0, description: 'Invalid blocks skipped on read' },
        degraded_embeds: { type: 'integer', minimum: 0, description: 'Embeds whose stored provider no longer matches their URL, shown as plain links' },
        unreadable: { type: 'boolean', description: 'The stored document (or every block of it) could not be read; it is returned empty' },
      },
    },
    LocalizationManifest: {
      type: 'object',
      properties: {
        slug: { type: 'string' }, source_locale: localeEnum, source_revision: { type: 'integer' }, source_hash: { type: 'string' },
        locales: { type: 'array', items: { type: 'object', properties: {
          locale: localeEnum, state: { type: 'string', enum: ['missing', 'unmanaged', 'current', 'stale'] },
          edition_status: { type: 'string', enum: ['draft', 'published'] }, edited_since_apply: { type: 'boolean' },
          applied_from_revision: { type: 'integer' }, applied_at: { type: 'string' },
        } } },
        entries: { type: 'array', items: { type: 'object', properties: {
          key: { type: 'string', description: '<block_id>#<field_path>; $article#title and $article#excerpt are the edition metadata' },
          block_id: { type: 'string' }, field_path: { type: 'string' },
          kind: { type: 'string', enum: ['text', 'inline', 'diagram_label', 'widget_text', 'meta'] },
          source_text: { type: 'string' }, source_hash: { type: 'string' },
          constraints: { type: 'object', properties: { placeholders: { type: 'array', items: { type: 'string' }, description: 'Link URLs, `code` spans and {{tokens}} to keep verbatim' }, plain: { type: 'boolean', description: 'Plain text (no inline Markdown)' } } },
        } } },
        skipped: { type: 'array', items: { type: 'object', properties: { block_id: { type: 'string' }, field_path: { type: 'string' }, reason: { type: 'string' } } } },
        stats: { type: 'object', properties: { entries: { type: 'integer' }, characters: { type: 'integer' } } },
        notes: { type: 'array', items: { type: 'string' } },
      },
    },
    LocalizationResult: {
      type: 'object',
      properties: {
        dry_run: { type: 'boolean' }, valid: { type: 'boolean' }, committed: { type: 'boolean' },
        slug: { type: 'string' }, locale: localeEnum, source_locale: localeEnum, source_hash: { type: 'string' },
        errors: { type: 'array', items: { type: 'object', properties: { key: { type: 'string' }, path: { type: 'string' }, code: { type: 'string' }, message: { type: 'string' } } } },
        report: { type: ['object', 'null'], description: 'coverage, unchanged entries, placeholders kept, glossary checks, number/price/date/legal checks, warnings (review) and skipped items; quality is always "not_assessed"' },
        article_revision: { type: 'integer' }, provenance_recorded: { type: 'boolean' }, next_action: { type: 'string' },
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
    '/feed.json': {
      get: {
        tags, summary: 'Public JSON Feed 1.1 of published article summaries for partner syndication (no auth, never the paid body)',
        description: 'Newest-first published editions of exactly one locale (default vi, no fallback to other locales). Title, summary and date_modified come from the last published snapshot, so draft saves never show up. Output depends only on the query, is CDN-cacheable and supports ETag / If-None-Match. Follow `next_url` for older items.',
        parameters: [
          { name: 'lang', in: 'query', schema: localeEnum, description: 'Edition locale (default vi)' },
          { name: 'category', in: 'query', schema: { type: 'string' }, description: 'Category slug or id' },
          { name: 'tag', in: 'query', schema: { type: 'string' }, description: 'Topic tag slug or id' },
          { name: 'access', in: 'query', schema: { type: 'string', enum: ['free', 'knowledges'] }, description: 'Filter only; the feed never carries paid bodies' },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
          { name: 'cursor', in: 'query', schema: { type: 'string' }, description: 'Opaque value from a previous next_url' },
        ],
        responses: {
          '200': {
            description: 'JSON Feed 1.1',
            headers: { ETag: { schema: { type: 'string' } }, 'Cache-Control': { schema: { type: 'string' } } },
            content: { 'application/feed+json': { schema: { type: 'object', required: ['version', 'title', 'items'], properties: { version: { type: 'string', const: 'https://jsonfeed.org/version/1.1' }, title: { type: 'string' }, home_page_url: { type: 'string' }, feed_url: { type: 'string' }, language: { type: 'string' }, authors: { type: 'array', items: { type: 'object' } }, next_url: { type: 'string' }, items: { type: 'array', items: { type: 'object' } } } } } },
          },
          '304': { description: 'If-None-Match matched the current ETag' },
          '400': { description: 'Invalid lang, access, limit or cursor', content: json(ref('Error')) },
          '503': { description: 'Database unavailable (never an empty successful feed)', content: json(ref('Error')) },
        },
      },
    },
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
        tags, summary: 'Create a draft article', security: adminSecurity, parameters: [idempotencyKeyParam],
        requestBody: { required: true, content: json({ allOf: [ref('ArticleInput'), { required: ['slug', 'title'] }] }) },
        responses: {
          '201': ok('Created draft with its `receipt`', withReceipt(ref('Article'))), '409': conflict,
          '422': { description: '`invalid_document` with `errors: [{path, message}]`', content: json(ref('Error')) }, ...errorResponses,
        },
      },
    },
    '/api/v1/articles/{slug}': {
      get: {
        tags, summary: 'Get one published edition (paywalled) or, for admins, its draft with ?draft=1',
        description: 'mode narrows the read: summary (metadata plus document_blocks and content_hash), outline (block ids, types, labels), translatables (visible text fields keyed by block_id and field_path, paged by cursor and limit), section (one block with its children, needs block_id) or full (default). Every mode applies the same paywall as full.',
        parameters: [slugParam, localeQuery, { name: 'draft', in: 'query', schema: { type: 'string', enum: ['1'] } },
          { name: 'mode', in: 'query', schema: { type: 'string', enum: ['summary', 'outline', 'translatables', 'section', 'full'] } },
          { name: 'block_id', in: 'query', schema: { type: 'string' }, description: 'mode=section: block to return' },
          { name: 'cursor', in: 'query', schema: { type: 'string' }, description: 'mode=translatables: next_cursor of the previous page' },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 500 }, description: 'mode=translatables: page size (default 100)' }],
        responses: { '200': ok('Article', ref('Article')), '404': notFound, ...errorResponses },
      },
      put: {
        tags, summary: 'Update one edition draft (body.locale; a missing edition is created) and article metadata (optimistic concurrency)', security: adminSecurity, parameters: [slugParam, idempotencyKeyParam],
        requestBody: { required: true, content: json({ allOf: [ref('ArticleInput'), { type: 'object', required: ['expected_revision'], properties: { expected_revision: { type: 'integer' }, response_mode: responseMode } }] }) },
        responses: { '200': ok('Updated draft; `receipt` states the write outcome separately from the public `status`', withReceipt(ref('Article'))), '404': notFound, '409': conflict, '422': { description: 'invalid_document', content: json(ref('Error')) }, ...errorResponses },
      },
      delete: {
        tags, summary: 'Soft-delete an article', security: adminSecurity, parameters: [slugParam, idempotencyKeyParam],
        responses: { '200': ok('Deleted', { type: 'object', properties: { deleted: { type: 'boolean' } } }), '404': notFound, ...errorResponses },
      },
    },
    '/api/v1/articles/{slug}/publish': {
      post: {
        tags, summary: 'Publish one edition draft (locale, default primary)', security: adminSecurity, parameters: [slugParam, idempotencyKeyParam],
        requestBody: { required: true, content: json({ type: 'object', required: ['expected_revision', 'confirm'], properties: {
          expected_revision: { type: 'integer' }, confirm: { type: 'boolean', const: true }, locale: localeEnum, response_mode: responseMode,
          published_at: { type: 'string', format: 'date-time', description: 'Backdate the publish time (not in the future), e.g. archive imports' },
          notify: { type: 'boolean', description: 'Email verified members 30 minutes after the first publish (default true; false when published_at backdates). false cancels a pending email; true schedules a previously skipped one.' },
        } }) },
        responses: { '200': ok('Published edition with its `receipt`', withReceipt(ref('Article'))), '404': notFound, '409': conflict, ...errorResponses },
      },
    },
    '/api/v1/articles/{slug}/localization/prepare': {
      post: {
        tags, summary: 'Translatable manifest of one edition: entries keyed by block id + field path, skipped items and the state of each target locale',
        security: adminSecurity, parameters: [slugParam],
        requestBody: { required: true, content: json({ type: 'object', properties: {
          locales: { type: 'array', items: localeEnum, description: 'Target locales (default: every locale except the source)' },
          source_locale: { ...localeEnum, description: 'Edition to translate from (default: primary)' },
          source_revision: { type: 'integer', description: '409 revision_conflict when the article moved on' },
        } }) },
        responses: { '200': ok('Manifest', ref('LocalizationManifest')), '404': notFound, '409': conflict, ...errorResponses },
      },
    },
    '/api/v1/articles/{slug}/localization/apply': {
      post: {
        tags, summary: 'Merge translations keyed by manifest key into the preserved source blocks and save them as one target edition draft (never published)',
        description: 'All-or-nothing: missing or unknown keys, changed links/code/tokens, invalid diagram or widget text and any structural difference from the source return `valid: false` with `errors` and write nothing. '
          + '`409`: `stale_source` (source changed since prepare), `translation_exists` (hand-written target), `translation_edited` (target edited after the last apply), `revision_conflict`.',
        security: adminSecurity, parameters: [slugParam],
        requestBody: { required: true, content: json({ type: 'object', required: ['locale', 'source_hash', 'translations'], properties: {
          locale: { ...localeEnum, description: 'Target locale (one per call)' },
          source_locale: localeEnum,
          source_hash: { type: 'string', description: 'From prepare; a different value means the source changed' },
          source_hashes: { type: 'object', additionalProperties: { type: 'string' }, description: 'Optional per-key source_hash values from prepare, used to name the changed keys when the source is stale' },
          translations: { type: 'object', additionalProperties: { type: 'string' }, description: 'Manifest key to translated text; every key of the manifest is required' },
          glossary: { type: 'object', additionalProperties: { type: 'string' }, description: 'Optional {source term: required translation}' },
          expected_revision: { type: 'integer', description: 'Optional; defaults to the revision read by this call' },
          overwrite: { type: 'boolean', description: 'Replace a hand-written or hand-edited target edition' },
          dry_run: { type: 'boolean', description: 'Validate and report without writing' },
        } }) },
        responses: { '200': ok('Result with the localization report', ref('LocalizationResult')), '404': notFound, '409': conflict, ...errorResponses },
      },
    },
    '/api/v1/articles/{slug}/verify': {
      get: {
        tags, summary: 'Verify the live public pages of every published edition as an anonymous visitor', security: adminSecurity,
        description: 'Compares HTTP status, title, html lang, canonical, hreflang set, og:image, twitter:image, JSON-LD image, the members-only notice on paid editions and image reachability (site and media.zuey.me only) with the stored editions, and reports the published content hash and the pending new-article email. It does not render widgets.',
        parameters: [slugParam, { name: 'lang', in: 'query', schema: localeEnum, description: 'Repeatable; default every published edition' }, { name: 'images', in: 'query', schema: { type: 'string', enum: ['0'] }, description: '0 skips the image requests' }],
        responses: { '200': ok('Verification', { type: 'object', properties: { slug: { type: 'string' }, ok: { type: 'boolean' }, checked_at: { type: 'string' }, locales: { type: 'object', additionalProperties: { type: 'object' } }, unpublished_locales: { type: 'array', items: localeEnum }, pending_side_effects: { type: 'object' } } }), '404': notFound, ...errorResponses },
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
        tags, summary: 'Delete one non-primary edition', security: adminSecurity, parameters: [slugParam, idempotencyKeyParam],
        requestBody: { required: true, content: json({ type: 'object', required: ['locale', 'expected_revision'], properties: { locale: localeEnum, expected_revision: { type: 'integer' } } }) },
        responses: { '200': ok('Primary edition; `receipt` describes the deleted locale', withReceipt(ref('ArticleSummary'))), '404': notFound, '409': { description: '`revision_conflict` or `primary_edition`', content: json(ref('Error')) }, ...errorResponses },
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
              { type: 'object', properties: { revision: { type: 'integer' }, locale: localeEnum, title: { type: 'string' }, excerpt: { type: 'string' }, document: ref('ArticleDocument'), recovery: ref('DocumentRecovery') } },
            ],
          }),
          '404': notFound, ...errorResponses,
        },
      },
    },
    '/api/v1/articles/{slug}/tags': {
      put: {
        tags, summary: 'Replace topic tags with existing tags', security: adminSecurity, parameters: [slugParam, idempotencyKeyParam],
        requestBody: { required: true, content: json({ type: 'object', required: ['tags', 'expected_revision'], properties: { tags: { type: 'array', maxItems: 20, items: { type: 'string' } }, expected_revision: { type: 'integer' } } }) },
        responses: { '200': ok('Article with its `receipt`', withReceipt(ref('ArticleSummary'))), '404': notFound, '409': conflict, ...errorResponses },
      },
    },
    '/api/v1/articles/{slug}/cover': {
      put: {
        tags, summary: 'Set the managed cover (media asset id) and social preview for every edition, without rewriting bodies', security: adminSecurity, parameters: [slugParam],
        requestBody: { required: true, content: json({
          type: 'object', required: ['expected_revision'],
          properties: {
            expected_revision: { type: 'integer' },
            asset_id: { type: ['string', 'null'], description: 'Managed media asset id (`med_…`); null clears the managed cover' },
            alt: { type: 'string', maxLength: 500, description: 'Alt text for every edition' },
            alts: { type: 'object', additionalProperties: { type: 'string', maxLength: 500 }, description: 'Per-locale alt text keyed by locale code' },
            social_preview: { type: 'object', properties: { mode: { type: 'string', enum: ['generated_card', 'cover', 'custom_asset'] }, asset_id: { type: 'string', description: 'Required with custom_asset' } } },
          },
        }) },
        responses: {
          '200': ok('Receipt: new revision, cover, social preview and per-edition cover URL/alt', {
            type: 'object',
            properties: {
              operation_success: { type: 'boolean' }, slug: { type: 'string' }, revision: { type: 'integer' },
              cover: { type: ['object', 'null'], properties: { asset_id: { type: 'string' }, url: { type: 'string' }, width: { type: ['integer', 'null'] }, height: { type: ['integer', 'null'] } } },
              social_preview: { type: 'object', properties: { mode: { type: 'string' }, asset_id: { type: ['string', 'null'] }, image_url: { type: ['string', 'null'] } } },
              editions: { type: 'array', items: { type: 'object', properties: { locale: localeEnum, published: { type: 'boolean' }, cover_url: { type: ['string', 'null'] }, cover_alt: { type: 'string' } } } },
              next_action: { type: 'string' },
            },
          }),
          '404': notFound, '409': conflict, ...errorResponses,
        },
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
