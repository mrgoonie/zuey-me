-- Server analytics outbox: business events (purchases, subscription lifecycle, refunds, sign-ups) are
-- written here in the same flow as the verified state change and delivered later by the scheduler job
-- `POST /api/v1/analytics/outbox/drain`. `id` is the event UUID sent to every destination, so a retried
-- delivery is de-duplicated there; `dedupe_key` (provider transaction or event id) makes a repeated
-- webhook, reconciliation or recompute insert nothing.
CREATE TABLE IF NOT EXISTS analytics_outbox (
  id TEXT PRIMARY KEY,
  dedupe_key TEXT NOT NULL,
  event TEXT NOT NULL,
  -- Member id or an opaque guest id; never an email or name.
  distinct_id TEXT NOT NULL,
  -- JSON object validated against the event taxonomy (no personal data) at write time.
  properties TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'dead')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  lease_token TEXT,
  lease_until TEXT,
  last_error TEXT,
  sent_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_analytics_outbox_dedupe ON analytics_outbox(dedupe_key);
CREATE INDEX IF NOT EXISTS idx_analytics_outbox_due ON analytics_outbox(status, next_attempt_at);
-- Retention: sent rows are deleted 30 days after `sent_at` by the drain job.
CREATE INDEX IF NOT EXISTS idx_analytics_outbox_sent ON analytics_outbox(status, sent_at);
