import type { McpContext, McpToolModule } from '../mcp/types';
import { AppError, getString } from '../http';
import { DEFAULT_LOCALE, LOCALES } from '../i18n/locales';
import { requireArticleId } from '../blocks/articles';
import { mcpAdminActor, mcpPrincipal, requireSlug } from '../blocks/mcp';
import { localeField } from '../blocks/params';
import { reindexAll, searchKnowledge } from '../search';
import { cancelAuditJob, createAuditJob, getAuditJob, listAuditJobs, parseJobInput, runAuditBatch } from './audit';
import { createCategory, deleteCategory, listCategories, parseCategoryInput, updateCategory } from './categories';
import { listAuditLog, requireDb } from './common';
import {
  LABEL_KINDS, LABEL_SCOPES, createLabel, deleteLabel, getLabelState, listLabelHistory, listLabels, parseLabelInput, revertLabels,
  setArticleLabels, updateLabel,
} from './labels';
import { DECISIONS, PROPOSAL_STATUSES, createProposal, decideProposal, getProposal, listProposals, parseStatusFilter } from './proposals';
import { publicTaxonomy } from './public';
import { createTag, deleteTag, listTags, parseTagInput, updateTag } from './tags';

const localeProp = { locale: { type: 'string', enum: [...LOCALES] } };
const idProp = { id: { type: 'string', description: 'Id or slug' } };
const revProp = { expected_revision: { type: 'integer', minimum: 0 } };
const namesProp = { names: { type: 'object', description: 'Localized names, e.g. {"vi": "Trí tuệ nhân tạo", "en": "AI"}' } };
const assignmentsProp = {
  assignments: {
    type: 'array',
    description: 'Label assignments: {label_id | label: "<kind>:<slug>", scope: article|locale|revision|block, locale?, block_id?, evidence?: {source_url, source_title, as_of, retrieved_at, review_date, version_applicability, claim, note}}. claim/freshness need a locale scope; claim:fact needs https source_url + as_of/retrieved_at.',
    items: { type: 'object' },
  },
};

function requireId(args: Record<string, unknown>, key = 'id'): string {
  const v = getString(args, key);
  if (!v) throw new AppError(400, 'invalid_field', `${key} is required`, { field: key });
  return v;
}

async function articleIdArg(ctx: McpContext, args: Record<string, unknown>): Promise<string> {
  return requireArticleId(ctx.d1, requireSlug(args, 'article_slug'));
}

