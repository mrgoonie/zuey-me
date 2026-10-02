/// <reference path="../.astro/types.d.ts" />
import type { D1DatabaseLike } from './db/store';

/** Minimal shape of the Cloudflare Workers AI binding used by this app. */
export interface WorkersAiLike {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

export interface RuntimeEnv {
  DB?: D1DatabaseLike;
  AI?: WorkersAiLike;
  PUBLIC_SITE_URL?: string;
  PUBLIC_POSTHOG_KEY?: string;
  PUBLIC_POSTHOG_HOST?: string;
  ADMIN_MASTER_TOKEN?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  // Zuey Reads
  ANYMD_API_KEY?: string;
  READS_SUMMARY_MODEL?: string;
  // Booking, payments, email
  GOOGLE_CALENDAR_REFRESH_TOKEN?: string;
  GOOGLE_CALENDAR_ID?: string;
  SEPAY_WEBHOOK_API_KEY?: string;
  SEPAY_BANK_ACCOUNT?: string;
  SEPAY_BANK_CODE?: string;
  CONSULTATION_PRICE_VND?: string;
  RESEND_API_KEY?: string;
  RESEND_FROM?: string;
  // Rich blocks
  SURVEY_HASH_SALT?: string;
  // Membership & billing
  /** Comma-separated verified emails that are admins (default: the two owner addresses). */
  ADMIN_EMAILS?: string;
  /** Salt for hashing client IPs used by sign-in rate limits. */
  MEMBER_HASH_SALT?: string;
  /** VND per 1 USD used to price membership orders (rounded up to 1,000 VND). */
  USD_VND_RATE?: string;
  /** SePay user API token for admin reconciliation of recent bank transactions. */
  SEPAY_API_TOKEN?: string;
  // Card payments: Dodo Payments (membership subscriptions, USD)
  DODO_API_KEY?: string;
  /** Standard Webhooks signing secret (`whsec_…`) of the /api/webhooks/dodo endpoint. */
  DODO_WEBHOOK_SECRET?: string;
  DODO_PRODUCT_KNOWLEDGES?: string;
  DODO_PRODUCT_AI?: string;
  DODO_PRODUCT_COMBO?: string;
  DODO_PRODUCT_COMMUNITY?: string;
  /** https://test.dodopayments.com (test mode) or https://live.dodopayments.com (default). */
  DODO_API_BASE?: string;
  // Card payments: PayPal Business (consultation booking, USD)
  PAYPAL_CLIENT_ID?: string;
  PAYPAL_CLIENT_SECRET?: string;
  /** Id of the webhook registered for /api/webhooks/paypal (used by verify-webhook-signature). */
  PAYPAL_WEBHOOK_ID?: string;
  /** https://api-m.sandbox.paypal.com (sandbox) or https://api-m.paypal.com (default). */
  PAYPAL_API_BASE?: string;
  // MCP over OAuth
  /** Extra comma-separated browser origins allowed to call /mcp (same origin and loopback are always allowed). */
  MCP_ALLOWED_ORIGINS?: string;
  // Zuey AI (Dewee gateway)
  DEWEE_GATEWAY_URL?: string;
  DEWEE_GATEWAY_TOKEN?: string;
  DEWEE_AGENT_KEY?: string;
  /** Zuey AI requests per member per month (Asia/Saigon month); default 300. */
  AI_MONTHLY_REQUEST_LIMIT?: string;
  /** Optional blended USD per million tokens used for chat cost estimates. */
  AI_EST_COST_USD_PER_MTOK?: string;
  /** Comma-separated hosts (`api.example.com` or `*.example.com`) interactive blocks may GET via /api/v1/sandbox/fetch. */
  SANDBOX_FETCH_ALLOWLIST?: string;
}

declare global {
  namespace App {
    interface Locals {
      runtime?: {
        env?: RuntimeEnv;
      };
    }
  }
}
