-- Covering index for the article list (listArticles → loadEditionMetas). Columns added after the table was created
-- (revision, published_revision, published_at, updated_at, deleted_at, cover_alt, ...) sit after draft_json and
-- published_json in each row, so reading any of them walks both bodies' overflow pages. Without this index every
-- /articles render read every edition's bodies (~125 ms of D1 time per list, and D1 runs one query at a time).
-- The list reads only indexed columns, and its unpublished-changes check filters on the revisions from the index
-- before it touches a body. Forward-only and additive.
--
-- DEPLOY ORDER (production): apply before deploying the code, which names the index (INDEXED BY) and fails
-- without it: `wrangler d1 execute zuey_me_db --remote --file=./migrations/0034_article_editions_list_index.sql -y`.
-- Record a restore point first with `wrangler d1 time-travel info zuey_me_db`.
--
-- ROLLBACK: DROP INDEX idx_article_editions_list; together with reverting the code.
CREATE INDEX IF NOT EXISTS idx_article_editions_list ON article_editions (
  deleted_at, article_id, locale, revision, published_revision, title, excerpt, published_words, cover_url, cover_alt,
  published_at, updated_at
);
