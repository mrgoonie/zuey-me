import type { D1DatabaseLike } from '../../db/store';
import type { RuntimeEnv } from '../../env';
import { base64Url, nowIso, siteUrl } from '../members/runtime';
import { timingSafeEqualStrings } from '../payments/sepay';

/**
 * Article-email subscription of a member. Every verified member is subscribed until they unsubscribe (signed link in
 * each email, no sign-in needed) or a Resend webhook suppresses the address after a hard bounce or spam complaint.
 */
export type OptOutReason = 'unsubscribe' | 'bounce' | 'complaint';

const TOKEN_PURPOSE = 'article-emails-unsubscribe:v1';

async function signature(secret: string, userId: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${TOKEN_PURPOSE}:${userId}`));
  return base64Url(new Uint8Array(mac));
}

/** Signing secret for unsubscribe links (MEMBER_HASH_SALT); null when unconfigured. */
export function unsubscribeSecret(env: RuntimeEnv): string | null {
  return env.MEMBER_HASH_SALT || null;
}

/** Long-lived token `<userId>.<hmac>` that lets the holder change only this member's article-email preference. */
export async function unsubscribeToken(secret: string, userId: string): Promise<string> {
  return `${userId}.${await signature(secret, userId)}`;
}

/** The member id of a valid token, else null. */
export async function verifyUnsubscribeToken(secret: string | null, token: unknown): Promise<string | null> {
  if (!secret || typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const userId = token.slice(0, dot);
  return (await timingSafeEqualStrings(token.slice(dot + 1), await signature(secret, userId))) ? userId : null;
}

/** Page where a member confirms unsubscribing or subscribes again. */
export function unsubscribePageUrl(env: RuntimeEnv, token: string): string {
  return `${siteUrl(env)}/unsubscribe?token=${encodeURIComponent(token)}`;
}

/** RFC 8058 one-click endpoint (List-Unsubscribe-Post) used by mailbox providers. */
export function oneClickUnsubscribeUrl(env: RuntimeEnv, token: string): string {
  return `${siteUrl(env)}/api/email/unsubscribe?token=${encodeURIComponent(token)}`;
}

export interface SubscriptionState {
  email: string;
  subscribed: boolean;
  reason: OptOutReason | null;
}

export async function getArticleEmailSubscription(db: D1DatabaseLike, userId: string): Promise<SubscriptionState | null> {
  const row = await db.prepare('SELECT email, article_emails_opt_out_at, article_emails_opt_out_reason FROM users WHERE id = ? AND deleted_at IS NULL')
    .bind(userId).first<Record<string, unknown>>();
  if (!row || typeof row.email !== 'string') return null;
  const reason = row.article_emails_opt_out_reason;
  return {
    email: row.email,
    subscribed: row.article_emails_opt_out_at === null || row.article_emails_opt_out_at === undefined,
    reason: reason === 'unsubscribe' || reason === 'bounce' || reason === 'complaint' ? reason : null,
  };
}

/** Opts a member out (keeps the first opt-out time). Returns false when the member does not exist. */
export async function optOutArticleEmails(db: D1DatabaseLike, userId: string, reason: OptOutReason): Promise<boolean> {
  const res = await db.prepare(
    'UPDATE users SET article_emails_opt_out_at = COALESCE(article_emails_opt_out_at, ?), article_emails_opt_out_reason = ? WHERE id = ? AND deleted_at IS NULL'
  ).bind(nowIso(), reason, userId).run();
  return (res.meta?.changes ?? 0) > 0;
}

/** Suppresses every live account using this address (bounce / complaint webhooks know only the address). */
export async function optOutArticleEmailsByAddress(db: D1DatabaseLike, email: string, reason: OptOutReason): Promise<number> {
  const res = await db.prepare(
    'UPDATE users SET article_emails_opt_out_at = COALESCE(article_emails_opt_out_at, ?), article_emails_opt_out_reason = ? WHERE email = ? AND deleted_at IS NULL'
  ).bind(nowIso(), reason, email.trim().toLowerCase()).run();
  return res.meta?.changes ?? 0;
}

/** Subscribes a member again (their own explicit choice on the unsubscribe page). */
export async function optInArticleEmails(db: D1DatabaseLike, userId: string): Promise<boolean> {
  const res = await db.prepare('UPDATE users SET article_emails_opt_out_at = NULL, article_emails_opt_out_reason = NULL WHERE id = ? AND deleted_at IS NULL')
    .bind(userId).run();
  return (res.meta?.changes ?? 0) > 0;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Suppression reason for a Resend event: hard bounces and spam complaints only (soft bounces are retried by Resend). */
export function suppressionReason(event: Record<string, unknown>): OptOutReason | null {
  const data = isRecord(event.data) ? event.data : {};
  if (event.type === 'email.complained') return 'complaint';
  if (event.type === 'email.bounced') {
    const bounce = isRecord(data.bounce) ? data.bounce : {};
    return bounce.type === 'Transient' ? null : 'bounce';
  }
  return null;
}
