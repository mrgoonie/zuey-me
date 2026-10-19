-- Published-state metadata of an edition, written only when an edition is (re)published. Draft saves keep
-- changing `title`, `excerpt` and `updated_at` without republishing, so public feeds must read these columns
-- instead: they always describe the last published snapshot. Forward-only and additive.
ALTER TABLE article_editions ADD COLUMN published_title TEXT;
ALTER TABLE article_editions ADD COLUMN published_excerpt TEXT;
ALTER TABLE article_editions ADD COLUMN published_modified_at TEXT;

-- Backfill from the latest publish revision, which recorded the title/excerpt that were published.
UPDATE article_editions SET
  published_title = COALESCE((
    SELECT r.title FROM article_revisions r
    WHERE r.article_id = article_editions.article_id AND r.locale = article_editions.locale AND r.action = 'publish'
    ORDER BY r.revision DESC, r.created_at DESC LIMIT 1), title),
  published_excerpt = COALESCE((
    SELECT r.excerpt FROM article_revisions r
    WHERE r.article_id = article_editions.article_id AND r.locale = article_editions.locale AND r.action = 'publish'
    ORDER BY r.revision DESC, r.created_at DESC LIMIT 1), excerpt),
  published_modified_at = COALESCE((
    SELECT r.created_at FROM article_revisions r
    WHERE r.article_id = article_editions.article_id AND r.locale = article_editions.locale AND r.action = 'publish'
    ORDER BY r.revision DESC, r.created_at DESC LIMIT 1), published_at, updated_at)
WHERE published_json IS NOT NULL;

-- Keyset pagination of the public feed: newest published first within one locale.
CREATE INDEX IF NOT EXISTS idx_article_editions_feed ON article_editions (locale, published_at DESC, article_id DESC) WHERE deleted_at IS NULL AND published_json IS NOT NULL;
