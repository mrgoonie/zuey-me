import type { D1DatabaseLike } from '../../db/store';
import type { RuntimeEnv } from '../../env';
import { AppError } from '../http';
import { getArticle } from '../blocks/articles';
import type { ArticleRecord } from '../blocks/articles';
import { isLocale } from '../i18n/locales';
import type { Locale } from '../i18n/locales';
import { RESEND_BATCH_LIMIT, sendEmailBatch } from '../integrations/resend';
import type { BatchEmailResult, BulkEmailInput } from '../integrations/resend';
import { isAdminIdentity } from '../members/admins';
import { DAY_MS, membersRuntime, sha256Hex, siteUrl } from '../members/runtime';
import { oneClickUnsubscribeUrl, unsubscribePageUrl, unsubscribeSecret, unsubscribeToken } from './article-email-subscription';
import { renderArticleEmail, withFooter } from './article-email-render';
import type { ArticleEmailBody, ArticleEmailMode } from './article-email-render';
import {
  ARTICLE_EMAIL_KIND, claimRecipients, nextRecipients, readFullMembers, recordOutcomes, releaseRecipients,
} from './article-notification-recipients';
import type { RecipientOutcome } from './article-notification-recipients';

/**
 * Sends due new-article emails. Called every few minutes by the Cloudflare cron worker (workers/scheduler).
 *
 * Deliverability safeguards:
 * - warm-up: a rolling 24-hour cap that starts at WARMUP_START_PER_DAY and doubles every day since the first article
 *   email, up to ARTICLE_EMAIL_DAILY_CAP; the most recently active members are emailed first;
 * - quiet hours (Asia/Ho_Chi_Minh): emails wait for the morning instead of landing at night;
 * - RFC 8058 one-click unsubscribe headers, and suppression of bounced / complaining addresses (Resend webhook).
 * The email always carries the latest published edition, so edits made after publishing are included.
 * Delivery is at-most-once per member (see article-notification-recipients): a failure whose outcome is unknown is
 * recorded as unconfirmed rather than retried, because a missed newsletter costs less than a duplicate one.
 */

export { ARTICLE_EMAIL_KIND };

const WARMUP_START_PER_DAY = 50;
const DEFAULT_DAILY_CAP = 2000;
const DEFAULT_QUIET_HOURS = { start: 23, end: 7 };
/** UTC offset of Asia/Ho_Chi_Minh (no daylight saving time). */
const VN_UTC_OFFSET_HOURS = 7;
/** Articles handled per run and batches per article per run (Resend allows ~2 requests per second). */
const MAX_ARTICLES_PER_RUN = 3;
const MAX_BATCHES_PER_RUN = 5;
const BATCH_PAUSE_MS = 600;
const RETRY_PAUSE_MS = 2000;
/** A run renews its lease before every batch; another run may take the article over only after it lapses. */
const LEASE_MS = 4 * 60 * 1000;

type Row = Record<string, unknown>;

export interface ArticleDispatchOutcome {
  article_id: string;
  slug: string | null;
  status: 'sent' | 'sending' | 'cancelled' | 'error';
  sent: number;
  failed: number;
  error?: string;
}

export interface DispatchResult {
  quiet_hours: boolean;
  daily_limit: number;
  sent_last_24h: number;
  articles: ArticleDispatchOutcome[];
}

export const dispatchRuntime = {
  sleep: (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms)),
};

const s = (row: Row, key: string): string => (typeof row[key] === 'string' ? (row[key] as string) : '');
const iso = (ms: number): string => new Date(ms).toISOString();

/** Parses ARTICLE_EMAIL_QUIET_HOURS ("23-7", "off"); null disables quiet hours. */
export function quietHours(env: RuntimeEnv): { start: number; end: number } | null {
  const raw = env.ARTICLE_EMAIL_QUIET_HOURS?.trim().toLowerCase();
  if (!raw) return DEFAULT_QUIET_HOURS;
  if (raw === 'off' || raw === 'none') return null;
  const m = /^(\d{1,2})\s*-\s*(\d{1,2})$/.exec(raw);
  if (!m) return DEFAULT_QUIET_HOURS;
  const start = Number(m[1]);
  const end = Number(m[2]);
  return start < 24 && end < 24 && start !== end ? { start, end } : DEFAULT_QUIET_HOURS;
}

