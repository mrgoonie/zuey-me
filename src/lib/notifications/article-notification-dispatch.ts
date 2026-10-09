import type { D1DatabaseLike } from '../../db/store';
import type { RuntimeEnv } from '../../env';
import { AppError } from '../http';
import { getArticle } from '../blocks/articles';
import type { ArticleRecord } from '../blocks/articles';
import { READ_FULL_ENTITLEMENT } from '../blocks/paywall';
import { isLocale } from '../i18n/locales';
import type { Locale } from '../i18n/locales';
import { RESEND_BATCH_LIMIT, sendEmailBatch } from '../integrations/resend';
import type { BulkEmailInput } from '../integrations/resend';
import { isAdminIdentity } from '../members/admins';
import { DAY_MS, membersRuntime, sha256Hex, siteUrl } from '../members/runtime';
import { getEntitlements } from '../members/subscriptions';
import { oneClickUnsubscribeUrl, unsubscribePageUrl, unsubscribeSecret, unsubscribeToken } from './article-email-subscription';
import { renderArticleEmail, withFooter } from './article-email-render';
import type { ArticleEmailBody, ArticleEmailMode } from './article-email-render';

/**
 * Sends due new-article emails. Called every few minutes by the Cloudflare cron worker (workers/scheduler).
 *
 * Deliverability safeguards:
 * - warm-up: a rolling 24-hour cap that starts at WARMUP_START_PER_DAY and doubles every day since the first article
 *   email, up to ARTICLE_EMAIL_DAILY_CAP; the most recently active members are emailed first;
 * - quiet hours (Asia/Ho_Chi_Minh): emails wait for the morning instead of landing at night;
 * - RFC 8058 one-click unsubscribe headers, and suppression of bounced / complaining addresses (Resend webhook).
 * The email always carries the latest published edition, so edits made after publishing are included.
 */

export const ARTICLE_EMAIL_KIND = 'article_notification';
const WARMUP_START_PER_DAY = 50;
const DEFAULT_DAILY_CAP = 2000;
const DEFAULT_QUIET_HOURS = { start: 23, end: 7 };
/** UTC offset of Asia/Ho_Chi_Minh (no daylight saving time). */
const VN_UTC_OFFSET_HOURS = 7;
/** Articles handled per run and batches per article per run (Resend allows ~2 requests per second). */
const MAX_ARTICLES_PER_RUN = 3;
const MAX_BATCHES_PER_RUN = 5;
const BATCH_PAUSE_MS = 600;
const LEASE_MS = 4 * 60 * 1000;
/** An email_log row left pending this long (crashed run) is retried. */
const STALE_PENDING_MS = 10 * 60 * 1000;

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

async function sendingStats(db: D1DatabaseLike, nowMs: number): Promise<{ firstSentMs: number | null; last24h: number }> {
  const row = await db.prepare(`
    SELECT (SELECT MIN(created_at) FROM email_log WHERE kind = ? AND status = 'sent') AS first_sent,
           (SELECT COUNT(*) FROM email_log WHERE kind = ? AND status IN ('sent', 'pending') AND created_at > ?) AS last_24h
  `).bind(ARTICLE_EMAIL_KIND, ARTICLE_EMAIL_KIND, iso(nowMs - DAY_MS)).first<Row>();
  const first = row && typeof row.first_sent === 'string' ? Date.parse(row.first_sent) : NaN;
  return { firstSentMs: Number.isFinite(first) ? first : null, last24h: row && typeof row.last_24h === 'number' ? row.last_24h : 0 };
}

interface Recipient { id: string; email: string; locale: string; emailVerifiedAt: string | null }

