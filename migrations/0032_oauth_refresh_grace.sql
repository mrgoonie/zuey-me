-- Counts the sibling token pairs issued from a refresh token after it was rotated, inside the short
-- concurrent-refresh grace window (src/lib/oauth/tokens.ts). Caps how often one rotated token can be replayed.
ALTER TABLE oauth_tokens ADD COLUMN grace_uses INTEGER NOT NULL DEFAULT 0;
