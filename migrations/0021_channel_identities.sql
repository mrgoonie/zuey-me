-- External chat-channel identities (Telegram first) linked to members, used by the dewee Channel Access
-- Gate to decide whether a sender may talk to the Zuey AI agent. One external id maps to at most one user.
-- All timestamps are UTC ISO-8601 strings produced by Date#toISOString (lexicographically comparable).
-- Safe to run more than once: tables and indexes use IF NOT EXISTS and the backfill uses INSERT OR IGNORE.

CREATE TABLE IF NOT EXISTS channel_identities (
  -- dewee channel_type, e.g. 'telegram'
  provider TEXT NOT NULL,
  -- dewee sender_id (Telegram numeric user id as text)
  external_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users (id),
  linked_at TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('link_token', 'community_backfill')),
  UNIQUE (provider, external_id)
);

CREATE INDEX IF NOT EXISTS idx_channel_identities_user ON channel_identities (user_id);

-- Nonces of /connect link tokens already used: each signed token links at most once.
CREATE TABLE IF NOT EXISTS channel_link_nonces (
  nonce TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  external_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  used_at TEXT NOT NULL,
  -- Token expiry; rows past it can be pruned because an expired token is rejected anyway.
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_channel_link_nonces_expiry ON channel_link_nonces (expires_at);

-- Backfill from the Telegram community: a Telegram id seen in a 'joined' membership is linked only when every
-- membership row carrying that id (any status) belongs to the same live user. Ids shared by several users are
-- skipped, so the gate answers link_required for them until the right member links explicitly.
INSERT OR IGNORE INTO channel_identities (provider, external_id, user_id, linked_at, source)
SELECT 'telegram', g.telegram_user_id, g.user_id, g.linked_at, 'community_backfill'
FROM (
  SELECT telegram_user_id,
    MIN(user_id) AS user_id,
    MIN(COALESCE(joined_at, updated_at)) AS linked_at,
    COUNT(DISTINCT user_id) AS user_count,
    SUM(CASE WHEN status = 'joined' THEN 1 ELSE 0 END) AS joined_count
  FROM community_memberships
  WHERE telegram_user_id IS NOT NULL AND trim(telegram_user_id) <> ''
  GROUP BY telegram_user_id
) g
JOIN users u ON u.id = g.user_id AND u.deleted_at IS NULL
WHERE g.user_count = 1 AND g.joined_count > 0;
