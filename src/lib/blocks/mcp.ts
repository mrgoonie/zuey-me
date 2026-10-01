import type { McpToolModule } from '../mcp/types';
import { AppError, getString } from '../http';
import {
  createArticle, deleteArticle, getArticleView, listArticles, parseArticleInput, publishArticle, toSummary, updateArticle,
} from './articles';
import { documentToMarkdown } from './markdown';
import { BLOCK_TYPES, LIMITS } from './schema';
import { BLOCK_SCHEMA_NOTES, blockSchemas } from './openapi';
import { locateSurvey, surveyResults } from './survey';

const slugProp = { slug: { type: 'string', description: 'Article slug' } };
const documentProp = { document: { type: 'object', description: 'Block document {version: 1, blocks: [...]}; call block_schema for the format' } };
const metaProps = {
  title: { type: 'string' }, excerpt: { type: 'string' }, locale: { type: 'string', enum: ['vi', 'en'] },
  access: { type: 'string', enum: ['free', 'knowledges'] }, tags: { type: 'array', items: { type: 'string' } },
};

function requireSlug(args: Record<string, unknown>, key = 'slug'): string {
  const slug = getString(args, key);
  if (!slug) throw new AppError(400, 'invalid_field', `${key} is required`);
  return slug;
}

export const articlesMcpModule: McpToolModule = {
  tools: [
    { name: 'block_schema', description: 'Describe the article block document schema (all block types, layout rules, limits).', inputSchema: { type: 'object', properties: {} } },
    { name: 'article_list', description: 'List articles. Published only unless include_drafts (admin).', inputSchema: { type: 'object', properties: { include_drafts: { type: 'boolean' } } } },
    {
      name: 'article_get',
      description: 'Get an article. Non-admins receive the published version with the paid remainder withheld. Admins may pass draft: true. format "markdown" returns Markdown.',
      inputSchema: { type: 'object', properties: { ...slugProp, draft: { type: 'boolean' }, format: { type: 'string', enum: ['json', 'markdown'] } }, required: ['slug'] },
    },
    {
      name: 'article_create', description: 'Admin: create a draft article.',
      inputSchema: { type: 'object', properties: { ...slugProp, ...metaProps, ...documentProp }, required: ['slug', 'title'] },
    },
    {
      name: 'article_update', description: 'Admin: update the draft and metadata; requires expected_revision (409 revision_conflict when stale).',
      inputSchema: { type: 'object', properties: { ...slugProp, new_slug: { type: 'string' }, ...metaProps, ...documentProp, expected_revision: { type: 'integer' } }, required: ['slug', 'expected_revision'] },
    },
    {
      name: 'article_publish', description: 'Admin: publish the current draft. Requires confirm: true and expected_revision.',
      inputSchema: { type: 'object', properties: { ...slugProp, expected_revision: { type: 'integer' }, confirm: { type: 'boolean' } }, required: ['slug', 'expected_revision', 'confirm'] },
    },
    { name: 'article_delete', description: 'Admin: soft-delete an article.', inputSchema: { type: 'object', properties: { ...slugProp }, required: ['slug'] } },
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
        const includeDrafts = args.include_drafts === true;
        if (includeDrafts) await ctx.requireAdmin();
        return listArticles(d1, { includeDrafts });
      }
      case 'article_get': {
        const isAdmin = await ctx.isAdmin();
        if (args.draft === true && !isAdmin) throw new AppError(401, 'unauthorized', 'Draft access requires admin');
        const view = await getArticleView(d1, requireSlug(args), { isAdmin, entitlements: [] }, { draft: args.draft === true });
        if (!view) throw new AppError(404, 'not_found', 'Article not found');
        if (args.format === 'markdown') {
          const origin = new URL(ctx.request.url).origin;
          return { ...view, document: undefined, markdown: documentToMarkdown(view.document, { articleUrl: `${origin}/articles/${view.slug}` }) };
        }
        return view;
      }
      case 'article_create': {
        await ctx.requireAdmin();
        const rec = await createArticle(d1, parseArticleInput(args, 'create'));
        return { ...toSummary(rec), document: rec.draft };
      }
      case 'article_update': {
        await ctx.requireAdmin();
        const slug = requireSlug(args);
        const input = parseArticleInput({ ...args, slug: args.new_slug }, 'update');
        const rec = await updateArticle(d1, slug, input, args.expected_revision);
        return { ...toSummary(rec), document: rec.draft };
      }
      case 'article_publish': {
        await ctx.requireAdmin();
        const rec = await publishArticle(d1, requireSlug(args), args.expected_revision, args.confirm);
        return { ...toSummary(rec), document: rec.published };
      }
      case 'article_delete':
        await ctx.requireAdmin();
        await deleteArticle(d1, requireSlug(args));
        return { deleted: true };
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
