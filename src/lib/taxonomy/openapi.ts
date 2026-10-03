import type { OpenApiFragment } from '../openapi/types';
import { adminSecurity, errorResponses } from '../openapi/types';
import { LOCALES } from '../i18n/locales';
import { SEARCH_TIERS } from '../search/indexer';
import { JOB_STATUSES } from './audit';
import { LABEL_KINDS, LABEL_SCOPES } from './labels';
import { DECISIONS, PROPOSAL_STATUSES } from './proposals';

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: unknown) => ({ 'application/json': { schema } });
const ok = (description: string, data: unknown) => ({
  description,
  content: json({ type: 'object', properties: { success: { type: 'boolean', const: true }, data } }),
});
const err = (description: string) => ({ description, content: json(ref('Error')) });
const notFound = err('Not found');
const revisionConflict = err('`revision_conflict` (stale expected_revision) or a duplicate slug/alias/name');
const locale = { type: 'string', enum: [...LOCALES] };
const names = {
  type: 'object', description: 'Localized display names; at least one locale',
  properties: Object.fromEntries(LOCALES.map(l => [l, { type: 'string', maxLength: 60 }])),
};
const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'string' } };
const expectedRevisionQuery = { name: 'expected_revision', in: 'query', schema: { type: 'integer' }, description: 'Alternative to the body field' };
const deleteBody = { required: false, content: json({ type: 'object', properties: { expected_revision: { type: 'integer' } } }) };
const deleted = ok('Deleted', { type: 'object', properties: { deleted: { type: 'boolean', const: true } } });
const tags = ['Knowledge taxonomy'];
const admin = { tags, security: adminSecurity };

function crud(kind: string, schema: string, inputSchema: string, note: string) {
  return {
    collection: {
      get: { ...admin, summary: `List ${kind}s`, responses: { '200': ok(`${kind}s`, { type: 'array', items: ref(schema) }), ...errorResponses } },
      post: {
        ...admin, summary: `Create a ${kind}. ${note}`,
        requestBody: { required: true, content: json(ref(inputSchema)) },
        responses: { '201': ok('Created', ref(schema)), '409': revisionConflict, ...errorResponses },
      },
    },
    item: {
      get: { ...admin, summary: `Get one ${kind}`, parameters: [idParam], responses: { '200': ok(kind, ref(schema)), '404': notFound, ...errorResponses } },
      put: {
        ...admin, summary: `Update a ${kind} (optimistic concurrency)`, parameters: [idParam],
        requestBody: { required: true, content: json({ allOf: [ref(inputSchema), { type: 'object', required: ['expected_revision'], properties: { expected_revision: { type: 'integer' } } }] }) },
        responses: { '200': ok('Updated', ref(schema)), '404': notFound, '409': revisionConflict, ...errorResponses },
      },
      delete: {
        ...admin, summary: `Delete a ${kind}`, parameters: [idParam, expectedRevisionQuery], requestBody: deleteBody,
        responses: { '200': deleted, '404': notFound, '409': revisionConflict, ...errorResponses },
      },
    },
  };
}

const tagPaths = crud('tag', 'TopicTag', 'TopicTagInput', 'Slug, aliases and localized names must be unique across tags.');
const categoryPaths = crud('category', 'Category', 'CategoryInput', 'Articles have at most one category.');
const labelPaths = crud('label', 'TaxonomyLabel', 'TaxonomyLabelInput', 'claim/freshness are built in; `extension` labels stay unapproved until approve: true.');
labelPaths.item.delete.summary = 'Delete an unused, non-built-in label';

