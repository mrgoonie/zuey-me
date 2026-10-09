-- Referral program: referrer profiles, tiered rates, referral snapshots on every paid rail, commissions,
-- an append-only USD-cent ledger, payout profiles and monthly payout batches.
-- Remote-safe: only CREATE TABLE / ALTER TABLE ADD COLUMN / CREATE INDEX / INSERT OR IGNORE (no data rewrite).
-- All timestamps are UTC ISO-8601 strings produced by Date#toISOString (lexicographically comparable).

-- 1. Program settings (single row 'default', admin-editable). Rates are whole percent, deductions basis points.
CREATE TABLE IF NOT EXISTS referral_settings (
  id TEXT PRIMARY KEY CHECK (id = 'default'),
  tiers_json TEXT NOT NULL,
  hold_days INTEGER NOT NULL DEFAULT 30,
  booking_rate INTEGER NOT NULL DEFAULT 10,
  payout_threshold_cents INTEGER NOT NULL DEFAULT 5000,
  vn_deduction_bp INTEGER NOT NULL DEFAULT 1000,
  paypal_deduction_bp INTEGER NOT NULL DEFAULT 1800,
  cookie_days INTEGER NOT NULL DEFAULT 30,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO referral_settings (id, tiers_json, hold_days, booking_rate, payout_threshold_cents, vn_deduction_bp, paypal_deduction_bp, cookie_days, updated_at)
VALUES (
  'default',
  '[{"min":0,"rate":20},{"min":3,"rate":25},{"min":10,"rate":30},{"min":25,"rate":40},{"min":50,"rate":50}]',
  30, 10, 5000, 1000, 1800, 30, '2026-10-09T00:00:00.000Z'
);

-- 2. One referral link + one discount per referrer. tier_* columns are refreshed by the daily job.
CREATE TABLE IF NOT EXISTS referral_profiles (
  user_id TEXT PRIMARY KEY REFERENCES users (id),
  code TEXT NOT NULL UNIQUE CHECK (length(code) BETWEEN 6 AND 16 AND code = lower(code)),
  discount_percent INTEGER NOT NULL DEFAULT 0 CHECK (discount_percent BETWEEN 0 AND 50),
  admin_rate_override INTEGER CHECK (admin_rate_override IS NULL OR admin_rate_override BETWEEN 0 AND 50),
  admin_enabled INTEGER NOT NULL DEFAULT 0 CHECK (admin_enabled IN (0, 1)),
  locked_at TEXT,
  lock_reason TEXT,
  leaderboard_opt_out INTEGER NOT NULL DEFAULT 0 CHECK (leaderboard_opt_out IN (0, 1)),
  tier_rate INTEGER NOT NULL DEFAULT 20,
  tier_count_90d INTEGER NOT NULL DEFAULT 0,
  tier_updated_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 3. Permanent attribution, bound when the member account is created (or by checkout code entry).
ALTER TABLE users ADD COLUMN referred_by_user_id TEXT;
ALTER TABLE users ADD COLUMN referred_at TEXT;
ALTER TABLE users ADD COLUMN referral_signup_ip_hash TEXT;
CREATE INDEX IF NOT EXISTS idx_users_referred_by ON users (referred_by_user_id, referred_at);

-- 4. Referral terms snapshotted on each order so later rate changes never alter it.
--    amount_before_referral is in minor units of that row's currency; referral_ref is the provider discount id/code.
ALTER TABLE billing_orders ADD COLUMN referrer_user_id TEXT;
ALTER TABLE billing_orders ADD COLUMN referral_rate INTEGER;
ALTER TABLE billing_orders ADD COLUMN referral_discount_percent INTEGER;
ALTER TABLE billing_orders ADD COLUMN referral_commission_percent INTEGER;
ALTER TABLE billing_orders ADD COLUMN amount_before_referral INTEGER;
ALTER TABLE billing_orders ADD COLUMN referral_ref TEXT;

ALTER TABLE card_subscriptions ADD COLUMN referrer_user_id TEXT;
ALTER TABLE card_subscriptions ADD COLUMN referral_rate INTEGER;
ALTER TABLE card_subscriptions ADD COLUMN referral_discount_percent INTEGER;
ALTER TABLE card_subscriptions ADD COLUMN referral_commission_percent INTEGER;
ALTER TABLE card_subscriptions ADD COLUMN amount_before_referral INTEGER;
ALTER TABLE card_subscriptions ADD COLUMN referral_ref TEXT;
ALTER TABLE card_subscriptions ADD COLUMN first_payment_id TEXT;
-- First successful charge as reported by Dodo (total incl. tax, and the tax part), so a commission whose capture
-- failed can be recaptured later from stored facts.
ALTER TABLE card_subscriptions ADD COLUMN first_payment_cents INTEGER;
ALTER TABLE card_subscriptions ADD COLUMN first_payment_tax_cents INTEGER;
ALTER TABLE card_subscriptions ADD COLUMN first_payment_at TEXT;
CREATE INDEX IF NOT EXISTS idx_card_subscriptions_first_payment ON card_subscriptions (first_payment_id) WHERE first_payment_id IS NOT NULL;

ALTER TABLE bookings ADD COLUMN referrer_user_id TEXT;
ALTER TABLE bookings ADD COLUMN referral_rate INTEGER;
ALTER TABLE bookings ADD COLUMN referral_discount_percent INTEGER;
ALTER TABLE bookings ADD COLUMN referral_commission_percent INTEGER;
ALTER TABLE bookings ADD COLUMN amount_before_referral INTEGER;
ALTER TABLE bookings ADD COLUMN referral_ref TEXT;
-- VND per USD at hold time: a VND booking's commission converts at this rate, not at the rate on payment day.
ALTER TABLE bookings ADD COLUMN usd_vnd_rate REAL;

-- Hashed client IP of each member sign-in, compared with a referee's signup IP (OAuth logins leave no login_tokens).
ALTER TABLE member_sessions ADD COLUMN ip_hash TEXT;

-- 5. One commission per referred source order; the unique key makes webhook retries idempotent.
CREATE TABLE IF NOT EXISTS referral_commissions (
  id TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('billing_order', 'card_subscription', 'booking')),
  source_id TEXT NOT NULL,
  referrer_user_id TEXT NOT NULL REFERENCES users (id),
  referee_user_id TEXT REFERENCES users (id),
  referee_email TEXT,
  base_amount_cents INTEGER NOT NULL CHECK (base_amount_cents >= 0),
  commission_percent INTEGER NOT NULL CHECK (commission_percent BETWEEN 0 AND 50),
  commission_cents INTEGER NOT NULL CHECK (commission_cents >= 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'review', 'approved', 'reversed', 'blocked')),
  review_reasons TEXT,
  hold_until TEXT NOT NULL,
  provider_payment_id TEXT,
  paid_at TEXT,
  approved_at TEXT,
  reversed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (source_kind, source_id)
);
CREATE INDEX IF NOT EXISTS idx_referral_commissions_referrer ON referral_commissions (referrer_user_id, status);
CREATE INDEX IF NOT EXISTS idx_referral_commissions_hold ON referral_commissions (status, hold_until);
CREATE INDEX IF NOT EXISTS idx_referral_commissions_paid ON referral_commissions (paid_at);

