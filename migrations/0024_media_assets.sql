-- Images stored in the public R2 bucket `zuey-media` (served at https://media.zuey.me) for articles.
-- Keys are content-addressed, so the same bytes are stored once (`sha256` is unique).
CREATE TABLE IF NOT EXISTS media_assets (
  id TEXT PRIMARY KEY,
  object_key TEXT NOT NULL UNIQUE,
  url TEXT NOT NULL,
  sha256 TEXT NOT NULL UNIQUE,
  mime TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  width INTEGER,
  height INTEGER,
  alt TEXT NOT NULL DEFAULT '',
  -- Page the image was imported from, when it came from a URL.
  source_url TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_media_assets_created ON media_assets (created_at DESC);

-- One-time upload URLs handed to admins (MCP clients with a shell upload with curl, so the bytes never
-- travel through the model). Only the SHA-256 of the token is stored.
CREATE TABLE IF NOT EXISTS media_upload_tickets (
  token_hash TEXT PRIMARY KEY,
  alt TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  asset_id TEXT
);
