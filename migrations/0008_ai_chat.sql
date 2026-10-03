-- Zuey AI chat: per-user chat sessions and messages, monthly usage counters, private interactive
-- artifacts produced by the AI, the audit trail of admin access to stored chats, and the sandbox
-- fetch-proxy rate limit. All timestamps are UTC ISO-8601 strings (Date#toISOString).

CREATE TABLE IF NOT EXISTS chat_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  title TEXT NOT NULL DEFAULT '',
  -- One in-flight AI run per session: run_id is set while a reply streams and cleared when it ends.
  run_id TEXT,
  run_started_at TEXT,
  -- Set by the stop endpoint; the streaming worker polls it and aborts the gateway run.
  cancel_requested_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_chat_sessions_user ON chat_sessions (user_id, deleted_at, updated_at);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_updated ON chat_sessions (deleted_at, updated_at);

CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES chat_sessions (id),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  -- JSON array of {id, slug, title, url, access, scope} cited as grounding for an assistant reply.
  sources TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL CHECK (status IN ('complete', 'streaming', 'cancelled', 'error')),
  error_code TEXT,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  est_cost_cents REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages (session_id, created_at);

-- Monthly request counter per user; month is 'YYYY-MM' in Asia/Saigon time.
CREATE TABLE IF NOT EXISTS ai_usage (
  user_id TEXT NOT NULL,
  month TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  est_cost_cents REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, month)
);

-- Interactive blocks generated in chat. `block` is validated by the shared article block schema.
CREATE TABLE IF NOT EXISTS chat_artifacts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  session_id TEXT NOT NULL REFERENCES chat_sessions (id),
  message_id TEXT,
  block TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('private', 'attached')),
  article_id TEXT,
  attached_by TEXT,
  attached_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_artifacts_session ON chat_artifacts (session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_chat_artifacts_user ON chat_artifacts (user_id, created_at);

-- Every admin read/list of stored chats, with the stated reason.
CREATE TABLE IF NOT EXISTS admin_access_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin TEXT NOT NULL,
  admin_user_id TEXT,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  reason TEXT NOT NULL,
  at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_access_audit_at ON admin_access_audit (at);
CREATE INDEX IF NOT EXISTS idx_admin_access_audit_target ON admin_access_audit (target, at);

-- Fixed-window rate limit for /api/v1/sandbox/fetch; key is 'u:<user id>' or 'ip:<salted hash>'.
CREATE TABLE IF NOT EXISTS sandbox_rate_limits (
  key TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key, window_start)
);