export const taxonomyOpenApi: OpenApiFragment = {
  tag: {
    name: 'Knowledge taxonomy',
    description: 'Knowledge search (authorization before ranking), public discovery facets, and admin taxonomy: topic tags, categories, typed labels with evidence, AI label proposals with human review, resumable audit jobs, and the audit log.',
  },
  schemas: {
    KnowledgeHit: {
      type: 'object',
      properties: {
        article_id: { type: 'string' }, slug: { type: 'string' }, locale, title: { type: 'string' }, excerpt: { type: 'string' },
        snippet: { type: 'string', description: 'Matched text from a tier this caller may read; ** marks matches; never HTML' },
        tier: { type: 'string', enum: [...SEARCH_TIERS] }, access: { type: 'string', enum: ['free', 'knowledges'] },
        full_text: { type: 'boolean' }, published_revision: { type: ['integer', 'null'] }, published_at: { type: ['string', 'null'] },
        score: { type: 'number' }, relevance: { type: ['number', 'null'], description: 'Jev (TypeSafe AI) probability that this hit answers the query; null when the Jev layer did not run. A ranking signal, not a guarantee of correctness' },
        sources: { type: 'array', items: { type: 'string', enum: ['bm25', 'semantic'] } },
        url: { type: 'string' }, markdown_url: { type: 'string' },
      },
    },
    KnowledgeSearchResult: {
      type: 'object',
      properties: {
        query: { type: 'string' }, locale: { oneOf: [locale, { type: 'null' }] },
        semantic: { type: 'boolean', description: 'False means BM25 only (no Vectorize/AI binding, or embedding failed)' },
        reranked: { type: 'boolean', description: 'True when the Jev relevance layer (TYPESAFEAI_API_KEY) reordered the fused results; false falls back to BM25/vector fusion order' },
        tiers: { type: 'array', items: { type: 'string', enum: [...SEARCH_TIERS] }, description: 'Index tiers searched; others were excluded before ranking' },
        results: { type: 'array', items: ref('KnowledgeHit') },
      },
    },
    PublicTaxonomy: {
      type: 'object',
      properties: {
        locale,
        tags: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, slug: { type: 'string' }, name: { type: 'string' }, published_count: { type: 'integer' } } } },
        categories: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, slug: { type: 'string' }, name: { type: 'string' }, published_count: { type: 'integer' } } } },
        labels: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' }, key: { type: 'string', description: '<kind>:<slug>' }, kind: { type: 'string', enum: [...LABEL_KINDS] },
              slug: { type: 'string' }, name: { type: 'string' }, version: { type: ['string', 'null'] }, published_count: { type: 'integer' },
            },
          },
        },
      },
    },
    TopicTag: {
      type: 'object',
      properties: {
        id: { type: 'string' }, slug: { type: 'string' }, names, aliases: { type: 'array', items: { type: 'string' } },
        revision: { type: 'integer' }, article_count: { type: 'integer' }, created_at: { type: 'string' }, updated_at: { type: 'string' },
      },
    },
    TopicTagInput: { type: 'object', properties: { names, slug: { type: 'string' }, aliases: { type: 'array', maxItems: 10, items: { type: 'string', maxLength: 40 } } } },
    Category: {
      type: 'object',
      properties: {
        id: { type: 'string' }, slug: { type: 'string' }, names, position: { type: 'integer' }, revision: { type: 'integer' },
        article_count: { type: 'integer' }, created_at: { type: 'string' }, updated_at: { type: 'string' },
      },
    },
    CategoryInput: { type: 'object', properties: { names, slug: { type: 'string' }, position: { type: 'integer' } } },
    TaxonomyLabel: {
      type: 'object',
      properties: {
        id: { type: 'string' }, kind: { type: 'string', enum: [...LABEL_KINDS] }, slug: { type: 'string' }, names,
        aliases: { type: 'array', items: { type: 'string' } }, description: { type: 'string' }, version: { type: ['string', 'null'] },
        builtin: { type: 'boolean' }, approved: { type: 'boolean' }, approved_at: { type: ['string', 'null'] }, approved_by: { type: ['string', 'null'] },
        revision: { type: 'integer' }, created_at: { type: 'string' }, updated_at: { type: 'string' },
      },
    },
    TaxonomyLabelInput: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: LABEL_KINDS.filter(k => k !== 'claim' && k !== 'freshness') }, slug: { type: 'string' }, names,
        aliases: { type: 'array', items: { type: 'string' } }, description: { type: 'string' }, version: { type: ['string', 'null'] },
        approve: { type: 'boolean', description: 'Approve an extension label' },
      },
    },
    LabelEvidence: {
      type: 'object',
      description: 'claim:fact needs source_url (https), retrieved_at and claim; time-sensitive labels need as_of/review_date',
      properties: {
        source_url: { type: 'string' }, source_title: { type: 'string' }, retrieved_at: { type: 'string' }, as_of: { type: 'string' },
        review_date: { type: 'string' }, version_applicability: { type: 'string' }, claim: { type: 'string' }, note: { type: 'string' },
      },
    },
    LabelAssignment: {
      type: 'object',
      required: ['scope'],
      properties: {
        label_id: { type: 'string' }, label: { type: 'string', description: 'Input only: <kind>:<slug> instead of label_id' },
        scope: { type: 'string', enum: [...LABEL_SCOPES] }, locale, edition_revision: { type: 'integer' },
        block_id: { type: 'string', description: 'Required for scope block' }, evidence: ref('LabelEvidence'),
      },
    },
    LabelState: {
      type: 'object',
      properties: {
        article_id: { type: 'string' }, label_revision: { type: 'integer' }, assignments: { type: 'array', items: ref('LabelAssignment') },
        history: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              label_revision: { type: 'integer' }, assignments: { type: 'array', items: ref('LabelAssignment') },
              source: { type: 'string', enum: ['manual', 'proposal', 'revert'] }, proposal_id: { type: ['string', 'null'] },
              actor: { type: 'string' }, reason: { type: 'string' }, created_at: { type: 'string' },
            },
          },
        },
      },
    },
    LabelProposal: {
      type: 'object',
      properties: {
        id: { type: 'string' }, job_id: { type: ['string', 'null'] }, article_id: { type: 'string' }, article_slug: { type: 'string' },
        article_title: { type: 'string' }, locale, edition_revision: { type: 'integer' }, current_edition_revision: { type: ['integer', 'null'] },
        base_label_revision: { type: 'integer' }, current_label_revision: { type: 'integer' },
        before: { type: 'array', items: ref('LabelAssignment') }, proposed: { type: 'array', items: ref('LabelAssignment') },
        questions: { type: 'array', items: { type: 'string' } }, rationale: { type: 'string' },
        status: { type: 'string', enum: [...PROPOSAL_STATUSES] },
        outdated: { type: 'boolean', description: 'The edition text changed after the proposal; it can no longer be approved' },
        decided_by: { type: ['string', 'null'] }, decided_at: { type: ['string', 'null'] }, decision_reason: { type: ['string', 'null'] },
        applied_label_revision: { type: ['integer', 'null'] }, created_at: { type: 'string' }, updated_at: { type: 'string' },
      },
    },
    AuditJob: {
      type: 'object',
      properties: {
        id: { type: 'string' }, status: { type: 'string', enum: [...JOB_STATUSES] },
        scope: { type: 'object', properties: { locales: { type: 'array', items: locale }, article_ids: { type: 'array', items: { type: 'string' } }, skip_unchanged: { type: 'boolean' } } },
        cursor: { type: 'string', description: 'Last processed <article_id>|<locale>; the next run resumes after it' },
        batch_size: { type: 'integer' }, processed: { type: 'integer' }, skipped: { type: 'integer' }, proposal_count: { type: 'integer' },
        error_count: { type: 'integer' }, last_error: { type: ['string', 'null'] }, model: { type: 'string' }, snapshot_at: { type: 'string' },
        created_by: { type: 'string' }, created_at: { type: 'string' }, updated_at: { type: 'string' }, completed_at: { type: ['string', 'null'] },
      },
    },
    TaxonomyAuditEntry: {
      type: 'object',
      properties: {
        id: { type: 'string' }, actor: { type: 'string' }, action: { type: 'string' }, target_type: { type: 'string' }, target_id: { type: 'string' },
        before: {}, after: {}, reason: { type: 'string' }, created_at: { type: 'string' },
      },
    },
  },
  paths: {
    '/api/v1/search': {
      get: {
        tags, summary: 'Knowledge search (BM25 plus optional semantic). Authorization is applied before ranking: without read_full only free text and paid previews are searched.',
        parameters: [
          { name: 'q', in: 'query', required: true, schema: { type: 'string', minLength: 1, maxLength: 200 } },
          { name: 'locale', in: 'query', schema: locale, description: 'Restrict to one edition locale (alias: lang)' },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 50, default: 10 } },
        ],
        responses: { '200': ok('Results', ref('KnowledgeSearchResult')), ...errorResponses },
      },
    },
    '/api/v1/search/reindex': {
      post: {
        ...admin, summary: 'Rebuild the search index (and Vectorize vectors when bound) for every article',
        responses: { '200': ok('Reindexed', { type: 'object', properties: { articles: { type: 'integer' }, rows: { type: 'integer' }, semantic: { type: 'boolean' } } }), ...errorResponses },
      },
    },
    '/api/v1/taxonomy': {
      get: {
        tags, summary: 'Public discovery facets: tags, categories and approved labels used by published articles',
        parameters: [{ name: 'lang', in: 'query', schema: locale }],
        responses: { '200': ok('Facets', ref('PublicTaxonomy')), ...errorResponses },
      },
    },
    '/api/v1/taxonomy/tags': tagPaths.collection,
    '/api/v1/taxonomy/tags/{id}': tagPaths.item,
    '/api/v1/taxonomy/categories': categoryPaths.collection,
    '/api/v1/taxonomy/categories/{id}': categoryPaths.item,
    '/api/v1/taxonomy/labels': labelPaths.collection,
    '/api/v1/taxonomy/labels/{id}': labelPaths.item,
    '/api/v1/taxonomy/proposals': {
      get: {
        ...admin, summary: 'Label proposals for review',
        parameters: [
          { name: 'status', in: 'query', schema: { type: 'string', enum: [...PROPOSAL_STATUSES] } },
          { name: 'article_id', in: 'query', schema: { type: 'string' } },
          { name: 'job_id', in: 'query', schema: { type: 'string' } },
        ],
        responses: { '200': ok('Proposals', { type: 'array', items: ref('LabelProposal') }), ...errorResponses },
      },
      post: {
        ...admin, summary: 'File a manual proposal for one edition (unverified facts are downgraded to needs-review with a question)',
        requestBody: {
          required: true,
          content: json({ type: 'object', required: ['article_slug', 'locale', 'assignments'], properties: { article_slug: { type: 'string' }, locale, assignments: { type: 'array', items: ref('LabelAssignment') }, rationale: { type: 'string' } } }),
        },
        responses: { '201': ok('Created', ref('LabelProposal')), '404': notFound, ...errorResponses },
      },
    },
    '/api/v1/taxonomy/proposals/{id}': {
      get: { ...admin, summary: 'Get one proposal', parameters: [idParam], responses: { '200': ok('Proposal', ref('LabelProposal')), '404': notFound, ...errorResponses } },
    },
    '/api/v1/taxonomy/proposals/{id}/decision': {
      post: {
        ...admin, summary: 'Approve, edit, reject or defer a proposal. Approve/edit apply a new label revision; approving an applied proposal is idempotent.',
        parameters: [idParam],
        requestBody: {
          required: true,
          content: json({
            type: 'object', required: ['decision'],
            properties: {
              decision: { type: 'string', enum: [...DECISIONS] }, reason: { type: 'string' },
              confirm: { type: 'boolean', const: true, description: 'Required for approve/edit' },
              expected_label_revision: { type: 'integer', description: 'Required for approve/edit' },
              assignments: { type: 'array', items: ref('LabelAssignment'), description: 'Required for edit' },
            },
          }),
        },
        responses: {
          '200': ok('Decision', { type: 'object', properties: { proposal: ref('LabelProposal'), labels: { oneOf: [ref('LabelState'), { type: 'null' }] }, already_applied: { type: 'boolean' } } }),
          '404': notFound,
          '409': err('`label_revision_conflict`, `edition_changed` (proposal became stale) or `proposal_closed`'),
          '422': err('`invalid_labels`'), ...errorResponses,
        },
      },
    },
    '/api/v1/taxonomy/audit-jobs': {
      get: { ...admin, summary: 'Recent AI label audit jobs', responses: { '200': ok('Jobs', { type: 'array', items: ref('AuditJob') }), ...errorResponses } },
      post: {
        ...admin, summary: 'Queue an AI label audit over published editions; run it with /run in resumable batches',
        requestBody: {
          required: false,
          content: json({ type: 'object', properties: { locales: { type: 'array', items: locale }, article_ids: { type: 'array', items: { type: 'string' } }, skip_unchanged: { type: 'boolean' }, batch_size: { type: 'integer', minimum: 1, maximum: 20 } } }),
        },
        responses: { '201': ok('Created', ref('AuditJob')), ...errorResponses },
      },
    },
    '/api/v1/taxonomy/audit-jobs/{id}': {
      get: { ...admin, summary: 'Get one audit job', parameters: [idParam], responses: { '200': ok('Job', ref('AuditJob')), '404': notFound, ...errorResponses } },
    },
    '/api/v1/taxonomy/audit-jobs/{id}/run': {
      post: {
        ...admin, summary: 'Process the next batch from the cursor (errors pause the job; repeat until completed)', parameters: [idParam],
        responses: {
          '200': ok('Job', ref('AuditJob')), '404': notFound, '409': err('`job_closed`'),
          '503': err('`ai_unavailable`: the Workers AI binding is not configured'), ...errorResponses,
        },
      },
    },
    '/api/v1/taxonomy/audit-jobs/{id}/cancel': {
      post: { ...admin, summary: 'Cancel a job (existing proposals stay for review)', parameters: [idParam], responses: { '200': ok('Job', ref('AuditJob')), '404': notFound, '409': err('`job_closed`'), ...errorResponses } },
    },
    '/api/v1/taxonomy/audit-log': {
      get: {
        ...admin, summary: 'Taxonomy audit trail',
        parameters: [
          { name: 'target_type', in: 'query', schema: { type: 'string', enum: ['tag', 'category', 'label', 'article', 'proposal', 'audit_job'] } },
          { name: 'target_id', in: 'query', schema: { type: 'string' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 500 } },
        ],
        responses: { '200': ok('Entries', { type: 'array', items: ref('TaxonomyAuditEntry') }), ...errorResponses },
      },
    },
  },
};
