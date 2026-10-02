-- Zuey's Knowledges: locale editions, revision history, categories, public topic tags,
-- typed evidence labels with an admin-reviewed AI proposal lifecycle, and full-text search.
--
-- Forward-only and additive: the legacy `articles` columns stay and keep mirroring the
-- primary-locale edition, so the previous application build still reads valid data
-- (rollback = redeploy the previous build; the new tables are simply ignored).

-- ---------- Article-level metadata ----------

ALTER TABLE articles ADD COLUMN category_id TEXT;
-- Revision of the evidence label set (independent of content revisions).
ALTER TABLE articles ADD COLUMN label_revision INTEGER NOT NULL DEFAULT 0;

-- ---------- Locale editions ----------
-- One row per (article, locale). Content revisions share the article-wide `articles.revision`
-- counter; `revision` records the article revision at which this edition last changed.
CREATE TABLE IF NOT EXISTS article_editions (
  id TEXT PRIMARY KEY,
  article_id TEXT NOT NULL,
  locale TEXT NOT NULL CHECK (locale IN ('en', 'vi', 'zh', 'ko', 'ja')),
  title TEXT NOT NULL,
  excerpt TEXT NOT NULL DEFAULT '',
  draft_json TEXT NOT NULL,
  published_json TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  published_revision INTEGER,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  -- Derived at publish time from the published document (safe public metadata only).
  published_words INTEGER NOT NULL DEFAULT 0,
  cover_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  published_at TEXT,
  deleted_at TEXT,
  UNIQUE (article_id, locale)
);

CREATE INDEX IF NOT EXISTS idx_article_editions_public ON article_editions (deleted_at, published_at);

-- Backfill: every existing article becomes an edition in its current locale.
INSERT OR IGNORE INTO article_editions (
  id, article_id, locale, title, excerpt, draft_json, published_json, revision, published_revision, status,
  created_at, updated_at, published_at, deleted_at
)
SELECT
  'ed_' || lower(hex(randomblob(8))), id,
  CASE WHEN locale IN ('en', 'vi', 'zh', 'ko', 'ja') THEN locale ELSE 'vi' END,
  title, excerpt, draft_json, published_json, revision,
  CASE WHEN published_json IS NOT NULL THEN revision ELSE NULL END,
  CASE WHEN published_json IS NOT NULL THEN 'published' ELSE 'draft' END,
  created_at, updated_at, published_at, deleted_at
FROM articles;

-- ---------- Revision history ----------
CREATE TABLE IF NOT EXISTS article_revisions (
  id TEXT PRIMARY KEY,
  article_id TEXT NOT NULL,
  locale TEXT NOT NULL,
  revision INTEGER NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('import', 'create', 'save', 'publish', 'unpublish', 'delete_edition', 'restore')),
  title TEXT NOT NULL,
  excerpt TEXT NOT NULL DEFAULT '',
  document_json TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_article_revisions_article ON article_revisions (article_id, locale, revision);

INSERT INTO article_revisions (id, article_id, locale, revision, action, title, excerpt, document_json, actor, created_at)
SELECT 'rev_' || lower(hex(randomblob(8))), e.article_id, e.locale, e.revision, 'import', e.title, e.excerpt, e.draft_json, 'migration', e.updated_at
FROM article_editions e;

