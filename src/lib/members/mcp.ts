import type { McpContext, McpToolModule } from '../mcp/types';
import { AppError, getNumber, getString } from '../http';
import { buildMeView, plansCatalog } from './account';
import { CHECKOUT_PROVIDERS, createMemberCheckout, getOrderFor, subscriptionSummary, toOrderView } from './billing';
import { MAX_NOTE_LENGTH, RESOLVE_ACTIONS, adminLabel, listBillingAttention, parseResolveInput, resolveBillingOrder } from './billing-attention';
import { listMembers } from './directory';
import { BILLING_MONTHS, PLAN_IDS } from './plans';
import type { Principal } from './policy';
import { can, requireCan, requireUserId, resolvePrincipal } from './policy';

async function principalOf(ctx: McpContext): Promise<Principal> {
  return ctx.principal ? ctx.principal() : resolvePrincipal(ctx.request, { ...ctx.env, DB: ctx.d1 ?? ctx.env.DB });
}

function requireDb(ctx: McpContext): NonNullable<McpContext['d1']> {
  const d1 = ctx.d1 ?? ctx.env.DB;
  if (!d1) throw new AppError(503, 'database_unavailable', 'Membership requires the D1 database binding (DB)');
  return d1;
}

/**
 * Member tools authenticate with a personal API key (`Authorization: Bearer zk_…`) and are limited
 * to that key's scopes plus the member's current plan; admin tools need an admin credential.
 */
export const membersMcpModule: McpToolModule = {
  tools: [
    { name: 'me_get', description: 'Member: your profile, active plans and entitlements (scope account:read).', inputSchema: { type: 'object', properties: {} } },
    { name: 'plans_list', description: 'List membership plans (Knowledges $9, Zuey AI $9, Kết hợp $19, Cộng đồng $29 per month) with entitlements and VND prepay prices.', inputSchema: { type: 'object', properties: {} } },
    {
      name: 'billing_checkout_create',
      description: 'Member: start a purchase (scope checkout:write). provider "sepay" (default) creates a prepaid VND bank-transfer order with VietQR details; provider "dodo" starts a monthly USD card subscription and returns checkout_url for the member to open. Nothing is charged until the provider confirms; follow status_url for the real state.',
      inputSchema: {
        type: 'object',
        properties: {
          plan: { type: 'string', enum: PLAN_IDS },
          months: { type: 'integer', enum: [...BILLING_MONTHS], description: 'SePay prepay length; card subscriptions are monthly (1)' },
          provider: { type: 'string', enum: CHECKOUT_PROVIDERS, default: 'sepay' },
        },
        required: ['plan'],
      },
    },
    {
      name: 'billing_order_get', description: 'Member: status of one of your orders by code (scope billing:read).',
      inputSchema: { type: 'object', properties: { code: { type: 'string', description: 'Order code, e.g. ZSB7K2M9QXA' } }, required: ['code'] },
    },
    { name: 'subscription_get', description: 'Member: your plans, period end dates, card subscriptions (provider, status, renewal date) and effective entitlements (scope billing:read).', inputSchema: { type: 'object', properties: {} } },
    {
      name: 'members_list', description: 'Admin: list/search members by email or name.',
      inputSchema: { type: 'object', properties: { q: { type: 'string' }, limit: { type: 'integer' }, offset: { type: 'integer' } } },
    },
    {
      name: 'billing_attention_list',
      description: 'Admin: payments needing attention — SePay orders (late, underpaid or repeated transfers) and Dodo card subscriptions (metadata or price mismatch) with reason, amounts, member email and timestamps. Card rows are read-only.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'billing_order_resolve',
      description: 'Admin: resolve a flagged SePay order. "activate" grants/extends the plan exactly like a paid order and marks it paid; "dismiss" closes it without access. Repeating an action is a no-op; the admin and note are written to the member activity log.',
      inputSchema: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'Order code, e.g. ZSB7K2M9QXA' },
          action: { type: 'string', enum: RESOLVE_ACTIONS },
          note: { type: 'string', maxLength: MAX_NOTE_LENGTH },
        },
        required: ['code', 'action'],
      },
    },
  ],

  async call(name, args, ctx) {
    switch (name) {
      case 'plans_list':
        return plansCatalog(ctx.env);
      case 'me_get': {
        const p = await principalOf(ctx);
        requireCan(p, 'account:read');
        return buildMeView(requireDb(ctx), p);
      }
      case 'billing_checkout_create': {
        const p = await principalOf(ctx);
        const userId = requireUserId(p, 'checkout:write');
        const body: Record<string, unknown> = { plan: args.plan, provider: args.provider ?? 'sepay' };
        if (args.months !== undefined) body.months = args.months;
        else if (body.provider !== 'dodo') body.months = 1;
        return createMemberCheckout(requireDb(ctx), ctx.env, userId, body, ctx.request);
      }
      case 'billing_order_get': {
        const p = await principalOf(ctx);
        const isAdmin = can(p, 'admin');
        if (!isAdmin) requireCan(p, 'billing:read');
        const code = getString(args, 'code');
        if (!code) throw new AppError(400, 'invalid_field', 'code is required', { field: 'code' });
        return toOrderView(await getOrderFor(requireDb(ctx), code, { userId: p.userId, isAdmin }), ctx.env);
      }
      case 'subscription_get': {
        const p = await principalOf(ctx);
        const userId = requireUserId(p, 'billing:read');
        return subscriptionSummary(requireDb(ctx), ctx.env, userId);
      }
      case 'members_list': {
        const p = await principalOf(ctx);
        requireCan(p, 'admin');
        return listMembers(requireDb(ctx), ctx.env, { q: getString(args, 'q'), limit: getNumber(args, 'limit'), offset: getNumber(args, 'offset') });
      }
      case 'billing_attention_list': {
        const p = await principalOf(ctx);
        requireCan(p, 'admin');
        return listBillingAttention(requireDb(ctx));
      }
      case 'billing_order_resolve': {
        const p = await principalOf(ctx);
        requireCan(p, 'admin');
        const code = getString(args, 'code');
        if (!code) throw new AppError(400, 'invalid_field', 'code is required', { field: 'code' });
        return resolveBillingOrder(requireDb(ctx), ctx.env, code, parseResolveInput(args), adminLabel(p), ctx.request);
      }
      default:
        throw new AppError(404, 'unknown_tool', `Unknown tool ${name}`);
    }
  },
};
