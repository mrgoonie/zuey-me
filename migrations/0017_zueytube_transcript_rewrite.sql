-- Zueytube: AI-cleaned transcripts.
-- `transcript` stays the text every surface reads (player, search, Zuey AI). After a successful
-- AI rewrite it holds the cleaned paragraphs with estimated timestamps; the raw AnyMD captions are
-- kept in `transcript_source` so a rewrite can be redone without fetching from AnyMD again.
ALTER TABLE video_editions ADD COLUMN transcript_source TEXT;
ALTER TABLE video_editions ADD COLUMN transcript_rewrite_status TEXT NOT NULL DEFAULT 'none'
  CHECK (transcript_rewrite_status IN ('none', 'ready', 'failed'));
ALTER TABLE video_editions ADD COLUMN transcript_rewrite_error TEXT;
ALTER TABLE video_editions ADD COLUMN transcript_rewrite_model TEXT;
ALTER TABLE video_editions ADD COLUMN transcript_rewritten_at TEXT;

-- Rows stored before this migration: their transcript is the raw AnyMD text.
UPDATE video_editions SET transcript_source = transcript WHERE transcript IS NOT NULL AND transcript_source IS NULL;
