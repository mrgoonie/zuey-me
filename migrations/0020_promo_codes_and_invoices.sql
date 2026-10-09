-- Promo codes (percent off, admin-managed) and business invoice requests for SePay payments.
-- All timestamps are UTC ISO-8601 strings produced by Date#toISOString (lexicographically comparable).

-- 1. Promo codes. Codes are stored upper-case and never equal a referral code (checked by the app both ways).
--    `products` / `plans` / `course_ids` are JSON arrays; NULL means "no restriction".
CREATE TABLE IF NOT EXISTS promo_codes (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  percent INTEGER NOT NULL CHECK (percent BETWEEN 1 AND 100),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  label TEXT,
  note TEXT,
  starts_at TEXT,
  ends_at TEXT,
  max_uses INTEGER CHECK (max_uses IS NULL OR max_uses >= 1),
  once_per_customer INTEGER NOT NULL DEFAULT 1 CHECK (once_per_customer IN (0, 1)),
  products TEXT,
  plans TEXT,
  course_ids TEXT,
  min_months INTEGER CHECK (min_months IS NULL OR min_months IN (1, 3, 6, 12)),
  -- Card (Dodo) membership: number of monthly charges the discount covers.
  card_cycles INTEGER NOT NULL DEFAULT 1 CHECK (card_cycles BETWEEN 1 AND 24),
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 2. One row per checkout that used a code. `reserved` holds a use until `expires_at` (the order's own
--    expiry), `redeemed` is final, `released` never counts. Limits are enforced by one conditional INSERT.
CREATE TABLE IF NOT EXISTS promo_redemptions (
  id TEXT PRIMARY KEY,
  promo_code_id TEXT NOT NULL REFERENCES promo_codes (id),
  code TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('billing_order', 'card_subscription', 'booking', 'course_order')),
  source_id TEXT NOT NULL,
  source_code TEXT,
  user_id TEXT,
  email_canonical TEXT,
  percent INTEGER NOT NULL,
  currency TEXT NOT NULL CHECK (currency IN ('VND', 'USD')),
  amount_before INTEGER NOT NULL,
  amount_due INTEGER NOT NULL,
  amount_paid INTEGER,
  status TEXT NOT NULL CHECK (status IN ('reserved', 'redeemed', 'released')),
  expires_at TEXT NOT NULL,
  redeemed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (source_kind, source_id)
);
CREATE INDEX IF NOT EXISTS idx_promo_redemptions_code ON promo_redemptions (promo_code_id, status, expires_at);
CREATE INDEX IF NOT EXISTS idx_promo_redemptions_user ON promo_redemptions (promo_code_id, user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_promo_redemptions_email ON promo_redemptions (promo_code_id, email_canonical) WHERE email_canonical IS NOT NULL;

-- 3. Business invoice requests (tax ID + email) attached to a SePay order. `awaiting_payment` until the
--    order is paid, then `requested` (admins are emailed) until an admin records the issued invoice number.
CREATE TABLE IF NOT EXISTS invoice_requests (
  id TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('billing_order', 'booking', 'course_order')),
  source_id TEXT NOT NULL,
  source_code TEXT NOT NULL,
  user_id TEXT,
  tax_id TEXT NOT NULL,
  email TEXT NOT NULL,
  description TEXT NOT NULL,
  amount_vnd INTEGER NOT NULL,
  amount_paid_vnd INTEGER,
  status TEXT NOT NULL DEFAULT 'awaiting_payment' CHECK (status IN ('awaiting_payment', 'requested', 'issued', 'cancelled')),
  paid_at TEXT,
  invoice_no TEXT,
  issued_at TEXT,
  issued_by TEXT,
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (source_kind, source_id)
);
CREATE INDEX IF NOT EXISTS idx_invoice_requests_status ON invoice_requests (status, paid_at);

-- 4. billing_orders: a 100% promo creates a 0 VND order that is paid at once, so the amount CHECK becomes
--    >= 0. SQLite cannot alter a CHECK constraint, so the table is rebuilt with an explicit column list
--    (no other table references billing_orders by foreign key).
CREATE TABLE billing_orders_promo_rebuild (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users (id),
  plan TEXT NOT NULL CHECK (plan IN ('knowledges', 'ai', 'combo', 'community')),
  months INTEGER NOT NULL CHECK (months IN (1, 3, 6, 12)),
  amount_usd_cents INTEGER NOT NULL,
  usd_vnd_rate REAL NOT NULL,
  amount_vnd INTEGER NOT NULL CHECK (amount_vnd >= 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'expired', 'needs_attention')),
  expires_at TEXT NOT NULL,
  paid_at TEXT,
  amount_paid INTEGER,
  payment_ref TEXT,
  provider_event_id TEXT,
  attention_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  referrer_user_id TEXT,
  referral_rate INTEGER,
  referral_discount_percent INTEGER,
  referral_commission_percent INTEGER,
  amount_before_referral INTEGER,
  referral_ref TEXT,
  promo_code_id TEXT,
  promo_code TEXT,
  promo_discount_percent INTEGER
);

