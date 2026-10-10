/// <reference path="../.astro/types.d.ts" />
import type { D1DatabaseLike } from './db/store';

/** Minimal shape of the Cloudflare Workers AI binding used by this app. */
export interface WorkersAiLike {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

/** Object read back from R2 (only the members this app uses). */
export interface R2ObjectBodyLike {
  body: ReadableStream;
  size: number;
  httpEtag?: string;
  httpMetadata?: { contentType?: string };
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** Minimal shape of a Cloudflare R2 bucket binding used by this app (referral KYC images, private course files). */
export interface R2BucketLike {
  get(key: string, options?: { range?: { offset: number; length?: number } }): Promise<R2ObjectBodyLike | null>;
  put(key: string, value: ReadableStream | ArrayBuffer | Uint8Array | string, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  delete(keys: string | string[]): Promise<void>;
}

export interface RuntimeEnv {
  DB?: D1DatabaseLike;
  /** Private bucket `zuey-referral-kyc`: referrers' national-ID images, deleted when an admin decides. */
  REFERRAL_KYC?: R2BucketLike;
  AI?: WorkersAiLike;
  /** Private R2 bucket with course audio and downloadable files (never public). */
  COURSE_FILES?: R2BucketLike;
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
  /** Workers AI model that cleans up Zueytube transcripts when OpenRouter is absent or fails (default @cf/meta/llama-3.3-70b-instruct-fp8-fast). */
  VIDEOS_REWRITE_MODEL?: string;
  /** OpenRouter key; when set it is the first provider for Zueytube transcript cleanup. */
  OPENROUTER_API_KEY?: string;
  /** OpenRouter model for transcript cleanup (default google/gemma-4-31b-it). */
  VIDEOS_REWRITE_OPENROUTER_MODEL?: string;
  /** Extra proper nouns for transcript cleanup: "Name" or "Name = heard1 | heard2", comma- or newline-separated. */
  VIDEOS_REWRITE_GLOSSARY?: string;
  // Booking, payments, email
  GOOGLE_CALENDAR_REFRESH_TOKEN?: string;
  GOOGLE_CALENDAR_ID?: string;
  SEPAY_WEBHOOK_API_KEY?: string;
  SEPAY_BANK_ACCOUNT?: string;
  SEPAY_BANK_CODE?: string;
  CONSULTATION_PRICE_VND?: string;
  RESEND_API_KEY?: string;
  RESEND_FROM?: string;
  /** Svix signing secret (`whsec_…`) of the /api/webhooks/resend endpoint (bounce and complaint suppression). */
  RESEND_WEBHOOK_SECRET?: string;
  // New-article emails to members
  /** Sender for article emails (default RESEND_FROM), e.g. a dedicated `news.` subdomain verified in Resend. */
  ARTICLE_EMAIL_FROM?: string;
  ARTICLE_EMAIL_REPLY_TO?: string;
  /** Ceiling of the warm-up rolling 24-hour limit (default 2000). */
  ARTICLE_EMAIL_DAILY_CAP?: string;
  /** Asia/Ho_Chi_Minh hours without sending, "23-7" (default) or "off". */
  ARTICLE_EMAIL_QUIET_HOURS?: string;
  /** Shared secret the Cloudflare cron worker sends to the article-email dispatch endpoint. */
  CRON_SECRET?: string;
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
  /** One-time pay-what-you-want Dodo product used for every course; the checkout sets the final amount. */
  DODO_PRODUCT_COURSE?: string;
  // Courses
  /** HMAC secret for short-lived course media URLs (R2 files) and quiz/lesson tokens. */
  COURSE_MEDIA_SECRET?: string;
  /** Cloudflare Stream customer subdomain code (customer-<code>.cloudflarestream.com). */
  CF_STREAM_CUSTOMER_CODE?: string;
  /** Stream signing key id (`kid`) created with POST /stream/keys. */
  CF_STREAM_SIGNING_KEY_ID?: string;
  /** Stream signing key as a JWK JSON string (the `jwk` field of the key response, base64-decoded). */
  CF_STREAM_SIGNING_JWK?: string;
  /** GitHub token with admin access to the private course repositories (invites collaborators). */
  GITHUB_COURSES_TOKEN?: string;
  // Card payments: PayPal Business (consultation booking, USD)
  PAYPAL_CLIENT_ID?: string;
  PAYPAL_CLIENT_SECRET?: string;
  /** Id of the webhook registered for /api/webhooks/paypal (used by verify-webhook-signature). */
  PAYPAL_WEBHOOK_ID?: string;
  /** https://api-m.sandbox.paypal.com (sandbox) or https://api-m.paypal.com (default). */
  PAYPAL_API_BASE?: string;
  // Jev relevance layer (TypeSafe AI): reranks knowledge search and Zuey AI grounding when set.
  TYPESAFEAI_API_KEY?: string;
  /** https://api.typesafe.ai (default). */
  TYPESAFE_API_BASE?: string;
  /** Jev model id; default jev-latest. */
  TYPESAFE_MODEL?: string;
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
  // Telegram community ($29 plan): bot must be an admin of both groups with invite + ban rights.
  TELEGRAM_BOT_TOKEN?: string;
  /** Numeric chat id of the private English group (e.g. -1001234567890). */
  TELEGRAM_GROUP_EN_ID?: string;
  /** Numeric chat id of the private Vietnamese group. */
  TELEGRAM_GROUP_VI_ID?: string;
  /** secret_token passed to setWebhook; Telegram echoes it in X-Telegram-Bot-Api-Secret-Token. */
  TELEGRAM_WEBHOOK_SECRET?: string;
  /** Chat id of the admin group that gets new-order notices from the SePay webhook (sent with TELEGRAM_BOT_TOKEN). */
  TELEGRAM_GROUP_ID_SEPAY_NOTI?: string;
  /** Discord channel webhook URL that also gets the new-order notices (secret: anyone holding it can post). */
  DISCORD_WEBHOOK_SEPAY_NOTI?: string;
}

declare global {
  namespace App {
    interface Locals {
      runtime?: {
        env?: RuntimeEnv;
        /** Cloudflare execution context: work passed to waitUntil keeps running after the response. */
        ctx?: { waitUntil(promise: Promise<unknown>): void };
      };
    }
  }
}
