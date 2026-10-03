import { AppError } from '../http';
import type { McpContext, McpTool, McpToolModule } from '../mcp/types';
import { resolveActor } from './access';
import {
  createWorkflow,
  deleteWorkflow,
  getAdminWorkflow,
  getPublicWorkflow,
  listAdminWorkflows,
  listPublicWorkflows,
  publishWorkflow,
  updateWorkflow,
} from './store';

const ADMIN_NOTE =
  'Requires an admin credential (admin API key on /api/mcp); the `workflows:write` OAuth scope will replace this when /mcp OAuth lands.';

const stepSchema = {
  type: 'object',
  properties: { title: { type: 'string', maxLength: 160 }, detail: { type: 'string', maxLength: 2000 } },
  required: ['title'],
};
const metricSchema = {
  type: 'object',
  properties: { label: { type: 'string' }, value: { type: 'string' } },
  required: ['label', 'value'],
};
const contentProps = {
  name: { type: 'string', maxLength: 120 },
  summary: { type: 'string', maxLength: 500 },
  tools: { type: 'array', items: { type: 'string' }, maxItems: 20 },
  trigger: { type: 'string', maxLength: 500 },
  steps: { type: 'array', items: stepSchema, minItems: 1, maxItems: 30 },
  metrics: { type: 'array', items: metricSchema, maxItems: 12 },
  tags: { type: 'array', items: { type: 'string' }, maxItems: 12 },
};
const slugProp = { type: 'string', description: 'Lowercase kebab-case slug' };

const tools: McpTool[] = [
  {
    name: 'workflow_list',
    description:
      "List Zuey's AI workflows. Without admin credentials only published snapshots are returned; admins may pass include_drafts=true to see drafts, revisions and secret findings.",
    inputSchema: { type: 'object', properties: { include_drafts: { type: 'boolean' } } },
  },
  {
    name: 'workflow_get',
    description:
      'Get one workflow by slug. Public callers see the published snapshot only (drafts are not found); admins may pass include_drafts=true to read the current draft and revision.',
    inputSchema: { type: 'object', properties: { slug: slugProp, include_drafts: { type: 'boolean' } }, required: ['slug'] },
  },
  {
    name: 'workflow_create',
    description: `Create a workflow DRAFT (never public until workflow_publish). expected_revision must be 0. Secrets in the draft are reported as findings and block publishing. ${ADMIN_NOTE}`,
    inputSchema: {
      type: 'object',
      properties: { ...contentProps, slug: slugProp, expected_revision: { type: 'integer', enum: [0] } },
      required: ['name', 'slug', 'summary', 'trigger', 'steps', 'expected_revision'],
    },
  },
  {
    name: 'workflow_update',
    description: `Update a workflow DRAFT only (the public snapshot is unchanged until republished). Requires expected_revision equal to the current revision, otherwise fails with revision_conflict. Slug is immutable. ${ADMIN_NOTE}`,
    inputSchema: {
      type: 'object',
      properties: { ...contentProps, slug: slugProp, expected_revision: { type: 'integer' } },
      required: ['slug', 'expected_revision'],
    },
  },
  {
    name: 'workflow_delete',
    description: `Soft-delete a workflow (draft and public snapshot). Requires expected_revision. ${ADMIN_NOTE}`,
    inputSchema: {
      type: 'object',
      properties: { slug: slugProp, expected_revision: { type: 'integer' } },
      required: ['slug', 'expected_revision'],
    },
  },
  {
    name: 'workflow_publish',
    description: `Publish the current draft as the public snapshot. Requires confirm: true and expected_revision. Blocked with secret_detected (422) when the draft contains API keys, tokens, private keys, home paths or emails. ${ADMIN_NOTE}`,
    inputSchema: {
      type: 'object',
      properties: { slug: slugProp, expected_revision: { type: 'integer' }, confirm: { type: 'boolean', const: true } },
      required: ['slug', 'expected_revision', 'confirm'],
    },
  },
];

function slugArg(args: Record<string, unknown>): string {
  if (typeof args.slug !== 'string') throw new AppError(400, 'invalid_params', 'slug is required');
  return args.slug;
}

async function adminActor(ctx: McpContext) {
  await ctx.requireAdmin();
  return resolveActor(ctx.request, ctx.d1);
}

export const workflowsMcpModule: McpToolModule = {
  tools,
  async call(name, args, ctx) {
    switch (name) {
      case 'workflow_list':
        if (args.include_drafts === true && (await ctx.isAdmin())) return listAdminWorkflows(ctx.d1);
        return listPublicWorkflows(ctx.d1);
      case 'workflow_get':
        if (args.include_drafts === true && (await ctx.isAdmin())) return getAdminWorkflow(slugArg(args), ctx.d1);
        return getPublicWorkflow(slugArg(args), ctx.d1);
      case 'workflow_create':
        return createWorkflow(args, await adminActor(ctx), ctx.d1);
      case 'workflow_update': {
        const actor = await adminActor(ctx);
        return updateWorkflow(slugArg(args), args, actor, ctx.d1);
      }
      case 'workflow_delete': {
        const actor = await adminActor(ctx);
        return deleteWorkflow(slugArg(args), args.expected_revision, actor, ctx.d1);
      }
      case 'workflow_publish': {
        const actor = await adminActor(ctx);
        return publishWorkflow(slugArg(args), args, actor, ctx.d1);
      }
      default:
        throw new AppError(404, 'unknown_tool', `Unknown tool: ${name}`);
    }
  },
};
