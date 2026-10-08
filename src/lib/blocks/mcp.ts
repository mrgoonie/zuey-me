import type { McpContext, McpToolModule } from '../mcp/types';
import type { Principal } from '../members/policy';
import { resolvePrincipal, viewerFromPrincipal } from '../members/policy';
import type { Viewer } from './paywall';
import { AppError, getString } from '../http';
import { LOCALES } from '../i18n/locales';
import { principalActor } from '../taxonomy/admin';
import {
  SORTS, createArticle, deleteArticle, deleteEdition, getArticle, getArticleView, getRevisionDocument, listArticles, listRevisions,
  parseArticleInput, publishArticle, setTagsForArticle, toSummary, updateArticle,
} from './articles';
import { discoverArticles } from './discovery';
import { documentToMarkdown } from './markdown';
import { localeField, parseDiscoveryQuery } from './params';
import type { ArticleDocument } from './schema';
import { BLOCK_TYPES, LIMITS } from './schema';
import { BLOCK_SCHEMA_NOTES, blockSchemas } from './openapi';
import { articleUrl } from './seo';
import { locateSurvey, surveyResults } from './survey';

/** Hosts an admin may import a block document from (first-party media bucket only, never arbitrary URLs). */
export const DOCUMENT_URL_HOSTS = ['media.zuey.me'] as const;
const DOCUMENT_URL_MAX_BYTES = 2_000_000;
/** Article fields an import payload may supply when the caller omits them (never slug or revision). */
const DOCUMENT_URL_METADATA = ['title', 'excerpt', 'tags', 'category', 'access', 'locale', 'primary_locale'] as const;
/** On update the payload never switches the article's primary language; adding an edition must not demote the original. */
const DOCUMENT_URL_UPDATE_METADATA = DOCUMENT_URL_METADATA.filter((key) => key !== 'primary_locale');

/**
 * Resolves `document_url` into `document` so large documents need not travel inline through the
 * MCP client. Called only after the admin gate; the host allowlist keeps the server from fetching
 * arbitrary URLs.
 */
export async function withFetchedDocument(args: Record<string, unknown>, fetcher: typeof fetch = fetch, mode: 'create' | 'update' = 'create'): Promise<Record<string, unknown>> {
  const raw = args.document_url;
  if (raw === undefined || args.document !== undefined) return args;
  if (typeof raw !== 'string') throw new AppError(400, 'invalid_field', 'document_url must be a string', { field: 'document_url' });
  let url: URL;
  try { url = new URL(raw); } catch { throw new AppError(400, 'invalid_field', 'document_url must be a valid URL', { field: 'document_url' }); }
  if (url.protocol !== 'https:' || !(DOCUMENT_URL_HOSTS as readonly string[]).includes(url.hostname)) {
    throw new AppError(400, 'invalid_field', `document_url must be https on ${DOCUMENT_URL_HOSTS.join(', ')}`, { field: 'document_url' });
  }
  // Workers reject redirect: 'error'; 'manual' surfaces a 3xx as !ok so redirects off the allowlist are never followed.
  const res = await fetcher(url.toString(), { redirect: 'manual' });
  if (!res.ok) throw new AppError(400, 'document_url_unavailable', `document_url returned HTTP ${res.status}`, { field: 'document_url' });
  const text = await res.text();
  if (text.length > DOCUMENT_URL_MAX_BYTES) throw new AppError(400, 'invalid_field', 'document_url body is too large', { field: 'document_url' });
  let body: unknown;
  try { body = JSON.parse(text); } catch { throw new AppError(400, 'invalid_field', 'document_url must serve JSON', { field: 'document_url' }); }
  const { document_url: _url, ...rest } = args;
  if (!body || typeof body !== 'object' || !('document' in body)) return { ...rest, document: body };
  // An import payload may also carry article metadata; explicit tool arguments always win.
  const payload = body as Record<string, unknown>;
  const filled: Record<string, unknown> = {};
  for (const key of mode === 'update' ? DOCUMENT_URL_UPDATE_METADATA : DOCUMENT_URL_METADATA) if (payload[key] !== undefined && rest[key] === undefined) filled[key] = payload[key];
  return { ...rest, ...filled, document: payload.document };
}

