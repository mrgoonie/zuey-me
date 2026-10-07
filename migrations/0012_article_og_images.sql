-- Social share images (1200×630 PNG) rendered per published article edition.
-- `hash` is the content hash carried in the og:image URL (?v=); a new hash replaces the row, so each
-- edition keeps exactly one image. PNG bytes are base64 text (D1 returns BLOBs as JSON number arrays).
CREATE TABLE IF NOT EXISTS article_og_images (
  article_id TEXT NOT NULL,
  locale TEXT NOT NULL,
  hash TEXT NOT NULL,
  png_base64 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (article_id, locale)
);
