-- Zuey for Business: self-managed availability, consultation bookings and payment events.
-- All timestamps are UTC ISO-8601 strings produced by Date#toISOString (lexicographically comparable).

CREATE TABLE IF NOT EXISTS availability_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
  slot_minutes INTEGER NOT NULL DEFAULT 90 CHECK (slot_minutes BETWEEN 15 AND 480),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS availability_exceptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (end_at > start_at)
);

CREATE TABLE IF NOT EXISTS bookings (
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
  payment_method TEXT NOT NULL CHECK (payment_method IN ('polar', 'sepay')),
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

-- One active (held or confirmed) booking per slot: the database is the double-booking guard.
CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_active_slot ON bookings (slot_start) WHERE status IN ('held', 'confirmed');
CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings (status, slot_start);

CREATE TABLE IF NOT EXISTS payment_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  event_id TEXT NOT NULL,
  booking_id TEXT,
  amount INTEGER,
  currency TEXT,
  raw_type TEXT,
  received_at TEXT NOT NULL,
  UNIQUE (provider, event_id)
);