/** Echoes the saved draft, except for document_url imports where the caller already holds it (keeps bulk imports small). */
function withSavedDocument<T extends object>(summary: T, draft: ArticleDocument, args: Record<string, unknown>) {
  if (args.document === undefined && typeof args.document_url === 'string') return { ...summary, document_blocks: draft.blocks.length };
  return { ...summary, document: draft };
}

const slugProp = { slug: { type: 'string', description: 'Article slug' } };
const localeProp = { locale: { type: 'string', enum: [...LOCALES], description: 'Edition locale (default: primary edition)' } };
const documentProp = {
  document: { type: 'object', description: 'Block document {version: 1, blocks: [...]}; call block_schema for the format' },
  document_url: {
    type: 'string',
    description: `Alternative to document for large imports: https URL on ${DOCUMENT_URL_HOSTS.join(', ')} serving the block document JSON, or an import payload {document, title?, excerpt?, tags?, category?, access?, locale?, primary_locale?} whose fields fill arguments you omit. Ignored when document is given.`,
  },
};
const metaProps = {
  title: { type: 'string' }, excerpt: { type: 'string' }, ...localeProp,
  primary_locale: { type: 'string', enum: [...LOCALES] },
  access: { type: 'string', enum: ['free', 'knowledges'] },
  tags: { type: 'array', items: { type: 'string' }, description: 'Topic tag ids, slugs, aliases or names (unknown names create tags)' },
  category: { type: ['string', 'null'], description: 'Category id or slug; null clears' },
};

/** Caller resolved by the central membership policy (also when the MCP host did not memoise one). */
export async function mcpPrincipal(ctx: McpContext): Promise<Principal> {
  const principal = ctx.principal ? await ctx.principal() : await resolvePrincipal(ctx.request, { ...ctx.env, DB: ctx.d1 ?? ctx.env.DB });
  if (principal.credentialError) {
    throw new AppError(principal.credentialError.status, principal.credentialError.code, principal.credentialError.message);
  }
  return principal;
}

/** Same paywall decision as the HTML page, .md and REST: the central membership policy. */
async function mcpViewer(ctx: McpContext): Promise<Viewer> {
  if (!ctx.principal) return { isAdmin: await ctx.isAdmin(), entitlements: [] };
  return viewerFromPrincipal(await mcpPrincipal(ctx));
}

/** Admin gate for write tools; returns the actor recorded in history and audit logs. */
export async function mcpAdminActor(ctx: McpContext): Promise<string> {
  await ctx.requireAdmin();
  if (!ctx.principal) return 'mcp-admin';
  return principalActor(await ctx.principal());
}

export function requireSlug(args: Record<string, unknown>, key = 'slug'): string {
  const slug = getString(args, key);
  if (!slug) throw new AppError(400, 'invalid_field', `${key} is required`);
  return slug;
}

/** Builds a discovery query from tool arguments using the same validation as the REST query string. */
function discoveryFromArgs(args: Record<string, unknown>) {
  const url = new URL('https://mcp.local/articles');
  for (const key of ['q', 'category', 'tag', 'label', 'access', 'sort']) {
    const v = args[key];
    if (typeof v === 'string' && v) url.searchParams.set(key, v);
  }
  if (typeof args.locale === 'string' && args.locale) url.searchParams.set('lang', args.locale);
  if (typeof args.limit === 'number') url.searchParams.set('limit', String(args.limit));
  return parseDiscoveryQuery(url);
}