export function isQuietHour(nowMs: number, hours: { start: number; end: number } | null): boolean {
  if (!hours) return false;
  const hour = (new Date(nowMs).getUTCHours() + VN_UTC_OFFSET_HOURS) % 24;
  return hours.start < hours.end ? hour >= hours.start && hour < hours.end : hour >= hours.start || hour < hours.end;
}

/** Warm-up limit for a rolling 24 hours: 50, 100, 200, … per day since the first article email, capped. */
export function warmupDailyLimit(firstSentMs: number | null, nowMs: number, cap: number): number {
  const days = firstSentMs === null ? 0 : Math.max(0, Math.floor((nowMs - firstSentMs) / DAY_MS));
  return Math.min(cap, WARMUP_START_PER_DAY * 2 ** Math.min(days, 20));
}

function dailyCap(env: RuntimeEnv): number {
  const n = Number(env.ARTICLE_EMAIL_DAILY_CAP);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_DAILY_CAP;
}

/** Every article-email row of the last 24 hours counts against the warm-up limit, including unconfirmed sends. */
async function sendingStats(db: D1DatabaseLike, nowMs: number): Promise<{ firstSentMs: number | null; last24h: number }> {
  const row = await db.prepare(`
    SELECT (SELECT MIN(created_at) FROM email_log WHERE kind = ? AND status = 'sent') AS first_sent,
           (SELECT COUNT(*) FROM email_log WHERE kind = ? AND created_at > ?) AS last_24h
  `).bind(ARTICLE_EMAIL_KIND, ARTICLE_EMAIL_KIND, iso(nowMs - DAY_MS)).first<Row>();
  const first = row && typeof row.first_sent === 'string' ? Date.parse(row.first_sent) : NaN;
  return { firstSentMs: Number.isFinite(first) ? first : null, last24h: row && typeof row.last_24h === 'number' ? row.last_24h : 0 };
}

/** Per-dispatch cache of rendered editions: one render per (locale, full/teaser). */
class ArticleEmailVariants {
  private editions = new Map<string, ArticleRecord | null>();
  private bodies = new Map<string, ArticleEmailBody>();
  constructor(private db: D1DatabaseLike, private env: RuntimeEnv, private slug: string, readonly primary: ArticleRecord) {}

  /** The member's locale edition when published, else the primary edition. */
  async edition(locale: string): Promise<ArticleRecord> {
    if (!isLocale(locale) || !this.primary.available_locales.includes(locale)) return this.primary;
    if (!this.editions.has(locale)) this.editions.set(locale, await getArticle(this.db, this.slug, { locale: locale as Locale, publishedOnly: true }));
    return this.editions.get(locale) ?? this.primary;
  }

  async body(rec: ArticleRecord, mode: ArticleEmailMode): Promise<ArticleEmailBody> {
    const key = `${rec.locale}:${mode}`;
    const cached = this.bodies.get(key);
    if (cached) return cached;
    const base = siteUrl(this.env);
    const body = renderArticleEmail({
      locale: rec.locale, title: rec.title, excerpt: rec.excerpt, access: rec.access, coverUrl: rec.cover_url,
      document: rec.published ?? { version: 1, blocks: [] },
      articleUrl: `${base}/articles/${encodeURIComponent(this.slug)}?lang=${rec.locale}&utm_source=email&utm_medium=article_notification`,
      pricingUrl: `${base}/pricing?utm_source=email&utm_medium=article_notification&utm_campaign=${encodeURIComponent(this.slug)}`,
      siteUrl: base, mode,
    });
    this.bodies.set(key, body);
    return body;
  }
}

/** Extends this run's lease; null when the send was cancelled meanwhile or another run holds the article. */
async function renewLease(db: D1DatabaseLike, articleId: string, lease: string): Promise<string | null> {
  const next = iso(membersRuntime.now() + LEASE_MS);
  const res = await db.prepare("UPDATE article_notifications SET locked_until = ? WHERE article_id = ? AND status = 'sending' AND locked_until = ?")
    .bind(next, articleId, lease).run();
  return res.meta?.changes ? next : null;
}

/** Releases this run's lease; a send cancelled meanwhile stays cancelled, and a lease taken over is left alone. */
async function finish(db: D1DatabaseLike, articleId: string, lease: string, status: 'sent' | 'cancelled' | 'sending', reason: string | null): Promise<void> {
  await db.prepare(`
    UPDATE article_notifications SET status = CASE WHEN status = 'sending' THEN ? ELSE status END,
      reason = CASE WHEN status = 'sending' THEN COALESCE(?, reason) ELSE reason END, locked_until = NULL, updated_at = ?
    WHERE article_id = ? AND locked_until = ?
  `).bind(status, reason, iso(membersRuntime.now()), articleId, lease).run();
}

