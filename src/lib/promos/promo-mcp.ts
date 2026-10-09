import { AppError, getString } from '../http';
import type { McpContext, McpToolModule } from '../mcp/types';
import type { Principal } from '../members/policy';
import { requireCan, resolvePrincipal } from '../members/policy';
import { principalActor } from '../taxonomy/admin';
import { listInvoiceRequests, markInvoiceIssued, parseInvoiceStatus } from './invoice-requests';
import { INVOICE_STATUS_FILTER, PROMO_INPUT_PROPERTIES } from './promo-admin-schemas';
import { createPromo, updatePromo } from './promo-codes';
import { getPromoWithStats, listPromoRedemptions, listPromosWithStats } from './promo-redemptions';

/** Admin MCP tools for promo codes and business invoice requests (same rules as the REST endpoints). */
async function requireAdminPrincipal(ctx: McpContext): Promise<{ actor: string }> {
  const p: Principal = ctx.principal ? await ctx.principal() : await resolvePrincipal(ctx.request, { ...ctx.env, DB: ctx.d1 ?? ctx.env.DB });
  requireCan(p, 'admin');
  return { actor: principalActor(p) };
}

function requireDb(ctx: McpContext): NonNullable<McpContext['d1']> {
  const d1 = ctx.d1 ?? ctx.env.DB;
  if (!d1) throw new AppError(503, 'database_unavailable', 'Promo codes require the D1 database binding (DB)');
  return d1;
}

function requiredString(args: Record<string, unknown>, field: string): string {
  const value = getString(args, field)?.trim();
  if (!value) throw new AppError(400, 'invalid_field', `${field} is required`, { field });
  return value;
}

const PROMO_TOOLS = new Set(['promo_code_list', 'promo_code_create', 'promo_code_update', 'promo_code_redemptions', 'invoice_request_list', 'invoice_request_mark_issued']);

export const promosMcpModule: McpToolModule = {
  tools: [
    {
      name: 'promo_code_list',
      description: 'Admin: promo codes (newest first) with uses (redeemed, reserved by open checkouts, remaining) and revenue/discount in VND and USD cents. Optional q (code/label search) and status.',
      inputSchema: { type: 'object', properties: { q: { type: 'string' }, status: { type: 'string', enum: ['active', 'disabled'] }, limit: { type: 'integer', minimum: 1, maximum: 500 } } },
    },
    {
      name: 'promo_code_create',
      description: 'Admin: create a percent-off promo code. Required: code, percent. Never stacks with a referral discount (the larger percent applies; a tie goes to the referral). 409 code_taken when a promo or referral code already has the name.',
      inputSchema: { type: 'object', properties: PROMO_INPUT_PROPERTIES, required: ['code', 'percent'] },
    },
    {
      name: 'promo_code_update',
      description: 'Admin: change a promo code by id (pass only the fields to change; status=disabled stops it). A code that was used cannot be renamed.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' }, ...PROMO_INPUT_PROPERTIES }, required: ['id'] },
    },
    {
      name: 'promo_code_redemptions',
      description: 'Admin: orders that used a promo code (by id): order code, kind, buyer email, amounts before/after, paid amount, status (reserved, redeemed, released, expired).',
      inputSchema: { type: 'object', properties: { id: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 1000 } }, required: ['id'] },
    },
    {
      name: 'invoice_request_list',
      description: 'Admin: business (VAT) invoice requests from SePay checkouts: tax ID, invoice email, order code, amount, status. Default status requested (paid, invoice not issued yet).',
      inputSchema: { type: 'object', properties: { status: INVOICE_STATUS_FILTER } },
    },
    {
      name: 'invoice_request_mark_issued',
      description: 'Admin: record that the invoice for a paid request was issued (invoice_no from the e-invoice system). Repeating it updates the number.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' }, invoice_no: { type: 'string', maxLength: 64 }, note: { type: 'string', maxLength: 500 } }, required: ['id', 'invoice_no'] },
    },
  ],

  async call(name, args, ctx) {
    if (!PROMO_TOOLS.has(name)) throw new AppError(404, 'unknown_tool', `Unknown tool ${name}`);
    const { actor } = await requireAdminPrincipal(ctx);
    const d1 = requireDb(ctx);
    switch (name) {
      case 'promo_code_list':
        return { promo_codes: await listPromosWithStats(d1, { q: getString(args, 'q') ?? null, status: getString(args, 'status') ?? null, limit: args.limit }) };
      case 'promo_code_create':
        return getPromoWithStats(d1, (await createPromo(d1, args, actor)).id);
      case 'promo_code_update': {
        const { id, ...patch } = args;
        if (typeof id !== 'string' || !id.trim()) throw new AppError(400, 'invalid_field', 'id is required', { field: 'id' });
        return getPromoWithStats(d1, (await updatePromo(d1, id.trim(), patch)).id);
      }
      case 'promo_code_redemptions': {
        const promo = await getPromoWithStats(d1, requiredString(args, 'id'));
        const limit = typeof args.limit === 'number' && Number.isInteger(args.limit) ? Math.min(Math.max(args.limit, 1), 1000) : 200;
        return { promo_code: promo, redemptions: await listPromoRedemptions(d1, promo.id, limit) };
      }
      case 'invoice_request_list': {
        const status = args.status === undefined ? 'requested' : parseInvoiceStatus(args.status);
        return { invoice_requests: await listInvoiceRequests(d1, { status }) };
      }
      default:
        return markInvoiceIssued(d1, requiredString(args, 'id'), args, actor);
    }
  },
};
