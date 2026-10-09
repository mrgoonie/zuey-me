-- Zueytube: manually curated videos from youtube.com/@imzuey.
-- One `videos` row groups the language editions of the same talk (VI/EN); each edition is one
-- YouTube upload with its transcript fetched once through AnyMD at add time.
CREATE TABLE IF NOT EXISTS videos (
  id TEXT PRIMARY KEY,
  position INTEGER NOT NULL DEFAULT 0,
  featured INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS video_editions (
  youtube_id TEXT PRIMARY KEY,
  video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  locale TEXT NOT NULL CHECK (locale IN ('vi', 'en')),
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL DEFAULT '',
  thumbnail_url TEXT,
  duration_seconds INTEGER,
  published_at TEXT,
  -- Plain transcript lines "m:ss text"; NULL until a fetch succeeds.
  transcript TEXT,
  -- pending | ready | unavailable (no captions) | failed (AnyMD/network error)
  transcript_status TEXT NOT NULL DEFAULT 'pending' CHECK (transcript_status IN ('pending', 'ready', 'unavailable', 'failed')),
  transcript_error TEXT,
  transcript_fetched_at TEXT,
  word_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (video_id, locale)
);

CREATE INDEX IF NOT EXISTS idx_video_editions_video ON video_editions (video_id);
CREATE INDEX IF NOT EXISTS idx_videos_order ON videos (featured DESC, position, created_at DESC);

-- Full-text index over title, description and transcript of each edition (same tokenizer as knowledge_fts).
CREATE VIRTUAL TABLE IF NOT EXISTS video_fts USING fts5(
  youtube_id UNINDEXED,
  video_id UNINDEXED,
  locale UNINDEXED,
  title,
  description,
  transcript,
  tokenize = 'unicode61 remove_diacritics 2'
);
