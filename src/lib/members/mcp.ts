import type { McpContext, McpToolModule } from '../mcp/types';
import { AppError, getNumber, getString } from '../http';
import { buildMeView, plansCatalog } from './account';
import { createOrder, getOrderFor, toOrderView } from './billing';
import { listMembers } from './directory';
import { BILLING_MONTHS, PLAN_IDS } from './plans';
import type { Principal } from './policy';
import { can, requireCan, requireUserId, resolvePrincipal } from './policy';
import { getEntitlements, listSubscriptions } from './subscriptions';

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
      description: 'Member: create a SePay bank-transfer order (scope checkout:write). Returns the order code and VietQR transfer details; nothing is charged until the transfer arrives.',
      inputSchema: {
        type: 'object',
        properties: { plan: { type: 'string', enum: PLAN_IDS }, months: { type: 'integer', enum: [...BILLING_MONTHS] } },
        required: ['plan'],
      },
    },
    {
      name: 'billing_order_get', description: 'Member: status of one of your orders by code (scope billing:read).',
      inputSchema: { type: 'object', properties: { code: { type: 'string', description: 'Order code, e.g. ZSB7K2M9QXA' } }, required: ['code'] },
    },
    { name: 'subscription_get', description: 'Member: your plans, period end dates and effective entitlements (scope billing:read).', inputSchema: { type: 'object', properties: {} } },
    {
      name: 'members_list', description: 'Admin: list/search members by email or name.',
      inputSchema: { type: 'object', properties: { q: { type: 'string' }, limit: { type: 'integer' }, offset: { type: 'integer' } } },
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
        const order = await createOrder(requireDb(ctx), ctx.env, userId, { plan: args.plan, months: args.months ?? 1 }, ctx.request);
        const view = toOrderView(order, ctx.env);
        return { ...view, status_url: `${new URL(ctx.request.url).origin}/billing/${view.code}` };
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
        const d1 = requireDb(ctx);
        const effective = await getEntitlements(d1, userId);
        return { subscriptions: await listSubscriptions(d1, userId), active_plans: effective.plans, entitlements: effective.entitlements };
      }
      case 'members_list': {
        const p = await principalOf(ctx);
        requireCan(p, 'admin');
        return listMembers(requireDb(ctx), ctx.env, { q: getString(args, 'q'), limit: getNumber(args, 'limit'), offset: getNumber(args, 'offset') });
      }
      default:
        throw new AppError(404, 'unknown_tool', `Unknown tool ${name}`);
    }
  },
};
