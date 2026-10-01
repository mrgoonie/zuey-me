-- Articles use one block document schema (src/lib/blocks/schema.ts). The draft and the
-- published snapshot are stored separately so editing never changes the public version
-- until it is republished.
CREATE TABLE IF NOT EXISTS articles (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  locale TEXT NOT NULL DEFAULT 'vi',
  title TEXT NOT NULL,
  excerpt TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  access TEXT NOT NULL DEFAULT 'free' CHECK (access IN ('free', 'knowledges')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  draft_json TEXT NOT NULL,
  published_json TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  published_at TEXT,
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_articles_public ON articles (deleted_at, status, published_at);

-- One vote per voter per survey block; voter_key is 'u:<user id>' or 'a:<salted hash of anon cookie>'.
CREATE TABLE IF NOT EXISTS survey_votes (
  id TEXT PRIMARY KEY,
  article_id TEXT NOT NULL,
  block_id TEXT NOT NULL,
  voter_key TEXT NOT NULL,
  option_ids TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (block_id, voter_key)
);

CREATE INDEX IF NOT EXISTS idx_survey_votes_article ON survey_votes (article_id, block_id);

-- Fixed-window vote rate limit keyed by a salted hash of the client IP (raw IPs are never stored).
CREATE TABLE IF NOT EXISTS survey_rate_limits (
  ip_hash TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ip_hash, window_start)
);
