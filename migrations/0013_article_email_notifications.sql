-- New-article emails to members. One row per article: a publish schedules the email once
-- (send_after = publish time + 30 minutes so quick edits land in it); later publishes never re-send.
-- status: scheduled → sending → sent, or skipped (publisher opted out / backdated) / cancelled (unpublished in time).
CREATE TABLE IF NOT EXISTS article_notifications (
  article_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('scheduled', 'sending', 'sent', 'skipped', 'cancelled')),
  send_after TEXT NOT NULL,
  -- Members who joined after this moment are not part of this send.
  audience_cutoff TEXT,
  sent_count INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  actor TEXT,
  -- Lease so overlapping dispatcher runs never work on the same article at once.
  locked_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_article_notifications_due ON article_notifications (status, send_after);

-- Articles published before this feature never email: republishing an archived post must not reach everyone.
INSERT OR IGNORE INTO article_notifications (article_id, status, send_after, reason, actor, created_at, updated_at)
SELECT a.id, 'skipped', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'published_before_notifications', 'migration',
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM articles a
WHERE a.status = 'published'
   OR EXISTS (SELECT 1 FROM article_editions e WHERE e.article_id = a.id AND e.status = 'published');

-- Opt-out of article emails: 'unsubscribe' (member), 'bounce' / 'complaint' (Resend webhook suppression).
ALTER TABLE users ADD COLUMN article_emails_opt_out_at TEXT;
ALTER TABLE users ADD COLUMN article_emails_opt_out_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_email_log_kind_status ON email_log (kind, status, created_at);
