-- The provider's dispute id on a payment event, so a dispute's outcome is matched to its own `dispute.opened` instead of
-- being counted against every dispute of the order: a stray won or cancelled (a re-sent outcome under a new event id, or
-- both outcomes of one dispute) no longer hides the next genuine dispute. Rows written before this migration, and
-- events whose payload carries no dispute id, keep it NULL and are paired by count as before. Forward-only and additive.
--
-- DEPLOY ORDER (production): apply before deploying the code, whose event insert names the column. Record a restore
-- point first with `wrangler d1 time-travel info zuey_me_db`, then
-- `wrangler d1 execute zuey_me_db --remote --file=./migrations/0035_payment_events_dispute_id.sql -y`.
--
-- ROLLBACK: DROP INDEX idx_payment_events_dispute; ALTER TABLE payment_events DROP COLUMN dispute_id; together with
-- reverting the code.
ALTER TABLE payment_events ADD COLUMN dispute_id TEXT;
CREATE INDEX IF NOT EXISTS idx_payment_events_dispute ON payment_events (course_order_id, dispute_id) WHERE dispute_id IS NOT NULL;
