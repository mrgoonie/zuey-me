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
  POLAR_ACCESS_TOKEN?: string;
  POLAR_WEBHOOK_SECRET?: string;
  POLAR_CONSULTATION_PRODUCT_ID?: string;
  POLAR_API_BASE?: string;
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