/** Knowledge search plus taxonomy administration (tags, categories, labels, proposals, AI audit jobs). */
export const taxonomyMcpModule: McpToolModule = {
  tools: [
    {
      name: 'knowledge_search',
      description: 'Search published articles (BM25 + optional semantic). Authorization happens before ranking: without the read_full entitlement only free text and paid previews are searched, so snippets never quote paid text. Also returns `videos`: Zueytube videos whose title, description or transcript match.',
      inputSchema: { type: 'object', properties: { query: { type: 'string' }, ...localeProp, limit: { type: 'integer', minimum: 1, maximum: 50 } }, required: ['query'] },
    },
    { name: 'taxonomy_facets', description: 'Public tags, categories and approved labels used by published articles, localized.', inputSchema: { type: 'object', properties: { ...localeProp } } },
    { name: 'tag_list', description: 'Admin: all topic tags with names, aliases, revision and article counts.', inputSchema: { type: 'object', properties: {} } },
    { name: 'tag_create', description: 'Admin: create a topic tag (stable id; slug/aliases/names must not collide).', inputSchema: { type: 'object', properties: { slug: { type: 'string' }, ...namesProp, aliases: { type: 'array', items: { type: 'string' } } }, required: ['names'] } },
    { name: 'tag_update', description: 'Admin: rename/re-alias a tag; requires expected_revision. Reindexes tagged articles.', inputSchema: { type: 'object', properties: { ...idProp, ...revProp, slug: { type: 'string' }, ...namesProp, aliases: { type: 'array', items: { type: 'string' } } }, required: ['id', 'expected_revision'] } },
    { name: 'tag_delete', description: 'Admin: delete a tag and detach it from articles; requires expected_revision.', inputSchema: { type: 'object', properties: { ...idProp, ...revProp }, required: ['id', 'expected_revision'] } },
    { name: 'category_list', description: 'Admin: all categories.', inputSchema: { type: 'object', properties: {} } },
    { name: 'category_create', description: 'Admin: create a category.', inputSchema: { type: 'object', properties: { slug: { type: 'string' }, ...namesProp, position: { type: 'integer' } }, required: ['names'] } },
    { name: 'category_update', description: 'Admin: update a category; requires expected_revision.', inputSchema: { type: 'object', properties: { ...idProp, ...revProp, slug: { type: 'string' }, ...namesProp, position: { type: 'integer' } }, required: ['id', 'expected_revision'] } },
    { name: 'category_delete', description: 'Admin: delete a category; requires expected_revision.', inputSchema: { type: 'object', properties: { ...idProp, ...revProp }, required: ['id', 'expected_revision'] } },
    { name: 'label_list', description: 'Admin: label vocabulary (claim, freshness, domain, tool, model, workflow, mindset, extension), including unapproved extensions.', inputSchema: { type: 'object', properties: {} } },
    {
      name: 'label_create', description: 'Admin: add a label to an admin-managed vocabulary; extension labels stay unapproved unless approve: true. claim/freshness are closed built-ins.',
      inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: [...LABEL_KINDS] }, slug: { type: 'string' }, ...namesProp, aliases: { type: 'array', items: { type: 'string' } }, description: { type: 'string' }, version: { type: 'string' }, approve: { type: 'boolean' } }, required: ['kind', 'slug', 'names'] },
    },
    { name: 'label_update', description: 'Admin: edit or approve a label (id or <kind>:<slug>); requires expected_revision.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, ...revProp, ...namesProp, description: { type: 'string' }, version: { type: ['string', 'null'] }, approve: { type: 'boolean' } }, required: ['id', 'expected_revision'] } },
    { name: 'label_delete', description: 'Admin: delete an unused non-built-in label; requires expected_revision.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, ...revProp }, required: ['id', 'expected_revision'] } },
    { name: 'article_labels_get', description: 'Admin: current label assignments (with evidence) and label revision history of an article.', inputSchema: { type: 'object', properties: { article_slug: { type: 'string' } }, required: ['article_slug'] } },
    {
      name: 'article_labels_set', description: `Admin: replace an article's label assignments as a new label revision (scopes: ${LABEL_SCOPES.join(', ')}); requires expected_label_revision.`,
      inputSchema: { type: 'object', properties: { article_slug: { type: 'string' }, ...assignmentsProp, expected_label_revision: { type: 'integer' }, reason: { type: 'string' } }, required: ['article_slug', 'assignments', 'expected_label_revision'] },
    },
    {
      name: 'article_labels_revert', description: 'Admin: restore an earlier label revision as a NEW revision (history is never rewritten).',
      inputSchema: { type: 'object', properties: { article_slug: { type: 'string' }, to_label_revision: { type: 'integer' }, expected_label_revision: { type: 'integer' }, reason: { type: 'string' } }, required: ['article_slug', 'to_label_revision', 'expected_label_revision'] },
    },
    { name: 'label_proposal_list', description: 'Admin: label proposals for review.', inputSchema: { type: 'object', properties: { status: { type: 'string', enum: [...PROPOSAL_STATUSES] }, article_slug: { type: 'string' }, job_id: { type: 'string' } } } },
    { name: 'label_proposal_get', description: 'Admin: one label proposal with before/proposed assignments and reviewer questions.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
    {
      name: 'label_proposal_create', description: 'Admin: file a proposal for one edition (unverified facts become needs-review questions).',
      inputSchema: { type: 'object', properties: { article_slug: { type: 'string' }, ...localeProp, ...assignmentsProp, rationale: { type: 'string' } }, required: ['article_slug', 'locale', 'assignments'] },
    },
    {
      name: 'label_proposal_decide', description: 'Admin: approve | edit | reject | defer a proposal. approve/edit need confirm: true and expected_label_revision (edit also assignments). Approving an applied proposal is idempotent; a changed edition returns 409 edition_changed.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' }, decision: { type: 'string', enum: [...DECISIONS] }, confirm: { type: 'boolean' }, expected_label_revision: { type: 'integer' }, ...assignmentsProp, reason: { type: 'string' } }, required: ['id', 'decision'] },
    },
    { name: 'label_audit_job_list', description: 'Admin: recent AI label audit jobs.', inputSchema: { type: 'object', properties: {} } },
    {
      name: 'label_audit_job_create', description: 'Admin: queue an AI label audit over published editions (resumable cursor).',
      inputSchema: { type: 'object', properties: { locales: { type: 'array', items: { type: 'string', enum: [...LOCALES] } }, article_ids: { type: 'array', items: { type: 'string' } }, skip_unchanged: { type: 'boolean' }, batch_size: { type: 'integer', minimum: 1, maximum: 20 } } },
    },
    { name: 'label_audit_job_get', description: 'Admin: audit job status and cursor.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
    { name: 'label_audit_job_run', description: 'Admin: process the next batch with Workers AI (503 ai_unavailable when the AI binding is missing).', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
    { name: 'label_audit_job_cancel', description: 'Admin: cancel an audit job.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
    { name: 'taxonomy_audit_log', description: 'Admin: taxonomy audit trail.', inputSchema: { type: 'object', properties: { target_type: { type: 'string' }, target_id: { type: 'string' }, limit: { type: 'integer' } } } },
    { name: 'search_reindex', description: 'Admin: rebuild the search index (FTS5, plus vectors when Vectorize is bound).', inputSchema: { type: 'object', properties: {} } },
  ],

  async call(name, args, ctx) {
    const d1 = ctx.d1;
    const env = { ...ctx.env, DB: d1 ?? ctx.env.DB };
    switch (name) {
      case 'knowledge_search': {
        const query = getString(args, 'query') ?? '';
        if (!query.trim()) throw new AppError(400, 'invalid_field', 'query is required', { field: 'query' });
        const limit = typeof args.limit === 'number' ? args.limit : 10;
        return searchKnowledge(await mcpPrincipal(ctx), query, localeField(args) ?? null, limit, env);
      }
      case 'taxonomy_facets':
        return publicTaxonomy(d1, localeField(args) ?? DEFAULT_LOCALE);
      case 'tag_list': await ctx.requireAdmin(); return listTags(d1);
      case 'tag_create': return createTag(d1, parseTagInput(args, 'create'), await mcpAdminActor(ctx));
      case 'tag_update': {
        const actor = await mcpAdminActor(ctx);
        return updateTag(d1, requireId(args), parseTagInput(args, 'update'), args.expected_revision, actor, env);
      }
      case 'tag_delete': {
        const actor = await mcpAdminActor(ctx);
        await deleteTag(d1, requireId(args), args.expected_revision, actor, env);
        return { deleted: true };
      }
      case 'category_list': await ctx.requireAdmin(); return listCategories(d1);
      case 'category_create': return createCategory(d1, parseCategoryInput(args, 'create'), await mcpAdminActor(ctx));
      case 'category_update': {
        const actor = await mcpAdminActor(ctx);
        return updateCategory(d1, requireId(args), parseCategoryInput(args, 'update'), args.expected_revision, actor, env);
      }
      case 'category_delete': {
        const actor = await mcpAdminActor(ctx);
        await deleteCategory(d1, requireId(args), args.expected_revision, actor, env);
        return { deleted: true };
      }
      case 'label_list': await ctx.requireAdmin(); return listLabels(d1, { includeUnapproved: true });
      case 'label_create': return createLabel(d1, parseLabelInput(args, 'create'), await mcpAdminActor(ctx));
      case 'label_update': {
        const actor = await mcpAdminActor(ctx);
        const { id: _id, ...rest } = args;
        return updateLabel(d1, requireId(args), parseLabelInput(rest, 'update'), args.expected_revision, actor);
      }
      case 'label_delete': {
        const actor = await mcpAdminActor(ctx);
        await deleteLabel(d1, requireId(args), args.expected_revision, actor);
        return { deleted: true };
      }
      case 'article_labels_get': {
        await ctx.requireAdmin();
        const articleId = await articleIdArg(ctx, args);
        return { ...(await getLabelState(d1, articleId)), history: await listLabelHistory(d1, articleId) };
      }
      case 'article_labels_set': {
        const actor = await mcpAdminActor(ctx);
        return setArticleLabels(d1, await articleIdArg(ctx, args), args.assignments, args.expected_label_revision, actor, args.reason);
      }
      case 'article_labels_revert': {
        const actor = await mcpAdminActor(ctx);
        return revertLabels(d1, await articleIdArg(ctx, args), args.to_label_revision, args.expected_label_revision, actor, args.reason);
      }
      case 'label_proposal_list': {
        await ctx.requireAdmin();
        const slug = getString(args, 'article_slug');
        return listProposals(d1, {
          status: parseStatusFilter(getString(args, 'status') ?? null),
          articleId: slug ? await requireArticleId(d1, slug) : undefined,
          jobId: getString(args, 'job_id'),
        });
      }
      case 'label_proposal_get': {
        await ctx.requireAdmin();
        const proposal = await getProposal(d1, requireId(args));
        if (!proposal) throw new AppError(404, 'not_found', 'Proposal not found');
        return proposal;
      }
      case 'label_proposal_create': {
        const actor = await mcpAdminActor(ctx);
        const locale = localeField(args);
        if (!locale) throw new AppError(400, 'invalid_field', 'locale is required', { field: 'locale' });
        return createProposal(d1, {
          articleId: await articleIdArg(ctx, args), locale, assignments: args.assignments,
          rationale: getString(args, 'rationale') ?? '', actor,
        });
      }
      case 'label_proposal_decide': {
        const actor = await mcpAdminActor(ctx);
        return decideProposal(d1, requireId(args), args, actor);
      }
      case 'label_audit_job_list': await ctx.requireAdmin(); return listAuditJobs(d1);
      case 'label_audit_job_create': return createAuditJob(d1, parseJobInput(args), await mcpAdminActor(ctx));
      case 'label_audit_job_get': {
        await ctx.requireAdmin();
        const job = await getAuditJob(d1, requireId(args));
        if (!job) throw new AppError(404, 'not_found', 'Audit job not found');
        return job;
      }
      case 'label_audit_job_run': return runAuditBatch(d1, env, requireId(args), await mcpAdminActor(ctx));
      case 'label_audit_job_cancel': return cancelAuditJob(d1, requireId(args), await mcpAdminActor(ctx));
      case 'taxonomy_audit_log':
        await ctx.requireAdmin();
        return listAuditLog(d1, {
          targetType: getString(args, 'target_type'), targetId: getString(args, 'target_id'),
          limit: typeof args.limit === 'number' ? args.limit : undefined,
        });
      case 'search_reindex':
        await ctx.requireAdmin();
        return reindexAll(requireDb(d1), env);
      default:
        throw new AppError(404, 'unknown_tool', `Unknown tool ${name}`);
    }
  },
};