/** Sends one batch request, retrying a transient failure once with the same idempotency key (Resend dedupes it). */
async function sendWithRetry(env: RuntimeEnv, emails: BulkEmailInput[], key: string): Promise<BatchEmailResult> {
  const first = await sendEmailBatch(env, emails, membersRuntime.fetch, key);
  if (first.status === 'sent' || !first.retryable) return first;
  await dispatchRuntime.sleep(RETRY_PAUSE_MS);
  return sendEmailBatch(env, emails, membersRuntime.fetch, key);
}

/**
 * Whether Resend definitely did not accept a failed request: a 4xx answer other than 409 (409 means the same key is
 * in flight or was used, so the batch may have gone out). Network errors and 5xx leave the outcome unknown.
 */
const definitelyRejected = (r: BatchEmailResult): boolean =>
  r.status === 'unconfigured' || (r.httpStatus !== undefined && r.httpStatus >= 400 && r.httpStatus < 500 && r.httpStatus !== 409);

async function dispatchOne(
  db: D1DatabaseLike, env: RuntimeEnv, row: Row, claimedLease: string, budget: { left: number }, secret: string,
): Promise<ArticleDispatchOutcome> {
  let lease = claimedLease;
  const articleId = s(row, 'article_id');
  const art = await db.prepare('SELECT slug FROM articles WHERE id = ? AND deleted_at IS NULL').bind(articleId).first<Row>();
  const slug = art ? s(art, 'slug') : null;
  const primary = slug ? await getArticle(db, slug, { publishedOnly: true }) : null;
  if (!slug || !primary || !primary.published) {
    await finish(db, articleId, lease, 'cancelled', 'not_published');
    return { article_id: articleId, slug, status: 'cancelled', sent: 0, failed: 0 };
  }
  const cutoff = s(row, 'audience_cutoff') || s(row, 'send_after');
  const variants = new ArticleEmailVariants(db, env, slug, primary);
  const from = env.ARTICLE_EMAIL_FROM || undefined;
  const replyTo = env.ARTICLE_EMAIL_REPLY_TO || undefined;
  const out: ArticleDispatchOutcome = { article_id: articleId, slug, status: 'sending', sent: 0, failed: 0 };

  for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch++) {
    if (budget.left <= 0) break;
    if (batch > 0) await dispatchRuntime.sleep(BATCH_PAUSE_MS);
    // Also notices a cancellation made while this run is sending.
    const renewed = batch === 0 ? lease : await renewLease(db, articleId, lease);
    if (!renewed) {
      out.status = 'cancelled';
      return out;
    }
    lease = renewed;
    const limit = Math.min(RESEND_BATCH_LIMIT, budget.left);
    const candidates = await nextRecipients(db, articleId, cutoff, limit);
    if (candidates.length === 0) {
      out.status = 'sent';
      break;
    }

    // Render before claiming, so a render error never leaves members claimed but unsent.
    const readers = primary.access === 'knowledges'
      ? await readFullMembers(db, candidates.map(r => r.id), iso(membersRuntime.now()))
      : new Set<string>();
    const prepared: { userId: string; email: BulkEmailInput }[] = [];
    for (const r of candidates) {
      const rec = await variants.edition(r.locale);
      const full = rec.access !== 'knowledges' || isAdminIdentity(r.email, r.emailVerifiedAt, env) || readers.has(r.id);
      const body = await variants.body(rec, full ? 'full' : 'teaser');
      const token = await unsubscribeToken(secret, r.id);
      const personal = withFooter(body, rec.locale, unsubscribePageUrl(env, token));
      prepared.push({
        userId: r.id,
        email: {
          to: r.email, subject: body.subject, html: personal.html, text: personal.text, from, replyTo,
          headers: {
            'List-Unsubscribe': `<${oneClickUnsubscribeUrl(env, token)}>`,
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
            // Distinct per article so Gmail never threads separate articles together.
            'X-Entity-Ref-ID': `article-${articleId}`,
          },
        },
      });
    }

    const claimed = await claimRecipients(db, articleId, candidates, iso(membersRuntime.now()));
    const sending = prepared.filter(p => claimed.has(p.userId));
    budget.left -= sending.length;
    if (sending.length === 0) continue;
    const ids = sending.map(p => p.userId);
    const key = `article-${articleId}-${(await sha256Hex(ids.join(','))).slice(0, 32)}`;
    const result = await sendWithRetry(env, sending.map(p => p.email), key);

    if (result.status !== 'sent') {
      out.status = 'error';
      out.error = result.error ?? 'send_failed';
      if (definitelyRejected(result)) {
        // Nothing went out (rate limit, quota, unverified sender…): a later run emails these members.
        await releaseRecipients(db, articleId, ids);
      } else {
        // The batch may have been delivered: never send it again.
        await recordOutcomes(db, articleId, ids.map(userId => ({ userId, status: 'failed', error: `unconfirmed:${out.error}` })), iso(membersRuntime.now()));
        out.failed += ids.length;
      }
      break;
    }
    const outcomes: RecipientOutcome[] = sending.map((p, i) => {
      const item = result.items[i] ?? { error: 'missing_result' };
      return { userId: p.userId, status: item.id ? 'sent' : 'failed', providerId: item.id ?? null, error: item.error ?? null };
    });
    await recordOutcomes(db, articleId, outcomes, iso(membersRuntime.now()));
    const batchSent = outcomes.filter(o => o.status === 'sent').length;
    out.sent += batchSent;
    out.failed += outcomes.length - batchSent;
    await db.prepare('UPDATE article_notifications SET sent_count = sent_count + ?, updated_at = ? WHERE article_id = ?')
      .bind(batchSent, iso(membersRuntime.now()), articleId).run();
    if (candidates.length < limit) {
      out.status = 'sent';
      break;
    }
  }

  await finish(db, articleId, lease, out.status === 'sent' ? 'sent' : 'sending', null);
  return out;
}

