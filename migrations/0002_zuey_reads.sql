-- Zuey Reads: curated AnyMD library items. Stores metadata, content hash and AI summary only, never raw article content.
CREATE TABLE IF NOT EXISTS reads (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  author TEXT,
  description TEXT,
  domain TEXT,
  site TEXT,
  image TEXT,
  source_kind TEXT,
  language TEXT,
  published TEXT,
  tags TEXT NOT NULL DEFAULT '',
  word_count INTEGER,
  content_hash TEXT,
  summary TEXT,
  visible INTEGER NOT NULL DEFAULT 1,
  anymd_updated_at INTEGER,
  synced_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_reads_visible_published ON reads (visible, published, anymd_updated_at);
CREATE INDEX IF NOT EXISTS idx_reads_source_kind ON reads (source_kind);

CREATE TABLE IF NOT EXISTS reads_sync_runs (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  fetched INTEGER NOT NULL DEFAULT 0,
  tagged INTEGER NOT NULL DEFAULT 0,
  summarized INTEGER NOT NULL DEFAULT 0,
  unchanged INTEGER NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_reads_sync_runs_started ON reads_sync_runs (started_at);
