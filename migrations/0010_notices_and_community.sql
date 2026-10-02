-- Visitor notices from Duy (shown in the mascot bubble) and Telegram community memberships.
-- All timestamps are UTC ISO-8601 strings produced by Date#toISOString (lexicographically comparable).

CREATE TABLE IF NOT EXISTS notices (
  id TEXT PRIMARY KEY,
  -- JSON object keyed by locale (en/vi/zh/ko/ja); at least one entry.
  text_json TEXT NOT NULL,
  -- Mascot expression from public/mascot/manifest.json (idle, wave, talking, thinking, happy, surprised); NULL = default.
  expression TEXT,
  target TEXT NOT NULL DEFAULT 'all' CHECK (target IN ('all', 'members', 'plan')),
  -- Plan id when target = 'plan' (knowledges, ai, combo, community).
  target_plan TEXT,
  starts_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (expires_at > starts_at),
  CHECK ((target = 'plan') = (target_plan IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_notices_window ON notices (expires_at, starts_at);

-- One row per single-use invite issued to a member for one Telegram group.
CREATE TABLE IF NOT EXISTS community_memberships (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  chat TEXT NOT NULL CHECK (chat IN ('en', 'vi')),
  invite_link TEXT NOT NULL,
  invite_expires_at TEXT NOT NULL,
  -- Filled from the bot's chat_member update when the invite is used.
  telegram_user_id TEXT,
  status TEXT NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'joined', 'left', 'removed', 'revoked')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  joined_at TEXT,
  removed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_community_user ON community_memberships (user_id, chat, created_at);
CREATE INDEX IF NOT EXISTS idx_community_status ON community_memberships (status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_community_invite ON community_memberships (invite_link);
