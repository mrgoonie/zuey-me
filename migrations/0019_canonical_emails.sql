-- Canonical mailbox next to each email the referral "has this person ever paid?" check looks at, so it is an
-- indexed equality lookup instead of a scan of every row on the same domain (every Gmail row, for Gmail).
-- Same canonicalization as the referral module (`normalizeEmailForSelfCheck`): lower-cased, `+tag` removed, and
-- for Gmail dots removed and googlemail.com folded into gmail.com. NULL when the stored value is not an email,
-- and on deleted accounts (their email is scrubbed).
-- The application writes the column on every insert/update. Existing rows are filled by
-- `scripts/backfill-canonical-emails.ts`, not here: the canonicalization lives in TypeScript.
ALTER TABLE users ADD COLUMN canonical_email TEXT;
ALTER TABLE card_subscriptions ADD COLUMN canonical_email TEXT;
ALTER TABLE bookings ADD COLUMN canonical_email TEXT;

CREATE INDEX IF NOT EXISTS idx_users_canonical_email ON users (canonical_email) WHERE canonical_email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_card_subscriptions_canonical_email ON card_subscriptions (canonical_email) WHERE canonical_email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bookings_canonical_email ON bookings (canonical_email) WHERE canonical_email IS NOT NULL;
