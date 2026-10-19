-- Provenance of structurally localized editions: which source text a translation was applied from.
-- Lets readers of the API flag a translation as stale once its source changes, and lets the apply
-- step refuse to overwrite a translation that a person edited after it was applied.
CREATE TABLE IF NOT EXISTS article_localizations (
  article_id TEXT NOT NULL,
  locale TEXT NOT NULL,
  source_locale TEXT NOT NULL,
  -- SHA-256 of the source title, excerpt and document the translation was made from.
  source_hash TEXT NOT NULL,
  -- Article revision the source was read at.
  source_revision INTEGER NOT NULL,
  -- SHA-256 of the title, excerpt and document written to the translated edition.
  result_hash TEXT NOT NULL,
  -- Article revision produced by the apply.
  applied_revision INTEGER NOT NULL,
  entry_count INTEGER NOT NULL,
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (article_id, locale)
);
