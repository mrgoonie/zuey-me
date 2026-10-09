import type { McpContext, McpToolModule } from '../mcp/types';
import { AppError, getString } from '../http';
import type { Principal } from '../members/policy';
import { requireCan, resolvePrincipal } from '../members/policy';
import { membersRuntime } from '../members/runtime';
import { principalActor } from '../taxonomy/admin';
import {
  COMMISSION_DECISIONS, adminUpdateSettings, decideCommission, listCommissions, parseCommissionDecision, updateReferrer,
} from './admin-api';
import { MAX_REFERRAL_RATE, getReferralSettings } from './config';
import { monthlyLeaderboard, parseLeaderboardMonth } from './leaderboard';
import { listPayoutProfiles } from './payout-profile-review';
import { PAYOUT_STATUSES, listPayouts, markPayoutPaid, parsePayoutStatus, parsePeriod } from './payouts';

/**
 * Admin MCP tools for the referral program. National-ID images are never returned through MCP; the
 * review list only reports whether each image is on file.
 */
async function requireAdminPrincipal(ctx: McpContext): Promise<{ actor: string }> {
  const p: Principal = ctx.principal ? await ctx.principal() : await resolvePrincipal(ctx.request, { ...ctx.env, DB: ctx.d1 ?? ctx.env.DB });
  requireCan(p, 'admin');
  return { actor: principalActor(p) };
}

function requireDb(ctx: McpContext): NonNullable<McpContext['d1']> {
  const d1 = ctx.d1 ?? ctx.env.DB;
  if (!d1) throw new AppError(503, 'database_unavailable', 'Referrals require the D1 database binding (DB)');
  return d1;
}

function requiredString(args: Record<string, unknown>, field: string): string {
  const value = getString(args, field)?.trim();
  if (!value) throw new AppError(400, 'invalid_field', `${field} is required`, { field });
  return value;
}

const SETTINGS_PROPERTIES = {
  tiers: { type: 'array', items: { type: 'object', properties: { min: { type: 'integer' }, rate: { type: 'integer' } }, required: ['min', 'rate'] }, description: 'Ascending by min, first min 0, rate 0–50' },
  hold_days: { type: 'integer', minimum: 0, maximum: 365 },
  booking_rate: { type: 'integer', minimum: 0, maximum: MAX_REFERRAL_RATE },
  payout_threshold_cents: { type: 'integer', minimum: 0 },
  vn_deduction_bp: { type: 'integer', minimum: 0, maximum: 10000, description: 'VN bank deduction ("Thuế TNCN"), basis points' },
  paypal_deduction_bp: { type: 'integer', minimum: 0, maximum: 10000, description: 'PayPal deduction ("Phí xử lý & thuế"), basis points' },
  cookie_days: { type: 'integer', minimum: 1, maximum: 365 },
};

export const referralsMcpModule: McpToolModule = {
  tools: [
    { name: 'referral_settings_get', description: 'Admin: referral program settings (tier table, hold days, booking rate, payout threshold, VN/PayPal deductions, cookie days).', inputSchema: { type: 'object', properties: {} } },
    {
      name: 'referral_settings_set', description: 'Admin: change referral settings. Pass only the fields to change; unknown fields and out-of-range values are rejected.',
      inputSchema: { type: 'object', properties: SETTINGS_PROPERTIES },
    },
    {
      name: 'referral_referrer_update',
      description: 'Admin: update a referrer by email: admin_rate_override (null clears; 0–50), admin_enabled (may refer without a plan), locked with lock_reason, or locked=false to unlock. Returns rate, tier, balances.',
      inputSchema: {
        type: 'object',
        properties: {
          email: { type: 'string' },
          admin_rate_override: { type: ['integer', 'null'], minimum: 0, maximum: MAX_REFERRAL_RATE },
          admin_enabled: { type: 'boolean' },
          locked: { type: 'boolean' },
          lock_reason: { type: 'string' },
        },
        required: ['email'],
      },
    },
    {
      name: 'referral_review_list',
      description: 'Admin: the review queues — commissions flagged by fraud signals (status review, with reasons) and payout profiles awaiting verification (ID images are never returned; has_id_front/back only).',
      inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 500 } } },
    },
    {
      name: 'referral_commission_decide',
      description: 'Admin: approve (review → approved when the hold has passed, else back to pending), reject (review/pending → blocked) or reverse (refund-style, negative ledger line if already credited) a commission.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' }, action: { type: 'string', enum: COMMISSION_DECISIONS }, note: { type: 'string', maxLength: 500 } },
        required: ['id', 'action'],
      },
    },
    {
      name: 'referral_payouts_list', description: 'Admin: referral payouts of a period (YYYY-MM) and/or status, with gross, deduction, net (USD cents, VND for bank payouts) and payee details.',
      inputSchema: { type: 'object', properties: { period: { type: 'string', pattern: '^\\d{4}-\\d{2}$' }, status: { type: 'string', enum: PAYOUT_STATUSES } } },
    },
    {
      name: 'referral_payout_mark_paid', description: 'Admin: record that a pending payout was transferred (transaction_ref = bank or PayPal reference) and email the referrer. Repeating it is a no-op.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' }, transaction_ref: { type: 'string', maxLength: 200 } }, required: ['id', 'transaction_ref'] },
    },
    {
      name: 'referral_leaderboard', description: 'Admin: monthly referral leaderboard (top 10, masked names, Asia/Saigon month; default current month).',
      inputSchema: { type: 'object', properties: { month: { type: 'string', pattern: '^\\d{4}-\\d{2}$' } } },
    },
  ],

  async call(name, args, ctx) {
    const { actor } = await requireAdminPrincipal(ctx);
    const d1 = requireDb(ctx);
    switch (name) {
      case 'referral_settings_get':
        return getReferralSettings(d1);
      case 'referral_settings_set':
        return adminUpdateSettings(d1, args, actor);
      case 'referral_referrer_update': {
        const { email, ...patch } = args;
        if (typeof email !== 'string' || !email.trim()) throw new AppError(400, 'invalid_field', 'email is required', { field: 'email' });
        return updateReferrer(d1, email, patch, actor);
      }
      case 'referral_review_list':
        return {
          commissions: await listCommissions(d1, { status: 'review', limit: args.limit }),
          payout_profiles: await listPayoutProfiles(d1, 'submitted'),
        };
      case 'referral_commission_decide':
        return decideCommission(d1, requiredString(args, 'id'), parseCommissionDecision(args.action), actor, args.note);
      case 'referral_payouts_list':
        return { payouts: await listPayouts(d1, { period: parsePeriod(args.period), status: parsePayoutStatus(args.status) }) };
      case 'referral_payout_mark_paid':
        return markPayoutPaid(d1, ctx.env, requiredString(args, 'id'), args.transaction_ref, actor);
      case 'referral_leaderboard': {
        const month = parseLeaderboardMonth(typeof args.month === 'string' ? args.month : null, membersRuntime.now());
        return monthlyLeaderboard(d1, month);
      }
      default:
        throw new AppError(404, 'unknown_tool', `Unknown tool ${name}`);
    }
  },
};
