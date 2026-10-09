import type { D1DatabaseLike } from '../../db/store';
import { READ_FULL_ENTITLEMENT } from '../blocks/paywall';
import { entitlementsForPlans, isPlanId } from '../members/plans';
import type { PlanId } from '../members/plans';

/**
 * Recipient bookkeeping of new-article emails, in email_log (one row per article and member, key
 * `article:<articleId>:<userId>`). Delivery is at-most-once: a member is emailed only by the run whose claim inserted
 * their row, and an existing row (sent, failed, unconfirmed or left pending by a crashed run) is never sent again.
 * Every helper is a single statement over a JSON array, so a batch of 100 costs a few D1 queries, not hundreds.
 */
export const ARTICLE_EMAIL_KIND = 'article_notification';

type Row = Record<string, unknown>;
const s = (row: Row, key: string): string => (typeof row[key] === 'string' ? (row[key] as string) : '');

export interface Recipient { id: string; email: string; locale: string; emailVerifiedAt: string | null }

export const recipientKey = (articleId: string, userId: string): string => `article:${articleId}:${userId}`;

/** Next members without an email_log row for this article, most recently active first. */
export async function nextRecipients(db: D1DatabaseLike, articleId: string, cutoff: string, limit: number): Promise<Recipient[]> {
  const { results } = await db.prepare(`
    SELECT u.id, u.email, u.locale, u.email_verified_at,
           (SELECT MAX(a.created_at) FROM user_activity a WHERE a.user_id = u.id) AS last_active
    FROM users u
    WHERE u.email_verified_at IS NOT NULL AND u.deleted_at IS NULL AND u.article_emails_opt_out_at IS NULL
      AND u.created_at <= ?
      AND NOT EXISTS (SELECT 1 FROM email_log l WHERE l.idempotency_key = 'article:' || ? || ':' || u.id)
    ORDER BY last_active IS NULL, last_active DESC, u.created_at
    LIMIT ?
  `).bind(cutoff, articleId, limit).all<Row>();
  return (results ?? []).map(r => ({
    id: s(r, 'id'), email: s(r, 'email'), locale: s(r, 'locale'),
    emailVerifiedAt: typeof r.email_verified_at === 'string' ? r.email_verified_at : null,
  }));
}

/** Members of the batch whose active plans grant read_full, in one query. */
export async function readFullMembers(db: D1DatabaseLike, userIds: string[], nowIso: string): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const { results } = await db.prepare(`
    SELECT user_id, plan FROM subscriptions
    WHERE status = 'active' AND current_period_end > ? AND user_id IN (SELECT value FROM json_each(?))
  `).bind(nowIso, JSON.stringify(userIds)).all<Row>();
  const plans = new Map<string, PlanId[]>();
  for (const r of results ?? []) {
    if (!isPlanId(r.plan)) continue;
    plans.set(s(r, 'user_id'), [...(plans.get(s(r, 'user_id')) ?? []), r.plan]);
  }
  return new Set([...plans].filter(([, p]) => entitlementsForPlans(p).includes(READ_FULL_ENTITLEMENT)).map(([id]) => id));
}

/** Inserts pending rows; returns the ids this run claimed (members another run already claimed are left out). */
export async function claimRecipients(db: D1DatabaseLike, articleId: string, recipients: Recipient[], nowIso: string): Promise<Set<string>> {
  const rows = recipients.map(r => ({ k: recipientKey(articleId, r.id), u: r.id, e: r.email }));
  // `WHERE true` resolves SQLite's parsing ambiguity between INSERT … SELECT and ON CONFLICT.
  const { results } = await db.prepare(`
    INSERT INTO email_log (idempotency_key, kind, user_id, to_email, status, created_at, updated_at)
    SELECT json_extract(value, '$.k'), ?, json_extract(value, '$.u'), json_extract(value, '$.e'), 'pending', ?, ?
    FROM json_each(?) WHERE true
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING user_id
  `).bind(ARTICLE_EMAIL_KIND, nowIso, nowIso, JSON.stringify(rows)).all<Row>();
  return new Set((results ?? []).map(r => s(r, 'user_id')));
}

/** Deletes pending rows of a batch Resend definitely rejected, so a later run emails those members. */
export async function releaseRecipients(db: D1DatabaseLike, articleId: string, userIds: string[]): Promise<void> {
  await db.prepare("DELETE FROM email_log WHERE status = 'pending' AND idempotency_key IN (SELECT value FROM json_each(?))")
    .bind(JSON.stringify(userIds.map(id => recipientKey(articleId, id)))).run();
}

export interface RecipientOutcome { userId: string; status: 'sent' | 'failed'; providerId?: string | null; error?: string | null }

/** Records the outcome of every member of a batch in one statement. */
export async function recordOutcomes(db: D1DatabaseLike, articleId: string, outcomes: RecipientOutcome[], nowIso: string): Promise<void> {
  if (outcomes.length === 0) return;
  const rows = outcomes.map(o => ({ k: recipientKey(articleId, o.userId), s: o.status, p: o.providerId ?? null, r: o.error ?? null }));
  await db.prepare(`
    UPDATE email_log SET status = json_extract(j.value, '$.s'), provider_id = json_extract(j.value, '$.p'),
      error = json_extract(j.value, '$.r'), updated_at = ?
    FROM json_each(?) AS j
    WHERE email_log.idempotency_key = json_extract(j.value, '$.k')
  `).bind(nowIso, JSON.stringify(rows)).run();
}
