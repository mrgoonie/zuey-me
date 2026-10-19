-- Managed article cover and social preview. The cover is one media asset shared by every edition; each
-- edition keeps its own alt text. Without a managed cover the first public image still serves as cover.
ALTER TABLE articles ADD COLUMN cover_asset_id TEXT;
-- generated_card (the rendered share card), cover (the managed cover) or custom_asset (its own image).
ALTER TABLE articles ADD COLUMN social_preview_mode TEXT NOT NULL DEFAULT 'generated_card';
ALTER TABLE articles ADD COLUMN social_preview_asset_id TEXT;
ALTER TABLE article_editions ADD COLUMN cover_alt TEXT NOT NULL DEFAULT '';

-- upload | import | reconcile: how the registry row came to exist.
ALTER TABLE media_assets ADD COLUMN origin TEXT NOT NULL DEFAULT 'upload';
UPDATE media_assets SET origin = 'import' WHERE source_url IS NOT NULL;
