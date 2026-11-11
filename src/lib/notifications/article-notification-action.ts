import type { D1DatabaseLike } from '../../db/store';
import { AppError } from '../http';
import { ARTICLE_EMAIL_DELAY_MS, getArticleNotification } from './article-notification-schedule';
import type { ArticleNotification } from './article-notification-schedule';

export interface ArticleNotificationActionResult {
  slug: string;
  /** Stored email state after the action. */
  email_notification: ArticleNotification;
  /** False when the stored state already matched the request (idempotent no-op, including an email that was already sent). */
  changed: boolean;
}

/**
 * Schedules (notify: true) or cancels (notify: false) the member email of an article that is currently published,
 * without touching any edition, revision, search index or share image. Works on the single `article_notifications`
 * row, so repeating a request never schedules or sends a second email:
 * - notify true: no row, skipped or cancelled becomes scheduled for now + 30 min; scheduled, sending and sent stay as is.
 * - notify false: no row becomes skipped; scheduled becomes skipped; sending becomes cancelled; the rest stay as is.
 * Each transition is guarded by the status that was read, so a dispatcher claiming the row in between wins.
 */
export async function setArticleNotification(
  db: D1DatabaseLike | undefined, slug: string, notify: unknown, opts: { actor: string; nowMs?: number },
): Promise<ArticleNotificationActionResult> {
  if (!db) throw new AppError(503, 'db_unavailable', 'Database binding is not configured');
  if (typeof notify !== 'boolean') throw new AppError(400, 'invalid_field', 'notify must be a boolean', { field: 'notify' });
  const art = await db.prepare('SELECT id FROM articles WHERE slug = ? AND deleted_at IS NULL').bind(slug).first<{ id: string }>();
  if (!art) throw new AppError(404, 'not_found', 'Article not found');
  const published = await db.prepare("SELECT 1 AS ok FROM article_editions WHERE article_id = ? AND status = 'published' AND deleted_at IS NULL LIMIT 1").bind(art.id).first();
  if (!published) throw new AppError(409, 'not_published', 'The article has no published edition, so there is no email to schedule or cancel');

  const nowMs = opts.nowMs ?? Date.now();
  const now = new Date(nowMs).toISOString();
  const sendAfter = new Date(nowMs + ARTICLE_EMAIL_DELAY_MS).toISOString();
  const before = await getArticleNotification(db, art.id);

  if (!before) {
    await db.prepare(`
      INSERT OR IGNORE INTO article_notifications (article_id, status, send_after, reason, actor, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(art.id, notify ? 'scheduled' : 'skipped', sendAfter, notify ? null : 'publisher_opted_out', opts.actor, now, now).run();
  } else if (notify && (before.status === 'skipped' || before.status === 'cancelled')) {
    await db.prepare("UPDATE article_notifications SET status = 'scheduled', send_after = ?, audience_cutoff = NULL, reason = NULL, actor = ?, updated_at = ? WHERE article_id = ? AND status = ?")
      .bind(sendAfter, opts.actor, now, art.id, before.status).run();
  } else if (!notify && (before.status === 'scheduled' || before.status === 'sending')) {
    await db.prepare("UPDATE article_notifications SET status = ?, reason = 'publisher_opted_out', actor = ?, updated_at = ? WHERE article_id = ? AND status = ?")
      .bind(before.status === 'scheduled' ? 'skipped' : 'cancelled', opts.actor, now, art.id, before.status).run();
  }

  const after = await getArticleNotification(db, art.id);
  if (!after) throw new AppError(500, 'notification_update_failed', 'The email state could not be read back');
  return {
    slug,
    email_notification: after,
    changed: !before || before.status !== after.status || before.send_after !== after.send_after,
  };
}