export const articlesMcpModule: McpToolModule = {
  tools: [
    { name: 'block_schema', description: 'Describe the article block document schema (all block types, layout rules, limits).', inputSchema: { type: 'object', properties: {} } },
    {
      name: 'article_list',
      description: 'List published articles with discovery filters (q uses the authorization-first knowledge search; tags, category and labels are public). include_drafts (admin) lists every edition.',
      inputSchema: {
        type: 'object',
        properties: {
          include_drafts: { type: 'boolean' }, q: { type: 'string' }, ...localeProp, category: { type: 'string' }, tag: { type: 'string' },
          label: { type: 'string', description: '<kind>:<slug>, e.g. freshness:current' }, access: { type: 'string', enum: ['free', 'knowledges'] },
          sort: { type: 'string', enum: [...SORTS] }, limit: { type: 'integer', minimum: 1, maximum: 100 },
        },
      },
    },
    {
      name: 'article_get',
      description: 'Get one locale edition of an article (locale falls back to the primary edition; locale_fallback tells). Readers without the read_full entitlement (Knowledges, Kết hợp, Cộng đồng plans) receive the published version with the paid remainder withheld. Admins may pass draft: true. format "markdown" returns Markdown.',
      inputSchema: { type: 'object', properties: { ...slugProp, ...localeProp, draft: { type: 'boolean' }, format: { type: 'string', enum: ['json', 'markdown'] } }, required: ['slug'] },
    },
    {
      name: 'article_create', description: 'Admin: create a draft article; its first edition uses locale (default vi).',
      inputSchema: { type: 'object', properties: { ...slugProp, ...metaProps, ...documentProp }, required: ['slug', 'title'] },
    },
    {
      name: 'article_update', description: 'Admin: update one edition draft (locale; a missing edition is created and needs title) and article metadata; requires expected_revision (409 revision_conflict when stale). Translations are written by people, never generated.',
      inputSchema: { type: 'object', properties: { ...slugProp, new_slug: { type: 'string' }, ...metaProps, ...documentProp, expected_revision: { type: 'integer' } }, required: ['slug', 'expected_revision'] },
    },
    {
      name: 'article_publish', description: 'Admin: publish one edition draft (locale, default primary). Requires confirm: true and expected_revision. published_at backdates archive imports.',
      inputSchema: { type: 'object', properties: { ...slugProp, ...localeProp, expected_revision: { type: 'integer' }, confirm: { type: 'boolean' }, published_at: { type: 'string', description: 'Optional ISO date (not in the future) to record as the publish time, e.g. when importing older posts' }, summary_only: { type: 'boolean', description: 'Return document_blocks instead of echoing the published document (bulk publishing)' } }, required: ['slug', 'expected_revision', 'confirm'] },
    },
    { name: 'article_delete', description: 'Admin: soft-delete an article (all editions).', inputSchema: { type: 'object', properties: { ...slugProp }, required: ['slug'] } },
    { name: 'article_editions', description: 'Admin: list every locale edition of an article with draft/published state.', inputSchema: { type: 'object', properties: { ...slugProp }, required: ['slug'] } },
    {
      name: 'article_edition_delete', description: 'Admin: delete one non-primary locale edition. Requires expected_revision.',
      inputSchema: { type: 'object', properties: { ...slugProp, ...localeProp, expected_revision: { type: 'integer' } }, required: ['slug', 'locale', 'expected_revision'] },
    },
    {
      name: 'article_revisions', description: 'Admin: revision history; with revision + locale returns that stored document (restore by saving it via article_update).',
      inputSchema: { type: 'object', properties: { ...slugProp, ...localeProp, revision: { type: 'integer' } }, required: ['slug'] },
    },
    {
      name: 'article_tags_set', description: 'Admin: replace the topic tags of an article with existing tags (ids, slugs, aliases or names). Requires expected_revision.',
      inputSchema: { type: 'object', properties: { ...slugProp, tags: { type: 'array', items: { type: 'string' } }, expected_revision: { type: 'integer' } }, required: ['slug', 'tags', 'expected_revision'] },
    },
    {
      name: 'survey_results', description: 'Admin: full vote counts for a survey block (draft or published).',
      inputSchema: { type: 'object', properties: { article_slug: { type: 'string' }, block_id: { type: 'string' } }, required: ['article_slug', 'block_id'] },
    },
  ],

  async call(name, args, ctx) {
    const d1 = ctx.d1;
    switch (name) {
      case 'block_schema':
        return { version: 1, block_types: BLOCK_TYPES, limits: LIMITS, rules: BLOCK_SCHEMA_NOTES, schemas: blockSchemas };
      case 'article_list': {
        const query = discoveryFromArgs(args);
        if (args.include_drafts === true) {
          await ctx.requireAdmin();
          const { q: _q, ...filters } = query;
          return listArticles(d1, { ...filters, includeDrafts: true });
        }
        const result = await discoverArticles(await mcpPrincipal(ctx), { ...ctx.env, DB: d1 }, query);
        return result.items;
      }
      case 'article_get': {
        const viewer = await mcpViewer(ctx);
        if (args.draft === true && !viewer.isAdmin) throw new AppError(401, 'unauthorized', 'Draft access requires admin');
        const view = await getArticleView(d1, requireSlug(args), viewer, { draft: args.draft === true, locale: localeField(args) });
        if (!view) throw new AppError(404, 'not_found', 'Article not found');
        if (args.format === 'markdown') {
          const origin = (ctx.env.PUBLIC_SITE_URL || new URL(ctx.request.url).origin).replace(/\/$/, '');
          return { ...view, document: undefined, markdown: documentToMarkdown(view.document, { articleUrl: articleUrl(origin, view.slug, view.locale) }) };
        }
        return view;
      }
      case 'article_create': {
        const actor = await mcpAdminActor(ctx);
        const input = parseArticleInput(await withFetchedDocument(args), 'create');
        const rec = await createArticle(d1, input, { actor, env: ctx.env, waitUntil: ctx.waitUntil });
        return withSavedDocument(toSummary(rec), rec.draft, args);
      }
      case 'article_update': {
        const actor = await mcpAdminActor(ctx);
        const slug = requireSlug(args);
        const input = parseArticleInput({ ...(await withFetchedDocument(args, fetch, 'update')), slug: args.new_slug }, 'update');
        const rec = await updateArticle(d1, slug, input, args.expected_revision, { actor, env: ctx.env, waitUntil: ctx.waitUntil });
        return withSavedDocument(toSummary(rec), rec.draft, args);
      }
      case 'article_publish': {
        const actor = await mcpAdminActor(ctx);
        const rec = await publishArticle(d1, requireSlug(args), args.expected_revision, args.confirm, { actor, env: ctx.env, waitUntil: ctx.waitUntil, locale: localeField(args), publishedAt: args.published_at });
        if (args.summary_only === true) return { ...toSummary(rec), document_blocks: rec.published?.blocks.length ?? 0 };
        return { ...toSummary(rec), document: rec.published };
      }
      case 'article_delete': {
        const actor = await mcpAdminActor(ctx);
        await deleteArticle(d1, requireSlug(args), { actor, env: ctx.env, waitUntil: ctx.waitUntil });
        return { deleted: true };
      }
      case 'article_editions': {
        await ctx.requireAdmin();
        const rec = await getArticle(d1, requireSlug(args));
        if (!rec) throw new AppError(404, 'not_found', 'Article not found');
        return { slug: rec.slug, primary_locale: rec.primary_locale, revision: rec.revision, editions: rec.editions };
      }
      case 'article_edition_delete': {
        const actor = await mcpAdminActor(ctx);
        const locale = localeField(args);
        if (!locale) throw new AppError(400, 'invalid_field', 'locale is required', { field: 'locale' });
        return toSummary(await deleteEdition(d1, requireSlug(args), locale, args.expected_revision, { actor, env: ctx.env, waitUntil: ctx.waitUntil }));
      }
      case 'article_revisions': {
        await ctx.requireAdmin();
        const slug = requireSlug(args);
        const locale = localeField(args);
        if (args.revision !== undefined) {
          if (typeof args.revision !== 'number' || !Number.isInteger(args.revision) || !locale) {
            throw new AppError(400, 'invalid_field', 'revision (integer) and locale are required together');
          }
          const doc = await getRevisionDocument(d1, slug, locale, args.revision);
          if (!doc) throw new AppError(404, 'not_found', 'Revision not found');
          return doc;
        }
        return listRevisions(d1, slug, locale);
      }
      case 'article_tags_set': {
        const actor = await mcpAdminActor(ctx);
        return toSummary(await setTagsForArticle(d1, requireSlug(args), args.tags, args.expected_revision, { actor, env: ctx.env, waitUntil: ctx.waitUntil }));
      }
      case 'survey_results': {
        await ctx.requireAdmin();
        const located = await locateSurvey(d1, requireSlug(args, 'article_slug'), requireSlug(args, 'block_id'), { isAdmin: true, entitlements: [] }, { includeDraft: true });
        return surveyResults(d1, located, null);
      }
      default:
        throw new AppError(404, 'unknown_tool', `Unknown tool ${name}`);
    }
  },
};
