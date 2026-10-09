-- Courses replace AI Workflows: one-time purchases that unlock a course forever.
-- Course → section → lesson; lessons keep a draft and a published block document like articles.
DROP TABLE IF EXISTS workflow_audit;
DROP TABLE IF EXISTS workflows;

CREATE TABLE IF NOT EXISTS courses (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  subtitle TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  cover_url TEXT,
  locale TEXT NOT NULL DEFAULT 'vi',
  level TEXT NOT NULL DEFAULT 'beginner',
  -- List price in US cents; SePay converts with USD_VND_RATE at checkout time.
  price_usd_cents INTEGER NOT NULL DEFAULT 0,
  -- Per-course override of the subscriber discount table ({"knowledges": 10, ...}); NULL = global table.
  plan_discounts_json TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  -- Shown while lessons are still being released in waves ("Chương 3 ra mắt 11/2026").
  release_note TEXT,
  outcomes_json TEXT NOT NULL DEFAULT '[]',
  -- Private GitHub repositories ("owner/name") owners are invited to as read collaborators.
  github_repos_json TEXT NOT NULL DEFAULT '[]',
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  published_at TEXT,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_courses_public ON courses (deleted_at, status, position);

CREATE TABLE IF NOT EXISTS course_sections (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_course_sections_course ON course_sections (course_id, position);

CREATE TABLE IF NOT EXISTS course_lessons (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL,
  section_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  duration_minutes INTEGER NOT NULL DEFAULT 0,
  -- Trial lessons are readable by everyone; the rest need the course (or admin).
  is_trial INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  draft_json TEXT NOT NULL,
  published_json TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  published_at TEXT,
  UNIQUE (course_id, slug)
);
CREATE INDEX IF NOT EXISTS idx_course_lessons_section ON course_lessons (section_id, position);
CREATE INDEX IF NOT EXISTS idx_course_lessons_course ON course_lessons (course_id, status);

-- Private media referenced by lesson widgets: Cloudflare Stream videos and R2 objects (audio, files).
CREATE TABLE IF NOT EXISTS course_assets (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('video', 'audio', 'file')),
  provider TEXT NOT NULL CHECK (provider IN ('stream', 'r2')),
  ref TEXT NOT NULL,
  name TEXT NOT NULL,
  mime TEXT,
  size_bytes INTEGER,
  duration_seconds INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_course_assets_course ON course_assets (course_id, created_at);

-- Small key/value store for course-wide settings (subscriber discount table, terms version).
CREATE TABLE IF NOT EXISTS course_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- One checkout attempt. Price inputs are snapshotted so later setting changes never alter a paid order.
CREATE TABLE IF NOT EXISTS course_orders (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL CHECK (provider IN ('sepay', 'dodo')),
  user_id TEXT NOT NULL,
  course_id TEXT NOT NULL,
  list_usd_cents INTEGER NOT NULL,
  subscriber_pct INTEGER NOT NULL DEFAULT 0,
  referral_pct INTEGER NOT NULL DEFAULT 0,
  applied_pct INTEGER NOT NULL DEFAULT 0,
  discount_source TEXT NOT NULL DEFAULT 'none' CHECK (discount_source IN ('none', 'subscriber', 'referral')),
  amount_usd_cents INTEGER NOT NULL,
  usd_vnd_rate REAL,
  amount_vnd INTEGER,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'paid', 'expired', 'needs_attention', 'refunded', 'charged_back', 'cancelled')),
  referrer_user_id TEXT,
  -- Referrer commission percent snapshotted at checkout (the referral program pays it on what was collected).
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
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_course_orders_user ON course_orders (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_course_orders_status ON course_orders (status, expires_at);
CREATE INDEX IF NOT EXISTS idx_course_orders_payment ON course_orders (provider_payment_id);

ALTER TABLE payment_events ADD COLUMN course_order_id TEXT;

-- Ownership. Revoked on refund/chargeback/admin action; a later purchase or grant reactivates the row.
CREATE TABLE IF NOT EXISTS course_purchases (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  course_id TEXT NOT NULL,
  order_id TEXT,
  source TEXT NOT NULL CHECK (source IN ('purchase', 'grant')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  revoked_reason TEXT,
  granted_at TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE (user_id, course_id)
);
CREATE INDEX IF NOT EXISTS idx_course_purchases_course ON course_purchases (course_id, status);

CREATE TABLE IF NOT EXISTS lesson_progress (
  user_id TEXT NOT NULL,
  lesson_id TEXT NOT NULL,
  course_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('started', 'completed')),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY (user_id, lesson_id)
);
CREATE INDEX IF NOT EXISTS idx_lesson_progress_course ON lesson_progress (user_id, course_id);

CREATE TABLE IF NOT EXISTS quiz_attempts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  lesson_id TEXT NOT NULL,
  block_id TEXT NOT NULL,
  answers_json TEXT NOT NULL,
  correct INTEGER NOT NULL,
  score INTEGER NOT NULL,
  total INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_quiz_attempts_user ON quiz_attempts (user_id, lesson_id, block_id);

-- Append-only XP ledger; idempotency keys make every award safe to retry. Negative rows will
-- represent future reward redemptions.
CREATE TABLE IF NOT EXISTS xp_ledger (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  delta INTEGER NOT NULL,
  reason TEXT NOT NULL,
  ref TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_xp_ledger_user ON xp_ledger (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_xp_ledger_created ON xp_ledger (created_at);

CREATE TABLE IF NOT EXISTS user_badges (
  user_id TEXT NOT NULL,
  badge TEXT NOT NULL,
  awarded_at TEXT NOT NULL,
  PRIMARY KEY (user_id, badge)
);

CREATE TABLE IF NOT EXISTS learner_profiles (
  user_id TEXT PRIMARY KEY,
  leaderboard_opt_out INTEGER NOT NULL DEFAULT 0,
  current_streak INTEGER NOT NULL DEFAULT 0,
  longest_streak INTEGER NOT NULL DEFAULT 0,
  -- Last learning day in Asia/Ho_Chi_Minh (YYYY-MM-DD).
  last_active_day TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS course_certificates (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  course_id TEXT NOT NULL,
  holder_name TEXT NOT NULL,
  course_title TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE (user_id, course_id)
);

-- GitHub collaborator invitations (and removals) processed by the scheduler with retries.
CREATE TABLE IF NOT EXISTS github_invites (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  course_id TEXT NOT NULL,
  repo TEXT NOT NULL,
  github_login TEXT,
  action TEXT NOT NULL DEFAULT 'invite' CHECK (action IN ('invite', 'remove')),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'done', 'failed', 'skipped')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  next_attempt_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, course_id, repo)
);
CREATE INDEX IF NOT EXISTS idx_github_invites_due ON github_invites (status, next_attempt_at);

-- Anti-abuse: per-day IP/country sightings of signed-in learners, review flags and locks.
CREATE TABLE IF NOT EXISTS account_signals (
  user_id TEXT NOT NULL,
  day TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  country TEXT,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  hits INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, day, ip_hash)
);

CREATE TABLE IF NOT EXISTS account_flags (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'dismissed', 'locked')),
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_account_flags_status ON account_flags (status, created_at);
CREATE INDEX IF NOT EXISTS idx_account_flags_user ON account_flags (user_id, kind, created_at);

CREATE TABLE IF NOT EXISTS course_user_locks (
  user_id TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  locked_at TEXT NOT NULL
);

-- Fixed-window counters for per-user rate limits (lesson reads, media URLs, quiz submissions).
CREATE TABLE IF NOT EXISTS rate_counters (
  key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);
