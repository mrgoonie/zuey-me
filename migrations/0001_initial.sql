-- Initial Migration for Zuey.me D1 Database

CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY DEFAULT 'main',
  name TEXT NOT NULL,
  handle TEXT NOT NULL,
  email TEXT NOT NULL,
  avatar_url TEXT NOT NULL,
  intro_en TEXT NOT NULL,
  intro_vi TEXT NOT NULL,
  theme TEXT NOT NULL DEFAULT 'ivory',
  custom_css TEXT,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS links (
  id TEXT PRIMARY KEY,
  section TEXT NOT NULL, -- 'blogs', 'companies', 'products', 'socials'
  title_en TEXT NOT NULL,
  title_vi TEXT NOT NULL,
  subtitle_en TEXT,
  subtitle_vi TEXT,
  url TEXT NOT NULL,
  icon TEXT,
  order_index INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  click_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_used_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS admin_users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  avatar_url TEXT,
  provider TEXT NOT NULL, -- 'github', 'google', 'token'
  provider_id TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_links_section_order ON links (section, order_index);
CREATE INDEX IF NOT EXISTS idx_links_active ON links (is_active);
CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys (key_hash);
