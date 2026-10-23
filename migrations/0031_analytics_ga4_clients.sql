-- GA4 attribution of server-side purchases: the GA client id (`_ga` cookie) and session id (`_ga_<stream>`
-- cookie) a member's browser carried when they started a checkout with analytics allowed. The Measurement
-- Protocol `purchase` sent later from the outbox uses them so GA4 joins it to that web session. One row per
-- member (latest checkout wins); rows older than 30 days are deleted on the next write and with the account.
CREATE TABLE IF NOT EXISTS analytics_ga4_clients (
  user_id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  session_id TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_analytics_ga4_clients_updated ON analytics_ga4_clients (updated_at);
