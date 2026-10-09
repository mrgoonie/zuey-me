import type { D1DatabaseLike } from '../../db/store';
import { AppError } from '../http';

/** Delay between publishing and emailing members, so quick fixes after publishing land in the email. */
export const ARTICLE_EMAIL_DELAY_MS = 30 * 60 * 1000;

export type ArticleNotificationStatus = 'scheduled' | 'sending' | 'sent' | 'skipped' | 'cancelled';

export interface ArticleNotification {
  status: ArticleNotificationStatus;
  send_after: string;
  sent_count: number;
  reason: string | null;
  updated_at: string;
}

type Row = Record<string, unknown>;

const STATUSES: readonly ArticleNotificationStatus[] = ['scheduled', 'sending', 'sent', 'skipped', 'cancelled'];

function toNotification(row: Row): ArticleNotification {
  const status = STATUSES.find(s => s === row.status) ?? 'skipped';
  return {
    status,
    send_after: typeof row.send_after === 'string' ? row.send_after : '',
    sent_count: typeof row.sent_count === 'number' ? row.sent_count : 0,
    reason: typeof row.reason === 'string' ? row.reason : null,
    updated_at: typeof row.updated_at === 'string' ? row.updated_at : '',
  };
}

/** Optional `notify` flag of a publish request: true, false or undefined (default behaviour). */
export function parseNotifyFlag(raw: unknown): boolean | undefined {
  if (raw === undefined || raw === null) return undefined;
  // Clients holding a stale MCP tool schema forward unknown flags as strings.
  if (raw === true || raw === 'true') return true;
  if (raw === false || raw === 'false') return false;
  throw new AppError(400, 'invalid_field', 'notify must be a boolean', { field: 'notify' });
}

export async function getArticleNotification(db: D1DatabaseLike, articleId: string): Promise<ArticleNotification | null> {
  const row = await db.prepare('SELECT * FROM article_notifications WHERE article_id = ?').bind(articleId).first<Row>();
  return row ? toNotification(row) : null;
}

/**
 * Applies the email decision of a publish. The first publish schedules the email (send time = now + 30 min) unless
 * the publisher opted out or backdated the post (archive import); either way a row is written, so later publishes
 * of the same article never email again by default.
 * - notify === false cancels a pending or in-progress send.
 * - notify === true (explicit) schedules an article that was skipped or cancelled before.
 */
export async function applyPublishNotification(
  db: D1DatabaseLike, articleId: string, opts: { notify?: boolean; backdated: boolean; actor: string; nowMs: number },
): Promise<ArticleNotification | null> {
  const now = new Date(opts.nowMs).toISOString();
  const sendAfter = new Date(opts.nowMs + ARTICLE_EMAIL_DELAY_MS).toISOString();
  const existing = await getArticleNotification(db, articleId);
  if (!existing) {
    const send = opts.notify ?? !opts.backdated;
    const reason = send ? null : opts.notify === false ? 'publisher_opted_out' : 'backdated';
    await db.prepare(`
      INSERT OR IGNORE INTO article_notifications (article_id, status, send_after, reason, actor, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(articleId, send ? 'scheduled' : 'skipped', sendAfter, reason, opts.actor, now, now).run();
  } else if (opts.notify === false && (existing.status === 'scheduled' || existing.status === 'sending')) {
    await db.prepare("UPDATE article_notifications SET status = ?, reason = 'publisher_opted_out', actor = ?, updated_at = ? WHERE article_id = ?")
      .bind(existing.status === 'scheduled' ? 'skipped' : 'cancelled', opts.actor, now, articleId).run();
  } else if (opts.notify === true && (existing.status === 'skipped' || existing.status === 'cancelled')) {
    await db.prepare("UPDATE article_notifications SET status = 'scheduled', send_after = ?, audience_cutoff = NULL, reason = NULL, actor = ?, updated_at = ? WHERE article_id = ?")
      .bind(sendAfter, opts.actor, now, articleId).run();
  }
  return getArticleNotification(db, articleId);
}

/** Stops a pending or in-progress email when its article is deleted. */
export async function cancelArticleNotification(db: D1DatabaseLike, articleId: string, reason: string): Promise<void> {
  await db.prepare("UPDATE article_notifications SET status = 'cancelled', reason = ?, updated_at = ? WHERE article_id = ? AND status IN ('scheduled', 'sending')")
    .bind(reason, new Date().toISOString(), articleId).run();
}
