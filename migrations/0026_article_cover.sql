-- Managed cover and social preview of an article, plus where each media asset came from.
-- The cover is one media asset shared by every locale edition; only its alt text is per edition.
-- `social_preview_mode` stays NULL until an editor chooses one, which keeps the earlier behaviour
-- (generated share card in og:image, first body image in JSON-LD).
ALTER TABLE articles ADD COLUMN cover_asset_id TEXT;
ALTER TABLE articles ADD COLUMN social_preview_mode TEXT CHECK (social_preview_mode IS NULL OR social_preview_mode IN ('generated_card', 'cover', 'custom_asset'));
ALTER TABLE articles ADD COLUMN social_asset_id TEXT;
ALTER TABLE article_editions ADD COLUMN cover_alt TEXT NOT NULL DEFAULT '';

-- 'upload' (direct upload), 'import' (copied from a URL) or 'reconcile' (object put in R2 by other means, then registered).
ALTER TABLE media_assets ADD COLUMN origin TEXT NOT NULL DEFAULT 'upload';
UPDATE media_assets SET origin = 'import' WHERE source_url IS NOT NULL;