INSERT INTO billing_orders_promo_rebuild (
  id, code, user_id, plan, months, amount_usd_cents, usd_vnd_rate, amount_vnd, status, expires_at, paid_at, amount_paid,
  payment_ref, provider_event_id, attention_reason, created_at, updated_at, referrer_user_id, referral_rate,
  referral_discount_percent, referral_commission_percent, amount_before_referral, referral_ref
)
SELECT
  id, code, user_id, plan, months, amount_usd_cents, usd_vnd_rate, amount_vnd, status, expires_at, paid_at, amount_paid,
  payment_ref, provider_event_id, attention_reason, created_at, updated_at, referrer_user_id, referral_rate,
  referral_discount_percent, referral_commission_percent, amount_before_referral, referral_ref
FROM billing_orders;

DROP TABLE billing_orders;
ALTER TABLE billing_orders_promo_rebuild RENAME TO billing_orders;

CREATE INDEX IF NOT EXISTS idx_billing_orders_user ON billing_orders (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_billing_orders_status ON billing_orders (status, expires_at);
CREATE INDEX IF NOT EXISTS idx_billing_orders_paid ON billing_orders (user_id, plan, paid_at) WHERE status = 'paid';

-- 5. course_orders: discount_source gains 'promo' (same rebuild; nothing references course_orders by FK).
CREATE TABLE course_orders_promo_rebuild (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL CHECK (provider IN ('sepay', 'dodo')),
  user_id TEXT NOT NULL,
  course_id TEXT NOT NULL,
  list_usd_cents INTEGER NOT NULL,
  subscriber_pct INTEGER NOT NULL DEFAULT 0,
  referral_pct INTEGER NOT NULL DEFAULT 0,
  applied_pct INTEGER NOT NULL DEFAULT 0,
  discount_source TEXT NOT NULL DEFAULT 'none' CHECK (discount_source IN ('none', 'subscriber', 'referral', 'promo')),
  amount_usd_cents INTEGER NOT NULL,
  usd_vnd_rate REAL,
  amount_vnd INTEGER,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'paid', 'expired', 'needs_attention', 'refunded', 'charged_back', 'cancelled')),
  referrer_user_id TEXT,
  referral_commission_percent INTEGER,
  referral_code TEXT,
  terms_version TEXT NOT NULL,
  terms_accepted_at TEXT NOT NULL,
  ip_hash TEXT,
  country TEXT,
  provider_session_id TEXT,
  provider_payment_id TEXT,
  amount_paid INTEGER,
  currency_paid TEXT,
  payment_ref TEXT,
  provider_event_id TEXT,
  attention_reason TEXT,
  expires_at TEXT NOT NULL,
  paid_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  promo_code_id TEXT,
  promo_code TEXT,
  promo_pct INTEGER NOT NULL DEFAULT 0
);

INSERT INTO course_orders_promo_rebuild (
  id, code, provider, user_id, course_id, list_usd_cents, subscriber_pct, referral_pct, applied_pct, discount_source,
  amount_usd_cents, usd_vnd_rate, amount_vnd, status, referrer_user_id, referral_commission_percent, referral_code,
  terms_version, terms_accepted_at, ip_hash, country, provider_session_id, provider_payment_id, amount_paid, currency_paid,
  payment_ref, provider_event_id, attention_reason, expires_at, paid_at, created_at, updated_at
)
SELECT
  id, code, provider, user_id, course_id, list_usd_cents, subscriber_pct, referral_pct, applied_pct, discount_source,
  amount_usd_cents, usd_vnd_rate, amount_vnd, status, referrer_user_id, referral_commission_percent, referral_code,
  terms_version, terms_accepted_at, ip_hash, country, provider_session_id, provider_payment_id, amount_paid, currency_paid,
  payment_ref, provider_event_id, attention_reason, expires_at, paid_at, created_at, updated_at
FROM course_orders;

DROP TABLE course_orders;
ALTER TABLE course_orders_promo_rebuild RENAME TO course_orders;

CREATE INDEX IF NOT EXISTS idx_course_orders_user ON course_orders (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_course_orders_status ON course_orders (status, expires_at);
CREATE INDEX IF NOT EXISTS idx_course_orders_payment ON course_orders (provider_payment_id);

-- 6. Promo snapshot on the other checkouts.
ALTER TABLE card_subscriptions ADD COLUMN promo_code_id TEXT;
ALTER TABLE card_subscriptions ADD COLUMN promo_code TEXT;
ALTER TABLE card_subscriptions ADD COLUMN promo_discount_percent INTEGER;
ALTER TABLE card_subscriptions ADD COLUMN promo_cycles INTEGER;

ALTER TABLE bookings ADD COLUMN promo_code_id TEXT;
ALTER TABLE bookings ADD COLUMN promo_code TEXT;
ALTER TABLE bookings ADD COLUMN promo_discount_percent INTEGER;
