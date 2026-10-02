-- Card payment rails: PayPal Orders for the consultation booking, Dodo Payments subscriptions for memberships.
-- All timestamps are UTC ISO-8601 strings produced by Date#toISOString (lexicographically comparable).

-- 1. Bookings accept payment_method 'paypal'. SQLite cannot alter a CHECK constraint, so the table is
--    rebuilt with an explicit column list (no other table references bookings by foreign key).
--    The retired 'polar' rail stays legal only so historical rows copy over; the app never writes it.
CREATE TABLE bookings_card_rebuild (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  slot_start TEXT NOT NULL,
  slot_end TEXT NOT NULL,
  duration_min INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('held', 'confirmed', 'expired', 'cancelled', 'needs_attention')),
  hold_expires_at TEXT NOT NULL,
  guest_name TEXT NOT NULL,
  guest_email TEXT NOT NULL,
  company TEXT,
  notes TEXT,
  guest_timezone TEXT,
  payment_method TEXT NOT NULL CHECK (payment_method IN ('polar', 'sepay', 'paypal')),
  amount_expected INTEGER,
  currency TEXT,
  amount_paid INTEGER,
  payment_ref TEXT,
  manage_token_hash TEXT NOT NULL,
  reschedule_count INTEGER NOT NULL DEFAULT 0,
  meet_url TEXT,
  calendar_event_id TEXT,
  meet_status TEXT,
  meet_error TEXT,
  email_status TEXT,
  email_error TEXT,
  attention_reason TEXT,
  admin_note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO bookings_card_rebuild (
  id, code, slot_start, slot_end, duration_min, status, hold_expires_at, guest_name, guest_email, company, notes,
  guest_timezone, payment_method, amount_expected, currency, amount_paid, payment_ref, manage_token_hash,
  reschedule_count, meet_url, calendar_event_id, meet_status, meet_error, email_status, email_error,
  attention_reason, admin_note, created_at, updated_at
)
SELECT
  id, code, slot_start, slot_end, duration_min, status, hold_expires_at, guest_name, guest_email, company, notes,
  guest_timezone, payment_method, amount_expected, currency, amount_paid, payment_ref, manage_token_hash,
  reschedule_count, meet_url, calendar_event_id, meet_status, meet_error, email_status, email_error,
  attention_reason, admin_note, created_at, updated_at
FROM bookings;

DROP TABLE bookings;
ALTER TABLE bookings_card_rebuild RENAME TO bookings;

-- One active (held or confirmed) booking per slot: the database is the double-booking guard.
CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_active_slot ON bookings (slot_start) WHERE status IN ('held', 'confirmed');
CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings (status, slot_start);
-- PayPal order ids are looked up when a capture arrives.
CREATE INDEX IF NOT EXISTS idx_bookings_payment_ref ON bookings (payment_ref);

-- 2. Card (Dodo Payments) membership subscriptions. A row is created as 'pending' when the member starts
--    checkout and is then driven only by verified webhooks. user_id/plan are NULL only for webhook
--    events that could not be matched to a member (status 'needs_attention', for the admin).
CREATE TABLE IF NOT EXISTS card_subscriptions (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('dodo')),
  provider_subscription_id TEXT,
  provider_customer_id TEXT,
  provider_session_id TEXT,
  user_id TEXT REFERENCES users (id),
  plan TEXT CHECK (plan IS NULL OR plan IN ('knowledges', 'ai', 'combo', 'community')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'on_hold', 'paused', 'cancelled', 'failed', 'expired', 'needs_attention')),
  current_period_end TEXT,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  amount_cents INTEGER,
  currency TEXT,
  customer_email TEXT,
  attention_reason TEXT,
  last_event_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_card_subscriptions_provider_id
  ON card_subscriptions (provider, provider_subscription_id) WHERE provider_subscription_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_card_subscriptions_user ON card_subscriptions (user_id, plan, status);

-- Payment events are shared by every rail; card subscription events reference their subscription row.
ALTER TABLE payment_events ADD COLUMN card_subscription_id TEXT;