-- ---------- Categories ----------
CREATE TABLE IF NOT EXISTS knowledge_categories (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  -- {"en": "AI", "vi": "AI", ...}
  names TEXT NOT NULL DEFAULT '{}',
  position INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

-- ---------- Public topic tags (independent of evidence labels) ----------
CREATE TABLE IF NOT EXISTS topic_tags (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  names TEXT NOT NULL DEFAULT '{}',
  aliases TEXT NOT NULL DEFAULT '[]',
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS article_tags (
  article_id TEXT NOT NULL,
  tag_id TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY (article_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_article_tags_tag ON article_tags (tag_id);

-- Backfill legacy free-text tags (JSON array on articles.tags) into stable topic tags.
INSERT OR IGNORE INTO topic_tags (id, slug, names, aliases, revision, created_at, updated_at)
SELECT 'tag_' || lower(hex(randomblob(8))), slug, json_object(locale, name), '[]', 1, now, now
FROM (
  SELECT lower(replace(trim(j.value), ' ', '-')) AS slug, trim(j.value) AS name,
    CASE WHEN a.locale IN ('en', 'vi', 'zh', 'ko', 'ja') THEN a.locale ELSE 'vi' END AS locale,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now
  FROM articles a, json_each(CASE WHEN json_valid(a.tags) THEN a.tags ELSE '[]' END) j
  WHERE j.type = 'text' AND trim(j.value) <> ''
  GROUP BY lower(replace(trim(j.value), ' ', '-'))
);

INSERT OR IGNORE INTO article_tags (article_id, tag_id, position, created_at)
SELECT a.id, t.id, j.key, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM articles a, json_each(CASE WHEN json_valid(a.tags) THEN a.tags ELSE '[]' END) j
JOIN topic_tags t ON t.slug = lower(replace(trim(j.value), ' ', '-'))
WHERE j.type = 'text' AND trim(j.value) <> '';

-- ---------- Typed evidence labels ----------
-- kind: claim (fact/opinion/experience/hypothesis), freshness (current/needs-review/outdated),
-- domain, tool, model (with version), workflow, mindset, extension (admin-approved).
CREATE TABLE IF NOT EXISTS taxonomy_labels (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('claim', 'freshness', 'domain', 'tool', 'model', 'workflow', 'mindset', 'extension')),
  slug TEXT NOT NULL,
  names TEXT NOT NULL DEFAULT '{}',
  aliases TEXT NOT NULL DEFAULT '[]',
  description TEXT NOT NULL DEFAULT '',
  version TEXT,
  builtin INTEGER NOT NULL DEFAULT 0,
  approved_at TEXT,
  approved_by TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE (kind, slug)
);

-- Built-in vocabulary required by the label contract (not content).
INSERT OR IGNORE INTO taxonomy_labels (id, kind, slug, names, builtin, approved_at, approved_by, created_at, updated_at) VALUES
  ('lbl_claim_fact', 'claim', 'fact', '{"en":"Fact","vi":"Fact · khẳng định có nguồn","zh":"事实","ko":"사실","ja":"事実"}', 1, '2026-10-02T00:00:00.000Z', 'system', '2026-10-02T00:00:00.000Z', '2026-10-02T00:00:00.000Z'),
  ('lbl_claim_opinion', 'claim', 'opinion', '{"en":"Opinion","vi":"Quan điểm","zh":"观点","ko":"의견","ja":"意見"}', 1, '2026-10-02T00:00:00.000Z', 'system', '2026-10-02T00:00:00.000Z', '2026-10-02T00:00:00.000Z'),
  ('lbl_claim_experience', 'claim', 'experience', '{"en":"Experience","vi":"Kinh nghiệm","zh":"经验","ko":"경험","ja":"経験"}', 1, '2026-10-02T00:00:00.000Z', 'system', '2026-10-02T00:00:00.000Z', '2026-10-02T00:00:00.000Z'),
  ('lbl_claim_hypothesis', 'claim', 'hypothesis', '{"en":"Hypothesis","vi":"Giả thuyết","zh":"假设","ko":"가설","ja":"仮説"}', 1, '2026-10-02T00:00:00.000Z', 'system', '2026-10-02T00:00:00.000Z', '2026-10-02T00:00:00.000Z'),
  ('lbl_fresh_current', 'freshness', 'current', '{"en":"Current","vi":"Còn phù hợp","zh":"仍适用","ko":"최신","ja":"最新"}', 1, '2026-10-02T00:00:00.000Z', 'system', '2026-10-02T00:00:00.000Z', '2026-10-02T00:00:00.000Z'),
  ('lbl_fresh_needs_review', 'freshness', 'needs-review', '{"en":"Needs review","vi":"Cần kiểm tra lại","zh":"待复核","ko":"검토 필요","ja":"要確認"}', 1, '2026-10-02T00:00:00.000Z', 'system', '2026-10-02T00:00:00.000Z', '2026-10-02T00:00:00.000Z'),
  ('lbl_fresh_outdated', 'freshness', 'outdated', '{"en":"Outdated","vi":"Outdated · cần cập nhật","zh":"已过时","ko":"오래됨","ja":"古い情報"}', 1, '2026-10-02T00:00:00.000Z', 'system', '2026-10-02T00:00:00.000Z', '2026-10-02T00:00:00.000Z');

-- Every applied label set is kept, so a revert is a new revision that copies an older set.
CREATE TABLE IF NOT EXISTS article_label_sets (
  id TEXT PRIMARY KEY,
  article_id TEXT NOT NULL,
  label_revision INTEGER NOT NULL,
  assignments TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL CHECK (source IN ('manual', 'proposal', 'revert')),
  proposal_id TEXT,
  actor TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE (article_id, label_revision)
);

-- Materialised current assignments (rebuilt on every applied set) for filtering.
-- scope: article | locale | revision | block. evidence: {source_url, source_title, retrieved_at,
-- as_of, review_date, version_applicability, claim, note} — admin-only, never public.
CREATE TABLE IF NOT EXISTS article_labels (
  id TEXT PRIMARY KEY,
  article_id TEXT NOT NULL,
  label_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('article', 'locale', 'revision', 'block')),
  locale TEXT,
  edition_revision INTEGER,
  block_id TEXT,
  evidence TEXT NOT NULL DEFAULT '{}',
  label_revision INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_article_labels_article ON article_labels (article_id);
CREATE INDEX IF NOT EXISTS idx_article_labels_label ON article_labels (label_id, locale);

-- ---------- AI audit jobs and label proposals ----------
CREATE TABLE IF NOT EXISTS taxonomy_audit_jobs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'paused', 'completed', 'failed', 'cancelled')),
  -- {"locales": [...], "article_ids": [...], "skip_unchanged": true}
  scope TEXT NOT NULL DEFAULT '{}',
  -- Last processed "<article_id>|<locale>" key in stable order; resume continues after it.
  cursor TEXT NOT NULL DEFAULT '',
  batch_size INTEGER NOT NULL DEFAULT 5,
  processed INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  proposal_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  model TEXT NOT NULL DEFAULT '',
  snapshot_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS taxonomy_label_proposals (
  id TEXT PRIMARY KEY,
  job_id TEXT,
  article_id TEXT NOT NULL,
  locale TEXT NOT NULL,
  edition_revision INTEGER NOT NULL,
  base_label_revision INTEGER NOT NULL,
  before_json TEXT NOT NULL DEFAULT '[]',
  proposed_json TEXT NOT NULL DEFAULT '[]',
  questions TEXT NOT NULL DEFAULT '[]',
  rationale TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'deferred', 'applied', 'rejected', 'stale')),
  decided_by TEXT,
  decided_at TEXT,
  decision_reason TEXT,
  applied_label_revision INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_label_proposals_status ON taxonomy_label_proposals (status, article_id);
CREATE INDEX IF NOT EXISTS idx_label_proposals_job ON taxonomy_label_proposals (job_id);

CREATE TABLE IF NOT EXISTS taxonomy_audit_log (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_taxonomy_audit_log_target ON taxonomy_audit_log (target_type, target_id, created_at);

-- ---------- Full-text search ----------
-- One row per published edition and access tier:
--   free    — full text of a free article (visible to everyone)
--   preview — public preview (about the first third) of a paid article
--   full    — full text of a paid article (only for principals with read_full)
-- Paid full text and its public preview live in separate rows, so the tier filter applied in the
-- same query as MATCH decides what can be ranked or quoted before any snippet is produced.
-- CJK text is indexed with a space between ideographs so unicode61 can match any substring as a phrase.
CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
  article_id UNINDEXED,
  locale UNINDEXED,
  tier UNINDEXED,
  title,
  tags,
  body,
  tokenize = 'unicode61 remove_diacritics 2'
);
