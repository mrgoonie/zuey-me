-- Absolute lifetime of an OAuth grant (src/lib/oauth/tokens.ts). Set when the authorization code is exchanged and
-- copied onto every token a refresh issues; refresh never extends the chain past it, so a rotating or sibling chain
-- cannot slide forward forever. NULL means no cap (rows written before this migration are backfilled below).
ALTER TABLE oauth_tokens ADD COLUMN grant_expires_at TEXT;

-- Existing grants: 90 days after the first token of the family, but never sooner than 30 days from the moment this
-- runs, so currently connected clients get a notice period instead of being cut off the day it is applied.
UPDATE oauth_tokens SET grant_expires_at = (
  SELECT MAX(
    strftime('%Y-%m-%dT%H:%M:%fZ', MIN(f.created_at), '+90 days'),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+30 days')
  ) FROM oauth_tokens f WHERE f.family_id = oauth_tokens.family_id
);