/** Sends every due article email within the warm-up budget. Safe to call concurrently and repeatedly. */
export async function dispatchArticleNotifications(d1: D1DatabaseLike, env: RuntimeEnv): Promise<DispatchResult> {
  const missing = [!env.RESEND_API_KEY && 'RESEND_API_KEY', !unsubscribeSecret(env) && 'MEMBER_HASH_SALT'].filter((m): m is string => Boolean(m));
  if (missing.length) {
    throw new AppError(503, 'email_unconfigured', `Article emails are unavailable: missing ${missing.join(', ')}`, { missing });
  }
  const secret = unsubscribeSecret(env) ?? '';
  const nowMs = membersRuntime.now();
  const stats = await sendingStats(d1, nowMs);
  const limit = warmupDailyLimit(stats.firstSentMs, nowMs, dailyCap(env));
  const result: DispatchResult = { quiet_hours: false, daily_limit: limit, sent_last_24h: stats.last24h, articles: [] };
  if (isQuietHour(nowMs, quietHours(env))) {
    result.quiet_hours = true;
    return result;
  }
  const budget = { left: limit - stats.last24h };
  if (budget.left <= 0) return result;

  const now = iso(nowMs);
  const { results } = await d1.prepare(`
    SELECT * FROM article_notifications
    WHERE status IN ('scheduled', 'sending') AND send_after <= ? AND (locked_until IS NULL OR locked_until < ?)
    ORDER BY send_after LIMIT ?
  `).bind(now, now, MAX_ARTICLES_PER_RUN).all<Row>();

  for (const row of results ?? []) {
    if (budget.left <= 0) break;
    const articleId = s(row, 'article_id');
    const lease = iso(nowMs + LEASE_MS);
    const claim = await d1.prepare(`
      UPDATE article_notifications SET status = 'sending', locked_until = ?, audience_cutoff = COALESCE(audience_cutoff, send_after), updated_at = ?
      WHERE article_id = ? AND status IN ('scheduled', 'sending') AND (locked_until IS NULL OR locked_until < ?)
    `).bind(lease, now, articleId, now).run();
    if (!claim.meta?.changes) continue;
    try {
      result.articles.push(await dispatchOne(d1, env, row, lease, budget, secret));
    } catch (err) {
      // Members claimed by the failed batch stay pending and are never emailed again, so an error here cannot cause
      // a duplicate. The lease is left to lapse, which also keeps a failing article from blocking the others.
      result.articles.push({ article_id: articleId, slug: null, status: 'error', sent: 0, failed: 0, error: err instanceof Error ? err.message.slice(0, 120) : 'dispatch_error' });
    }
  }
  return result;
}
