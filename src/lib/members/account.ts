import type { D1DatabaseLike } from '../../db/store';
import type { RuntimeEnv } from '../../env';
import type { APIContext, APIRoute } from 'astro';
import { AppError, errorResponse, readJsonObject } from '../http';
import { dodoCardPlans } from '../payments/dodo';
import { missingBillingConfig } from './billing';
import type { Entitlement, PlanId, PlanPrice } from './plans';
import { PLANS, parseUsdVndRate, planPrices } from './plans';
import type { CredentialVia, Principal } from './policy';
import { resolvePrincipal } from './policy';
import type { Row } from './runtime';
import { requireMembersDb, str } from './runtime';
import type { UserRecord } from './users';

/** Personal responses must never be stored by shared caches. */
export const NO_STORE = { 'Cache-Control': 'private, no-store' };

export interface MemberRequest {
  env: RuntimeEnv;
  d1: D1DatabaseLike;
  principal: Principal;
}

/** Common preamble for membership routes: D1 + the central principal. */
export async function memberRequest(context: Pick<APIContext, 'request' | 'locals'>): Promise<MemberRequest> {
  const env = context.locals.runtime?.env ?? {};
  const d1 = requireMembersDb(env);
  return { env, d1, principal: await resolvePrincipal(context.request, env) };
}

/** Wraps a membership route: resolves D1 + principal and maps thrown AppErrors to the JSON envelope. */
export function memberRoute(handler: (context: APIContext, m: MemberRequest) => Promise<Response>): APIRoute {
  return async context => {
    try {
      return await handler(context, await memberRequest(context));
    } catch (err) {
      return errorResponse(err);
    }
  };
}

export async function requireJsonBody(request: Request): Promise<Record<string, unknown>> {
  const body = await readJsonObject(request);
  if (!body) throw new AppError(400, 'invalid_json', 'Body must be a JSON object');
  return body;
}

export function requireUser(p: Principal): UserRecord {
  if (!p.user) throw new AppError(403, 'member_account_required', 'This action requires a member account');
  return p.user;
}

export interface MeView {
  id: string;
  email: string;
  email_verified: boolean;
  name: string | null;
  avatar_url: string | null;
  locale: string;
  created_at: string;
  is_admin: boolean;
  plans: PlanId[];
  entitlements: Entitlement[];
  identities: { provider: string; email: string | null; created_at: string }[];
  /** How this request authenticated (session or personal API key) and the key's scopes, if any. */
  auth: { via: CredentialVia; scopes: string[] | null };
}

export async function buildMeView(d1: D1DatabaseLike, p: Principal): Promise<MeView> {
  const user = requireUser(p);
  const { results } = await d1.prepare('SELECT provider, email, created_at FROM user_identities WHERE user_id = ? ORDER BY created_at').bind(user.id).all<Row>();
  return {
    id: user.id,
    email: user.email,
    email_verified: user.email_verified_at !== null,
    name: user.name,
    avatar_url: user.avatar_url,
    locale: user.locale,
    created_at: user.created_at,
    is_admin: p.kind === 'admin',
    plans: p.plans,
    entitlements: p.entitlements,
    identities: (results ?? []).map(r => ({ provider: str(r, 'provider'), email: typeof r.email === 'string' ? r.email : null, created_at: str(r, 'created_at') })),
    auth: { via: p.via, scopes: p.scopes },
  };
}

export interface PlansCatalog {
  currency_note: string;
  billing_configured: boolean;
  missing: string[];
  usd_vnd_rate: number | null;
  months: number[];
  /** Plans purchasable as a monthly USD card subscription (Dodo Payments); empty when not configured. */
  card_plans: PlanId[];
  plans: {
    id: PlanId;
    name: string;
    tagline: string;
    price_usd_cents: number;
    interval: 'month';
    entitlements: Entitlement[];
    features: string[];
    prices: PlanPrice[];
  }[];
}

export function plansCatalog(env: RuntimeEnv): PlansCatalog {
  const rate = parseUsdVndRate(env);
  const missing = missingBillingConfig(env);
  return {
    currency_note: 'Prices are monthly in USD. SePay bank transfer charges VND = USD × USD_VND_RATE rounded up to 1,000 VND per month, prepaid for 1, 3, 6 or 12 months without discounts. International cards (Dodo Payments) renew monthly in USD until cancelled.',
    billing_configured: missing.length === 0,
    missing,
    usd_vnd_rate: rate,
    months: [1, 3, 6, 12],
    card_plans: dodoCardPlans(env),
    plans: PLANS.map(plan => ({ ...plan, prices: planPrices(plan, rate) })),
  };
}