-- 6. Append-only ledger in signed USD cents. A referrer's balance is the sum of their lines.
CREATE TABLE IF NOT EXISTS referral_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  referrer_user_id TEXT NOT NULL REFERENCES users (id),
  kind TEXT NOT NULL CHECK (kind IN ('commission', 'reversal', 'payout', 'adjustment')),
  amount_cents INTEGER NOT NULL,
  commission_id TEXT,
  payout_id TEXT,
  note TEXT,
  created_at TEXT NOT NULL
);
-- Guards against double credit or double reversal of one commission.
CREATE UNIQUE INDEX IF NOT EXISTS idx_referral_ledger_commission ON referral_ledger (kind, commission_id) WHERE commission_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_referral_ledger_referrer ON referral_ledger (referrer_user_id, id);

-- 7. Where and how a referrer is paid. National-ID images live in private R2 until admin approval.
CREATE TABLE IF NOT EXISTS referral_payout_profiles (
  user_id TEXT PRIMARY KEY REFERENCES users (id),
  method TEXT NOT NULL CHECK (method IN ('vn_bank', 'paypal')),
  full_name TEXT,
  bank_name TEXT,
  bank_account TEXT,
  national_id TEXT,
  address TEXT,
  paypal_email TEXT,
  status TEXT NOT NULL CHECK (status IN ('draft', 'submitted', 'verified', 'rejected')),
  id_front_key TEXT,
  id_back_key TEXT,
  verified_at TEXT,
  verified_by TEXT,
  reject_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 8. Monthly payout batches (one per referrer and period), paid manually by an admin.
CREATE TABLE IF NOT EXISTS referral_payouts (
  id TEXT PRIMARY KEY,
  referrer_user_id TEXT NOT NULL REFERENCES users (id),
  period TEXT NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('vn_bank', 'paypal')),
  gross_cents INTEGER NOT NULL,
  deduction_bp INTEGER NOT NULL,
  deduction_cents INTEGER NOT NULL,
  net_cents INTEGER NOT NULL,
  usd_vnd_rate REAL,
  net_vnd INTEGER,
  status TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'cancelled')),
  -- Payee snapshotted from the verified payout profile at close: later profile edits never redirect this payout.
  payee_full_name TEXT,
  payee_bank_name TEXT,
  payee_bank_account TEXT,
  payee_national_id TEXT,
  payee_address TEXT,
  payee_paypal_email TEXT,
  payee_verified_at TEXT,
  transaction_ref TEXT,
  paid_at TEXT,
  paid_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (referrer_user_id, period)
);
CREATE INDEX IF NOT EXISTS idx_referral_payouts_status ON referral_payouts (status, period);

-- 9. Audit trail of referral state changes and admin actions.
CREATE TABLE IF NOT EXISTS referral_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  subject_user_id TEXT,
  detail TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_referral_events_subject ON referral_events (subject_user_id, id);

-- 10. Canonical-email hashes of deleted accounts that had paid, so deleting and re-registering never makes a
--     previous customer an eligible (discounted, commissionable) referee again.
CREATE TABLE IF NOT EXISTS referral_paid_email_hashes (
  email_hash TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

-- 11. Sources refunded or cancelled before any commission existed (e.g. capture had failed), so a later
--     recapture never creates a commission for money that was given back.
CREATE TABLE IF NOT EXISTS referral_source_reversals (
  source_kind TEXT NOT NULL CHECK (source_kind IN ('billing_order', 'card_subscription', 'booking')),
  source_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (source_kind, source_id)
);
