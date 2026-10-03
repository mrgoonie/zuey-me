import type { OpenApiFragment } from '../openapi/types';
import { adminSecurity, errorResponses } from '../openapi/types';

const TAG = 'AI Workflows';
const json = (ref: string) => ({ 'application/json': { schema: { $ref: `#/components/schemas/${ref}` } } });
const ok = (schema: Record<string, unknown>, description = 'OK') => ({
  description,
  content: {
    'application/json': {
      schema: { type: 'object', properties: { success: { type: 'boolean', const: true }, data: schema } },
    },
  },
});
const errorRef = { content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };
const notFound = { '404': { description: 'Workflow not found (or not published)', ...errorRef } };
const conflict = { '409': { description: 'revision_conflict (error.current_revision) or slug_taken', ...errorRef } };
const slugParam = { name: 'slug', in: 'path', required: true, schema: { type: 'string', pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$' } };
const workflowRef = { $ref: '#/components/schemas/Workflow' };

export const workflowsOpenApi: OpenApiFragment = {
  tag: {
    name: TAG,
    description:
      "Zuey's AI workflows. Writes only touch the draft and require expected_revision (optimistic concurrency). Publishing copies the draft into a public snapshot, requires confirm: true and is blocked when secrets/PII are detected.",
  },
  paths: {
    '/api/v1/workflows': {
      get: {
        tags: [TAG],
        summary: 'List workflows',
        description: 'Public: published snapshots only. include_drafts=1 requires admin and returns drafts with revision and findings.',
        parameters: [{ name: 'include_drafts', in: 'query', required: false, schema: { type: 'string', enum: ['1', 'true'] } }],
        responses: { '200': ok({ type: 'array', items: workflowRef }), '401': errorResponses['401'], '403': errorResponses['403'] },
      },
      post: {
        tags: [TAG],
        summary: 'Create a workflow draft',
        description: 'expected_revision must be 0. Returns secret findings; findings do not block saving a draft.',
        security: adminSecurity,
        requestBody: { required: true, content: json('WorkflowInput') },
        responses: { '201': ok(workflowRef, 'Created'), ...errorResponses, ...conflict },
      },
    },
    '/api/v1/workflows/{slug}': {
      get: {
        tags: [TAG],
        summary: 'Get a workflow',
        description: 'Public: published snapshot. include_drafts=1 (admin) returns the current draft.',
        parameters: [slugParam, { name: 'include_drafts', in: 'query', required: false, schema: { type: 'string' } }],
        responses: { '200': ok(workflowRef), '401': errorResponses['401'], '403': errorResponses['403'], ...notFound },
      },
      put: {
        tags: [TAG],
        summary: 'Update the workflow draft',
        description: 'Partial update of the draft; slug is immutable. The public snapshot is unchanged until republished.',
        security: adminSecurity,
        parameters: [slugParam],
        requestBody: { required: true, content: json('WorkflowInput') },
        responses: { '200': ok(workflowRef), ...errorResponses, ...notFound, ...conflict },
      },
      delete: {
        tags: [TAG],
        summary: 'Soft-delete a workflow',
        description: 'expected_revision in the JSON body or the ?expected_revision query parameter.',
        security: adminSecurity,
        parameters: [slugParam, { name: 'expected_revision', in: 'query', required: false, schema: { type: 'integer' } }],
        responses: {
          '200': ok({ type: 'object', properties: { slug: { type: 'string' }, deleted: { type: 'boolean' }, revision: { type: 'integer' } } }),
          ...errorResponses,
          ...notFound,
          ...conflict,
        },
      },
    },
    '/api/v1/workflows/{slug}/publish': {
      post: {
        tags: [TAG],
        summary: 'Publish the current draft',
        security: adminSecurity,
        parameters: [slugParam],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['expected_revision', 'confirm'],
                properties: { expected_revision: { type: 'integer' }, confirm: { type: 'boolean', const: true } },
              },
            },
          },
        },
        responses: {
          '200': ok(workflowRef),
          ...errorResponses,
          ...notFound,
          ...conflict,
          '422': { description: 'secret_detected; error.findings lists SecretFinding items', ...errorRef },
        },
      },
    },
  },
  schemas: {
    SecretFinding: {
      type: 'object',
      required: ['field', 'kind', 'excerpt'],
      properties: {
        field: { type: 'string', example: 'steps[1].detail' },
        kind: {
          type: 'string',
          enum: ['openai_key', 'github_token', 'aws_access_key', 'slack_token', 'private_key', 'bearer_token', 'home_path', 'email'],
        },
        excerpt: { type: 'string', description: 'Masked excerpt; never the full secret' },
      },
    },
    WorkflowInput: {
      type: 'object',
      required: ['expected_revision'],
      description: 'For create: name, slug, summary, trigger, steps and expected_revision=0 are required. For update: any subset plus expected_revision.',
      properties: {
        expected_revision: { type: 'integer', minimum: 0 },
        name: { type: 'string', maxLength: 120 },
        slug: { type: 'string', maxLength: 80, pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$' },
        summary: { type: 'string', maxLength: 500 },
        tools: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 60 } },
        trigger: { type: 'string', maxLength: 500 },
        steps: {
          type: 'array',
          minItems: 1,
          maxItems: 30,
          items: {
            type: 'object',
            required: ['title'],
            properties: { title: { type: 'string', maxLength: 160 }, detail: { type: 'string', maxLength: 2000 } },
          },
        },
        metrics: {
          type: 'array',
          maxItems: 12,
          items: { type: 'object', required: ['label', 'value'], properties: { label: { type: 'string' }, value: { type: 'string' } } },
        },
        tags: { type: 'array', maxItems: 12, items: { type: 'string', maxLength: 40 } },
      },
    },
    Workflow: {
      type: 'object',
      description: 'Public responses contain the content fields plus status=published and published_at. Admin responses add id, revision, published snapshot, has_unpublished_changes and findings.',
      properties: {
        name: { type: 'string' },
        slug: { type: 'string' },
        summary: { type: 'string' },
        tools: { type: 'array', items: { type: 'string' } },
        trigger: { type: 'string' },
        steps: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, detail: { type: 'string' } } } },
        metrics: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, value: { type: 'string' } } } },
        tags: { type: 'array', items: { type: 'string' } },
        status: { type: 'string', enum: ['draft', 'published'] },
        published_at: { type: 'string', format: 'date-time', nullable: true },
        id: { type: 'string' },
        revision: { type: 'integer' },
        created_at: { type: 'string', format: 'date-time' },
        updated_at: { type: 'string', format: 'date-time' },
        published: { type: 'object', nullable: true, description: 'Current public snapshot (admin only)' },
        has_unpublished_changes: { type: 'boolean' },
        findings: { type: 'array', items: { $ref: '#/components/schemas/SecretFinding' } },
      },
    },
  },
};
