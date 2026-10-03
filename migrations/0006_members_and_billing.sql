-- Membership: member identities, sessions, login tokens, subscriptions, SePay billing orders,
-- user API keys, transactional email log and account activity.
-- All timestamps are UTC ISO-8601 strings produced by Date#toISOString (lexicographically comparable).

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL CHECK (email = lower(email)),
  email_verified_at TEXT,
  name TEXT,
  avatar_url TEXT,
  locale TEXT NOT NULL DEFAULT 'vi',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

-- One live account per email; deleted accounts keep their (scrubbed) row for billing history.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_live ON users (email) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS member_sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users (id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  user_agent TEXT
);

CREATE INDEX IF NOT EXISTS idx_member_sessions_user ON member_sessions (user_id, last_seen_at);

-- Single-use tokens for magic-link sign-in and email-change verification (only the hash is stored).
CREATE TABLE IF NOT EXISTS login_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  purpose TEXT NOT NULL CHECK (purpose IN ('magic_link', 'email_change')),
  email TEXT NOT NULL,
  user_id TEXT REFERENCES users (id),
  ip_hash TEXT,
  next_path TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_login_tokens_email ON login_tokens (purpose, email, created_at);
CREATE INDEX IF NOT EXISTS idx_login_tokens_ip ON login_tokens (purpose, ip_hash, created_at);

CREATE TABLE IF NOT EXISTS user_identities (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  provider TEXT NOT NULL CHECK (provider IN ('google', 'github')),
  subject TEXT NOT NULL,
  email TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (provider, subject)
);

CREATE INDEX IF NOT EXISTS idx_user_identities_user ON user_identities (user_id);

-- One row per (user, plan); current_period_end is recomputed from paid orders, so fulfilment is idempotent.
CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  plan TEXT NOT NULL CHECK (plan IN ('knowledges', 'ai', 'combo', 'community')),
  status TEXT NOT NULL CHECK (status IN ('active', 'expired')),
  current_period_end TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, plan)
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_period ON subscriptions (status, current_period_end);

CREATE TABLE IF NOT EXISTS billing_orders (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users (id),
  plan TEXT NOT NULL CHECK (plan IN ('knowledges', 'ai', 'combo', 'community')),
  months INTEGER NOT NULL CHECK (months IN (1, 3, 6, 12)),
  amount_usd_cents INTEGER NOT NULL,
  usd_vnd_rate REAL NOT NULL,
  amount_vnd INTEGER NOT NULL CHECK (amount_vnd > 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'expired', 'needs_attention')),
  expires_at TEXT NOT NULL,
  paid_at TEXT,
  amount_paid INTEGER,
  payment_ref TEXT,
  provider_event_id TEXT,
  attention_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_billing_orders_user ON billing_orders (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_billing_orders_status ON billing_orders (status, expires_at);
CREATE INDEX IF NOT EXISTS idx_billing_orders_paid ON billing_orders (user_id, plan, paid_at) WHERE status = 'paid';

-- Payment events are shared with booking; billing events reference the order instead of a booking.
ALTER TABLE payment_events ADD COLUMN billing_order_id TEXT;

CREATE TABLE IF NOT EXISTS user_api_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  scopes TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT,
  replaced_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_user_api_keys_user ON user_api_keys (user_id, created_at);

CREATE TABLE IF NOT EXISTS email_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  idempotency_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  user_id TEXT,
  to_email TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'skipped', 'failed')),
  provider_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_email_log_user ON email_log (user_id, created_at);

CREATE TABLE IF NOT EXISTS user_activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_user_activity_user ON user_activity (user_id, created_at);