/** Next members who have not received this article's email yet, most recently active first. */
async function nextRecipients(db: D1DatabaseLike, articleId: string, cutoff: string, nowMs: number, limit: number): Promise<Recipient[]> {
  const { results } = await db.prepare(`
    SELECT u.id, u.email, u.locale, u.email_verified_at,
           (SELECT MAX(a.created_at) FROM user_activity a WHERE a.user_id = u.id) AS last_active
    FROM users u
    WHERE u.email_verified_at IS NOT NULL AND u.deleted_at IS NULL AND u.article_emails_opt_out_at IS NULL
      AND u.created_at <= ?
      AND NOT EXISTS (
        SELECT 1 FROM email_log l WHERE l.idempotency_key = 'article:' || ? || ':' || u.id
          AND (l.status IN ('sent', 'failed') OR (l.status = 'pending' AND l.updated_at > ?))
      )
    ORDER BY last_active IS NULL, last_active DESC, u.created_at
    LIMIT ?
  `).bind(cutoff, articleId, iso(nowMs - STALE_PENDING_MS), limit).all<Row>();
  return (results ?? []).map(r => ({
    id: s(r, 'id'), email: s(r, 'email'), locale: s(r, 'locale'),
    emailVerifiedAt: typeof r.email_verified_at === 'string' ? r.email_verified_at : null,
  }));
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

async function canReadFull(db: D1DatabaseLike, env: RuntimeEnv, r: Recipient): Promise<boolean> {
  if (isAdminIdentity(r.email, r.emailVerifiedAt, env)) return true;
  return (await getEntitlements(db, r.id)).entitlements.includes(READ_FULL_ENTITLEMENT);
}

/** Releases the lease; a send the publisher cancelled meanwhile stays cancelled. */
async function finish(db: D1DatabaseLike, articleId: string, status: 'sent' | 'cancelled' | 'sending', reason: string | null, nowMs: number): Promise<void> {
  await db.prepare("UPDATE article_notifications SET status = ?, reason = COALESCE(?, reason), locked_until = NULL, updated_at = ? WHERE article_id = ? AND status = 'sending'")
    .bind(status, reason, iso(nowMs), articleId).run();
  await db.prepare('UPDATE article_notifications SET locked_until = NULL WHERE article_id = ?').bind(articleId).run();
}

async function dispatchOne(
  db: D1DatabaseLike, env: RuntimeEnv, row: Row, budget: { left: number }, secret: string, nowMs: number,
): Promise<ArticleDispatchOutcome> {
  const articleId = s(row, 'article_id');
  const art = await db.prepare('SELECT slug FROM articles WHERE id = ? AND deleted_at IS NULL').bind(articleId).first<Row>();
  const slug = art ? s(art, 'slug') : null;
  const primary = slug ? await getArticle(db, slug, { publishedOnly: true }) : null;
  if (!slug || !primary || !primary.published) {
    await finish(db, articleId, 'cancelled', 'not_published', nowMs);
    return { article_id: articleId, slug, status: 'cancelled', sent: 0, failed: 0 };
  }
  const cutoff = s(row, 'audience_cutoff') || s(row, 'send_after');
  const variants = new ArticleEmailVariants(db, env, slug, primary);
  const from = env.ARTICLE_EMAIL_FROM || undefined;
  const replyTo = env.ARTICLE_EMAIL_REPLY_TO || undefined;
  const out: ArticleDispatchOutcome = { article_id: articleId, slug, status: 'sending', sent: 0, failed: 0 };

  for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch++) {
    if (budget.left <= 0) break;
    const limit = Math.min(RESEND_BATCH_LIMIT, budget.left);
    const recipients = await nextRecipients(db, articleId, cutoff, nowMs, limit);
    if (recipients.length === 0) {
      out.status = 'sent';
      break;
    }
    if (batch > 0) await dispatchRuntime.sleep(BATCH_PAUSE_MS);

    const emails: BulkEmailInput[] = [];
    for (const r of recipients) {
      const rec = await variants.edition(r.locale);
      const mode: ArticleEmailMode = rec.access === 'knowledges' && !(await canReadFull(db, env, r)) ? 'teaser' : 'full';
      const body = await variants.body(rec, mode);
      const token = await unsubscribeToken(secret, r.id);
      const personal = withFooter(body, rec.locale, unsubscribePageUrl(env, token));
      emails.push({
        to: r.email, subject: body.subject, html: personal.html, text: personal.text, from, replyTo,
        headers: {
          'List-Unsubscribe': `<${oneClickUnsubscribeUrl(env, token)}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
          // Distinct per article so Gmail never threads separate articles together.
          'X-Entity-Ref-ID': `article-${articleId}`,
        },
      });
    }

    const now = iso(membersRuntime.now());
    for (const r of recipients) {
      await db.prepare(`
        INSERT INTO email_log (idempotency_key, kind, user_id, to_email, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)
        ON CONFLICT (idempotency_key) DO UPDATE SET status = 'pending', to_email = excluded.to_email, updated_at = excluded.updated_at
      `).bind(`article:${articleId}:${r.id}`, ARTICLE_EMAIL_KIND, r.id, r.email, now, now).run();
    }
    const batchKey = `article-${articleId}-${(await sha256Hex(recipients.map(r => r.id).join(','))).slice(0, 32)}`;
    const result = await sendEmailBatch(env, emails, membersRuntime.fetch, batchKey);

    if (result.status !== 'sent') {
      // Whole request failed (rate limit, quota, outage, bad key): release the rows so the next run retries them.
      for (const r of recipients) {
        await db.prepare("DELETE FROM email_log WHERE idempotency_key = ? AND status = 'pending'").bind(`article:${articleId}:${r.id}`).run();
      }
      out.status = 'error';
      out.error = result.error ?? 'send_failed';
      break;
    }
    let batchSent = 0;
    for (let i = 0; i < recipients.length; i++) {
      const item = result.items[i] ?? { error: 'missing_result' };
      await db.prepare('UPDATE email_log SET status = ?, provider_id = ?, error = ?, updated_at = ? WHERE idempotency_key = ?')
        .bind(item.id ? 'sent' : 'failed', item.id ?? null, item.error ?? null, iso(membersRuntime.now()), `article:${articleId}:${recipients[i].id}`).run();
      if (item.id) batchSent += 1; else out.failed += 1;
    }
    out.sent += batchSent;
    budget.left -= recipients.length;
    await db.prepare('UPDATE article_notifications SET sent_count = sent_count + ?, updated_at = ? WHERE article_id = ?')
      .bind(batchSent, iso(membersRuntime.now()), articleId).run();
    if (recipients.length < limit) {
      out.status = 'sent';
      break;
    }
  }

  await finish(db, articleId, out.status === 'sent' ? 'sent' : 'sending', null, membersRuntime.now());
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
    const claim = await d1.prepare(`
      UPDATE article_notifications SET status = 'sending', locked_until = ?, audience_cutoff = COALESCE(audience_cutoff, send_after), updated_at = ?
      WHERE article_id = ? AND status IN ('scheduled', 'sending') AND (locked_until IS NULL OR locked_until < ?)
    `).bind(iso(nowMs + LEASE_MS), now, articleId, now).run();
    if (!claim.meta?.changes) continue;
    try {
      result.articles.push(await dispatchOne(d1, env, row, budget, secret, nowMs));
    } catch (err) {
      await d1.prepare('UPDATE article_notifications SET locked_until = NULL WHERE article_id = ?').bind(articleId).run();
      result.articles.push({ article_id: articleId, slug: null, status: 'error', sent: 0, failed: 0, error: err instanceof Error ? err.message.slice(0, 120) : 'dispatch_error' });
    }
  }
  return result;
}
